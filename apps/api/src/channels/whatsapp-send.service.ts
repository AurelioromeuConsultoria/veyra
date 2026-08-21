import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CryptoService } from '../common/crypto.service';
import type { ClaimedEvent } from '../outbox/outbox.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { classifyFailure } from './meta-errors';
import { META_TRANSPORT, type MetaTransport } from './meta.transport';
import { decideSend, type SendDecision } from './send-policy';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

export interface OutboundRequest {
  conversationId: string;
  body: string;
  template?: { name: string; language: string; params: string[] };
  actorMembershipId: string | null;
}

/**
 * Envio pelo canal externo (ADR-039). A ordem importa e é esta:
 *
 *   valida política → RESERVA quota → cria Message → cria Dispatch(reserved)
 *   → enfileira evento interno → [worker] revalida política → chama provedor
 *   → liquida/libera conforme o resultado
 *
 * A revalidação no worker não é redundância: entre criar a mensagem e o outbox
 * entregá-la, a janela de atendimento pode fechar e o consentimento pode ser
 * revogado. Enviar com base numa decisão velha violaria a política da
 * plataforma justamente no caso que ela existe para impedir.
 */
@Injectable()
export class WhatsappSendService {
  private readonly logger = new Logger(WhatsappSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
    private readonly cls: ClsService,
    @Inject(META_TRANSPORT) private readonly transport: MetaTransport,
  ) {}

  /** Chamado pelo caminho HTTP (atendente). Roda com CLS da request. */
  async enqueueOutbound(
    workspaceId: string,
    input: OutboundRequest,
  ): Promise<{ messageId: string }> {
    const conversation = await this.loadConversation(input.conversationId);
    const decision = await this.evaluate(workspaceId, conversation, input.template);
    if (!decision.allowed) throw new BadRequestException(this.explain(decision.reason));

    await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
    const reservation = await this.usage.reserve(workspaceId, 'messages_sent', 1);
    if (reservation === 'quota_exceeded') {
      throw new BadRequestException('Limite de mensagens do plano atingido');
    }

    try {
      const db = this.prisma.db as unknown as TxRunner;
      return await db.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            channelId: conversation.channelId,
            direction: 'outbound',
            authorType: input.actorMembershipId ? 'user' : 'system',
            authorMembershipId: input.actorMembershipId,
            body: input.body,
          },
        } as never);
        const messageId = (message as unknown as { id: string }).id;

        await tx.messageDispatch.create({
          data: {
            messageId,
            state: 'reserved',
            reservationId: reservation.reservationId,
            // guardado para o worker REVALIDAR o mesmo envio que foi pedido
            templateName: input.template?.name ?? null,
            templateLanguage: input.template?.language ?? null,
            templateParams: input.template ? (input.template.params as object) : undefined,
          },
        } as never);
        await tx.conversation.updateMany({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() },
        });
        await this.outbox.enqueue(
          tx,
          workspaceId,
          'whatsapp.send_pending',
          { messageId },
          `whatsapp.send_pending:${messageId}`,
        );
        return { messageId };
      });
    } catch (error) {
      // a mensagem não foi criada: a reserva não pode ficar pendurada
      await this.usage.release(reservation.reservationId);
      throw error;
    }
  }

  /**
   * Handler do evento interno, chamado pelo dispatcher. Entra no contexto do
   * workspace do evento para usar o client protegido e a reserva de quota.
   */
  async dispatch(event: ClaimedEvent): Promise<'done' | 'retry'> {
    const { messageId } = event.payload as { messageId: string };
    return this.cls.run(async () => {
      this.cls.set('workspaceId', event.workspaceId);
      return this.deliver(event.workspaceId, messageId);
    });
  }

  private async deliver(workspaceId: string, messageId: string): Promise<'done' | 'retry'> {
    const dispatch = (await this.prisma.db.messageDispatch.findFirst({
      where: { messageId },
    })) as unknown as {
      state: string;
      reservationId: string | null;
      templateName: string | null;
      templateLanguage: string | null;
      templateParams: unknown;
    } | null;
    // IDEMPOTÊNCIA do worker: só `reserved` é enviável. Reentrega do evento —
    // ou lease expirado — encontra outro estado e não reenvia.
    if (!dispatch || dispatch.state !== 'reserved') return 'done';

    const message = (await this.prisma.db.message.findFirst({
      where: { id: messageId },
      select: { body: true, conversationId: true },
    })) as unknown as { body: string; conversationId: string } | null;
    if (!message) return 'done';

    const conversation = await this.loadConversation(message.conversationId);
    const credential = (await this.prisma.db.channelCredential.findFirst({
      where: { channelId: conversation.channelId },
    })) as unknown as { phoneNumberId: string; tokenCipher: string } | null;
    if (!credential) {
      await this.settleFailure(
        workspaceId,
        messageId,
        dispatch.reservationId,
        'permanent',
        'no_credential',
      );
      return 'done';
    }

    // REVALIDAÇÃO imediatamente antes de enviar: a janela pode ter fechado e o
    // consentimento pode ter sido revogado desde a criação
    const template =
      dispatch.templateName && dispatch.templateLanguage
        ? {
            name: dispatch.templateName,
            language: dispatch.templateLanguage,
            params: (dispatch.templateParams as string[] | null) ?? [],
          }
        : null;
    const decision = await this.evaluate(workspaceId, conversation, template ?? undefined);
    if (!decision.allowed) {
      await this.settleFailure(
        workspaceId,
        messageId,
        dispatch.reservationId,
        'permanent',
        decision.reason,
      );
      return 'done';
    }

    // a reserva pode ter sido liberada por uma tentativa anterior: reserva de
    // novo ANTES de chamar, senão o teto não valeria para retentativa
    let reservationId = dispatch.reservationId;
    if (!reservationId) {
      const nova = await this.usage.reserve(workspaceId, 'messages_sent', 1);
      if (nova === 'quota_exceeded') {
        await this.markDispatch(messageId, 'failed_permanent', { errorCode: 'quota_exceeded' });
        return 'done';
      }
      reservationId = nova.reservationId;
      await this.markDispatch(messageId, 'reserved', { reservationId });
    }

    const token = this.crypto.decrypt(credential.tokenCipher);
    const outcome =
      decision.kind === 'template' && template
        ? await this.transport.sendTemplate(
            { phoneNumberId: credential.phoneNumberId, token },
            conversation.externalAddress as string,
            { name: template.name, language: template.language },
            template.params,
          )
        : await this.transport.sendText(
            { phoneNumberId: credential.phoneNumberId, token },
            conversation.externalAddress as string,
            message.body,
          );

    if (outcome.ok) {
      await this.usage.settle(workspaceId, reservationId, 'messages_sent', 1);
      await this.markDispatch(messageId, 'sent', {
        externalId: outcome.externalId,
        reservationId: null,
      });
      return 'done';
    }

    const classe = classifyFailure(outcome.failure);
    const errorCode = String(outcome.failure.metaCode ?? outcome.failure.status ?? 'network');

    if (classe === 'ambiguous') {
      // pode ter sido despachada: LIQUIDA a quota, não reenvia e encerra o
      // evento. Reenviar arriscaria mensagem duplicada para o paciente.
      await this.usage.settle(workspaceId, reservationId, 'messages_sent', 1);
      await this.markDispatch(messageId, 'unknown_after_dispatch', {
        errorCode,
        reservationId: null,
      });
      this.logger.warn(`Envio ${messageId} incerto (${errorCode}) — aguardando resolução humana`);
      return 'done';
    }

    // comprovadamente antes do envio: libera a quota
    await this.usage.release(reservationId);
    if (classe === 'permanent') {
      await this.markDispatch(messageId, 'failed_permanent', { errorCode, reservationId: null });
      return 'done'; // retentar repetiria o mesmo erro
    }
    await this.markDispatch(messageId, 'failed_before_send', { errorCode, reservationId: null });
    return 'retry'; // transitória: o outbox tenta de novo com backoff
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async evaluate(
    workspaceId: string,
    conversation: {
      id: string;
      channelId: string;
      contactId: string | null;
      lastInboundAt: Date | null;
      externalAddress: string | null;
    },
    template?: { name: string; language: string; params: string[] },
  ): Promise<SendDecision> {
    const registered = template
      ? ((await this.prisma.db.messageTemplate.findFirst({
          where: {
            channelId: conversation.channelId,
            name: template.name,
            language: template.language,
            status: 'approved',
          },
        })) as unknown as { paramCount: number } | null)
      : null;
    if (template && !registered) return { allowed: false, reason: 'template_unknown' };

    const consent = conversation.contactId
      ? await this.prisma.db.contactChannelConsent.findFirst({
          where: { contactId: conversation.contactId, channelType: 'whatsapp', activeMark: true },
          select: { id: true },
        })
      : null;

    return decideSend({
      lastInboundAt: conversation.lastInboundAt,
      hasActiveConsent: consent !== null,
      template: registered
        ? { name: template!.name, language: template!.language, paramCount: registered.paramCount }
        : null,
      templateParams: template?.params ?? [],
      externalAddress: conversation.externalAddress,
      now: new Date(),
    });
  }

  private async loadConversation(id: string): Promise<{
    id: string;
    channelId: string;
    contactId: string | null;
    lastInboundAt: Date | null;
    externalAddress: string | null;
  }> {
    const row = (await this.prisma.db.conversation.findFirst({
      where: { id },
      select: {
        id: true,
        channelId: true,
        contactId: true,
        lastInboundAt: true,
        externalAddress: true,
      },
    })) as unknown as {
      id: string;
      channelId: string;
      contactId: string | null;
      lastInboundAt: Date | null;
      externalAddress: string | null;
    } | null;
    if (!row) throw new NotFoundException('Conversa não encontrada');
    return row;
  }

  private async settleFailure(
    workspaceId: string,
    messageId: string,
    reservationId: string | null,
    classe: 'permanent',
    errorCode: string,
  ): Promise<void> {
    if (reservationId) await this.usage.release(reservationId);
    await this.markDispatch(messageId, 'failed_permanent', { errorCode, reservationId: null });
    this.logger.warn(`Envio ${messageId} recusado (${errorCode}) — falha ${classe}`);
  }

  private async markDispatch(
    messageId: string,
    state: string,
    extra: { errorCode?: string; externalId?: string; reservationId?: string | null } = {},
  ): Promise<void> {
    await this.prisma.db.messageDispatch.updateMany({
      where: { messageId },
      data: {
        state: state as never,
        attempts: { increment: 1 },
        ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
        ...(extra.externalId !== undefined ? { externalId: extra.externalId } : {}),
        ...(extra.reservationId !== undefined ? { reservationId: extra.reservationId } : {}),
      },
    });
  }

  private explain(reason: string): string {
    switch (reason) {
      case 'window_closed_needs_template':
        return 'A janela de 24h fechou: use um template aprovado para retomar o contato';
      case 'template_requires_consent':
        return 'Envio por template exige consentimento registrado do contato';
      case 'template_unknown':
        return 'Template não registrado ou não aprovado';
      case 'template_params_mismatch':
        return 'Quantidade de parâmetros não corresponde ao template';
      case 'no_external_address':
        return 'Conversa sem endereço externo: não há destinatário para o envio';
      default:
        return 'Envio não permitido pela política do canal';
    }
  }
}

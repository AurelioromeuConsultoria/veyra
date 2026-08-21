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

/** Lease do envio: cobre a chamada ao provedor com folga (timeout de 15s). */
const DISPATCH_LEASE_MS = 2 * 60_000;

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
      // 402 estruturado, como o resto do sistema (ADR-033) — não um 400 genérico
      throw await this.usage.quotaExceeded(workspaceId, 'messages_sent');
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
    // ANTES de tentar reivindicar: uma linha em voo com MARCADOR DE DESPACHO e
    // lease vencido significa "chamamos a Meta e não soubemos o resultado".
    // Reenviar aqui duplicaria mensagem para o paciente.
    if (await this.resolveAbandonedInFlight(workspaceId, messageId)) return 'done';

    /**
     * CLAIM atômico com lease e fencing. Sem ele, dois workers (lease do outbox
     * expirado, por exemplo) leriam o mesmo dispatch como enviável e ambos
     * chamariam a Meta — mensagem duplicada para um paciente.
     *
     * `sending` só é reassumido quando NÃO houve despacho (`dispatchedAt IS
     * NULL`): é o marcador que distingue "morreu antes de chamar" de "morreu
     * depois". `failed_before_send` é elegível — sem isso a retentativa nunca
     * aconteceria de verdade.
     *
     * Elegíveis: `reserved` (primeira tentativa), `failed_before_send` (falha
     * transitória anterior — é isto que faz a retentativa funcionar de verdade,
     * sem ninguém mexer no banco) ou `sending` com LEASE EXPIRADO (worker que
     * morreu no meio).
     */
    // `raw` justificado: claim atômico exige UPDATE condicional com RETURNING,
    // que o client filtrado não expressa. `workspaceId` vai explícito no WHERE.
    const claimed = await this.prisma.raw.$queryRawUnsafe<
      {
        reservationId: string | null;
        templateName: string | null;
        templateLanguage: string | null;
        templateParams: unknown;
        claimToken: string;
      }[]
    >(
      `UPDATE "MessageDispatch"
          SET "state" = 'sending',
              "claimToken" = gen_random_uuid(),
              "leaseExpiresAt" = now() + ($3::int * interval '1 millisecond'),
              -- a reserva da tentativa anterior pode ter EXPIRADO e sido
              -- expurgada: zerar aqui obriga o caminho a reservar de novo, em
              -- vez de confiar num id que talvez não exista mais
              "reservationId" = CASE WHEN "state" = 'reserved' THEN "reservationId" ELSE NULL END,
              "attempts" = "attempts" + 1
        WHERE "workspaceId" = $1::uuid
          AND "messageId" = $2::uuid
          AND (
            "state" IN ('reserved', 'failed_before_send')
            OR ("state" = 'sending' AND "leaseExpiresAt" < now() AND "dispatchedAt" IS NULL)
          )
      RETURNING "reservationId", "templateName", "templateLanguage", "templateParams", "claimToken"`,
      workspaceId,
      messageId,
      DISPATCH_LEASE_MS,
    );
    const dispatch = claimed[0];
    // outro worker tem a posse, ou o envio já terminou: não reenviar
    if (!dispatch) return 'done';

    const message = (await this.prisma.db.message.findFirst({
      where: { id: messageId },
      select: { body: true, conversationId: true },
    })) as unknown as { body: string; conversationId: string } | null;
    if (!message) {
      // nada a enviar: não deixa a linha presa em `sending` para sempre
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: 'message_missing',
      });
      return 'done';
    }

    let conversation;
    try {
      conversation = await this.loadConversation(message.conversationId);
    } catch {
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: 'conversation_missing',
      });
      return 'done';
    }
    const credential = (await this.prisma.db.channelCredential.findFirst({
      where: { channelId: conversation.channelId },
    })) as unknown as { phoneNumberId: string; tokenCipher: string } | null;
    if (!credential) {
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: 'no_credential',
      });
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
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
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: decision.reason,
      });
      return 'done';
    }

    // a reserva pode ter sido liberada por uma tentativa anterior: reserva de
    // novo ANTES de chamar, senão o teto não valeria para retentativa
    let reservationId = dispatch.reservationId;
    if (!reservationId) {
      const nova = await this.usage.reserve(workspaceId, 'messages_sent', 1);
      if (nova === 'quota_exceeded') {
        await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
          errorCode: 'quota_exceeded',
        });
        return 'done';
      }
      reservationId = nova.reservationId;
      await this.prisma.db.messageDispatch.updateMany({
        where: { messageId, claimToken: dispatch.claimToken, state: 'sending' },
        data: { reservationId },
      });
    }

    // MARCADOR DE DESPACHO, gravado com fencing imediatamente antes de chamar:
    // é o que impede outro worker de reenviar se morrermos na chamada
    const marcou = await this.prisma.db.messageDispatch.updateMany({
      where: { messageId, claimToken: dispatch.claimToken, state: 'sending' },
      data: { dispatchedAt: new Date() },
    });
    if (marcou.count === 0) {
      // perdemos a posse antes de despachar: quem tem a posse decide
      this.logger.warn(`Lease de envio ${messageId} perdido antes do despacho`);
      return 'done';
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
      await this.chargeOne(workspaceId, reservationId);
      const posse = await this.finish(messageId, dispatch.claimToken, 'sent', {
        externalId: outcome.externalId,
      });
      if (!posse) {
        /**
         * Perdemos a posse DEPOIS de enviar. NÃO sobrescrevemos a linha de quem
         * assumiu — escrever cego aqui poderia marcar como incerto um envio que
         * o outro worker concluiu com sucesso. O fato vai para a trilha, que é
         * append-only por natureza.
         */
        this.logger.error(
          `Lease de envio ${messageId} perdido após despacho bem-sucedido (${outcome.externalId})`,
        );
        await this.prisma.raw.auditLog.create({
          data: {
            workspaceId,
            action: 'message.dispatch_lease_lost',
            entityType: 'message',
            entityId: messageId,
            actorType: 'system',
            actorId: 'whatsapp-dispatcher',
            after: { externalId: outcome.externalId },
          },
        });
      }
      return 'done';
    }

    const classe = classifyFailure(outcome.failure);
    const errorCode = String(outcome.failure.metaCode ?? outcome.failure.status ?? 'network');

    if (classe === 'ambiguous') {
      // pode ter sido despachada: COBRA a quota, não reenvia e encerra
      await this.chargeOne(workspaceId, reservationId);
      await this.finish(messageId, dispatch.claimToken, 'unknown_after_dispatch', { errorCode });
      this.logger.warn(`Envio ${messageId} incerto (${errorCode}) — aguardando resolução humana`);
      return 'done';
    }

    await this.usage.release(reservationId);
    if (classe === 'permanent') {
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', { errorCode });
      return 'done';
    }
    await this.finish(messageId, dispatch.claimToken, 'failed_before_send', { errorCode });
    return 'retry';
  }

  /**
   * Cobra UMA mensagem. Se a reserva já foi expurgada por TTL, o gasto ainda
   * aconteceu — cobra direto, sem barrar. Confiar no `settle` silencioso deixava
   * envio sem cobrança e o teto sem valer para retentativa.
   */
  private async chargeOne(workspaceId: string, reservationId: string): Promise<void> {
    const liquidada = await this.usage.settle(workspaceId, reservationId, 'messages_sent', 1);
    if (!liquidada) {
      const db = this.prisma.db as unknown as TxRunner;
      await db.$transaction((tx) =>
        this.usage.consumeOverLimit(tx, workspaceId, 'messages_sent', 1),
      );
    }
  }

  /**
   * Linha em voo, com marcador de despacho e lease vencido: chamamos a Meta e
   * não soubemos o resultado. Vai para `unknown_after_dispatch` com a quota
   * cobrada — nunca de volta para envio (ADR-039).
   */
  private async resolveAbandonedInFlight(workspaceId: string, messageId: string): Promise<boolean> {
    const abandonadas = await this.prisma.raw.$queryRawUnsafe<{ reservationId: string | null }[]>(
      `UPDATE "MessageDispatch"
          SET "state" = 'unknown_after_dispatch',
              "errorCode" = 'lease_expired_in_flight',
              "claimToken" = NULL,
              "leaseExpiresAt" = NULL
        WHERE "workspaceId" = $1::uuid
          AND "messageId" = $2::uuid
          AND "state" = 'sending'
          AND "dispatchedAt" IS NOT NULL
          AND "leaseExpiresAt" < now()
      RETURNING "reservationId"`,
      workspaceId,
      messageId,
    );
    const abandonada = abandonadas[0];
    if (!abandonada) return false;
    this.logger.error(
      `Envio ${messageId} abandonado em voo — marcado incerto, sem reenvio (ADR-039)`,
    );
    /**
     * A reserva NÃO é zerada no UPDATE acima de propósito: `RETURNING` devolve o
     * valor DEPOIS da escrita, então zerar ali perderia o id e a cobrança
     * cairia no caminho de "reserva inexistente" — somando ao valor que a
     * reserva já ocupava no contador e cobrando duas vezes.
     */
    if (abandonada.reservationId) {
      await this.chargeOne(workspaceId, abandonada.reservationId);
    } else {
      const db = this.prisma.db as unknown as TxRunner;
      await db.$transaction((tx) =>
        this.usage.consumeOverLimit(tx, workspaceId, 'messages_sent', 1),
      );
    }
    await this.prisma.db.messageDispatch.updateMany({
      where: { messageId },
      data: { reservationId: null },
    });
    return true;
  }

  /**
   * Marca terminal um dispatch cujo evento do outbox morreu (tentativas
   * esgotadas ou lease perdido): `failed_before_send` promete retentativa que
   * não vai acontecer.
   */
  async markExhausted(workspaceId: string, messageId: string): Promise<void> {
    await this.prisma.raw.messageDispatch.updateMany({
      where: { workspaceId, messageId, state: { in: ['reserved', 'failed_before_send'] } },
      data: {
        state: 'failed_permanent',
        errorCode: 'retries_exhausted',
        claimToken: null,
        leaseExpiresAt: null,
        reservationId: null,
      },
    });
  }

  /**
   * Conclui o dispatch SÓ se o lease ainda for nosso (fencing). `false` = a
   * posse foi perdida, e quem chamou decide o que fazer — no caminho de sucesso,
   * marcar incerto em vez de reenviar.
   */
  private async finish(
    messageId: string,
    claimToken: string,
    state: string,
    extra: { errorCode?: string; externalId?: string } = {},
  ): Promise<boolean> {
    const { count } = await this.prisma.db.messageDispatch.updateMany({
      where: { messageId, claimToken, state: 'sending' },
      data: {
        state: state as never,
        claimToken: null,
        leaseExpiresAt: null,
        reservationId: null,
        ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
        ...(extra.externalId !== undefined ? { externalId: extra.externalId } : {}),
      },
    });
    return count > 0;
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

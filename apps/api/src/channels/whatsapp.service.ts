import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../outbox/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { verifyMetaSignature } from './whatsapp.signature';
import { STATUS_MAP, SUPPORTED_MESSAGE_TYPES, whatsappWebhookSchema } from './whatsapp.types';

/**
 * Ingestão do WhatsApp (ADR-037/038).
 *
 * `prisma.raw` é a regra AQUI, com `workspaceId` explícito em cada operação: não
 * existe sessão nem CLS neste caminho — o workspace é DERIVADO do
 * `phone_number_id` já verificado pela assinatura. É o mesmo padrão justificado
 * do worker (SECURITY.md §2).
 */
@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
  ) {}

  /** Assinatura sobre o CORPO BRUTO, antes de qualquer parse de domínio. */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    const secret = this.config.get<string>('META_APP_SECRET');
    if (!secret || !rawBody) return false;
    return verifyMetaSignature(rawBody, header, secret);
  }

  /**
   * Processa o payload JÁ verificado. Devolve o que foi feito, para observação —
   * nunca lança por conteúdo desconhecido: a Meta reentrega o que não recebe
   * 2xx, e erro em evento que não sabemos tratar viraria reentrega infinita.
   */
  async ingest(payload: unknown): Promise<{ messages: number; statuses: number; ignored: number }> {
    const parsed = whatsappWebhookSchema.safeParse(payload);
    if (!parsed.success) {
      this.logger.warn('Payload do WhatsApp fora da forma esperada — ignorado');
      return { messages: 0, statuses: 0, ignored: 1 };
    }

    let messages = 0;
    let statuses = 0;
    let ignored = 0;

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        // ROTEAMENTO pelo número (ADR-037): é isto que localiza o canal e, por
        // consequência, o workspace. Nunca um campo escolhido pelo cliente.
        const credential = await this.prisma.raw.channelCredential.findUnique({
          where: { phoneNumberId: value.metadata.phone_number_id },
        });
        if (!credential) {
          this.logger.warn('Evento para número não configurado — ignorado');
          ignored += 1;
          continue;
        }

        for (const message of value.messages ?? []) {
          const nome = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name;
          const feito = await this.ingestMessage(credential, message, nome);
          if (feito) messages += 1;
          else ignored += 1;
        }
        for (const status of value.statuses ?? []) {
          const feito = await this.ingestStatus(credential, status);
          if (feito) statuses += 1;
          else ignored += 1;
        }
      }
    }
    return { messages, statuses, ignored };
  }

  private async ingestMessage(
    credential: { workspaceId: string; channelId: string },
    message: {
      id: string;
      from: string;
      timestamp: string;
      type: string;
      text?: { body?: string };
      image?: { id?: string; mime_type?: string };
      document?: { id?: string; mime_type?: string; filename?: string };
      audio?: { id?: string; mime_type?: string };
    },
    profileName?: string,
  ): Promise<boolean> {
    if (!SUPPORTED_MESSAGE_TYPES.has(message.type)) {
      this.logger.warn(`Tipo de mensagem não suportado (${message.type}) — ignorado`);
      return false;
    }
    const { workspaceId, channelId } = credential;

    // DEDUPE pelo unique (workspaceId, channelId, externalId): a Meta reentrega
    // o que não recebe 2xx, e reentrega não pode virar mensagem repetida
    const existente = await this.prisma.raw.message.findFirst({
      where: { workspaceId, channelId, externalId: message.id },
      select: { id: true },
    });
    if (existente) return true; // já ingerida: sucesso, sem efeito

    const contact = await this.resolveContact(workspaceId, message.from, profileName);
    const occurredAt = new Date(Number(message.timestamp) * 1000);
    const media = this.extractMedia(message);
    const body = message.text?.body?.trim() || (media ? `[${message.type}]` : '');
    if (!body) return false;

    await this.prisma.raw.$transaction(async (tx) => {
      const conversation = await this.resolveConversation(tx, workspaceId, channelId, contact.id);
      const created = await tx.message.create({
        data: {
          workspaceId,
          conversationId: conversation.id,
          channelId,
          direction: 'inbound',
          authorType: 'contact',
          authorContactId: contact.id,
          body,
          externalId: message.id,
          deliveredAt: occurredAt,
        },
      });
      await tx.conversation.updateMany({
        where: { workspaceId, id: conversation.id },
        data: {
          lastMessageAt: occurredAt,
          // JANELA DE ATENDIMENTO (ADR-038): mensagem recebida abre a janela.
          // Consentimento é OUTRA coisa e NÃO é criado aqui.
          lastInboundAt: occurredAt,
          status: conversation.status === 'closed' ? 'open' : undefined,
        },
      });
      await tx.activity.create({
        data: {
          workspaceId,
          type: 'message_received',
          actorType: 'system',
          payload: {},
          occurredAt,
          conversationId: conversation.id,
          contactId: contact.id,
        },
      });

      if (media) {
        // o webhook PÚBLICO não baixa mídia: só registra a referência e agenda
        // a coleta autenticada (ajuste da revisão). Baixar aqui daria a um
        // chamador externo o poder de nos fazer buscar conteúdo arbitrário.
        await this.outbox.enqueue(
          tx,
          workspaceId,
          'whatsapp.media_pending',
          {
            messageId: created.id,
            mediaId: media.mediaId,
            mimeType: media.mimeType,
            fileName: media.fileName ?? '',
          },
          `whatsapp.media_pending:${message.id}`,
        );
      }
    });
    return true;
  }

  private async ingestStatus(
    credential: { workspaceId: string; channelId: string },
    status: { id: string; status: string; timestamp: string; errors?: { code?: number }[] },
  ): Promise<boolean> {
    const mapped = STATUS_MAP[status.status];
    if (!mapped) {
      this.logger.warn(`Status desconhecido (${status.status}) — ignorado`);
      return false;
    }
    const { workspaceId } = credential;
    // o recibo referencia o wamid, que vive no DISPATCH (Message é append-only)
    const dispatch = await this.prisma.raw.messageDispatch.findFirst({
      where: { workspaceId, externalId: status.id },
      select: { messageId: true },
    });
    if (!dispatch) {
      this.logger.warn('Recibo para mensagem desconhecida — ignorado');
      return false;
    }
    try {
      await this.prisma.raw.messageStatusEvent.create({
        data: {
          workspaceId,
          messageId: dispatch.messageId,
          status: mapped,
          // ORDEM é a do PROVEDOR, não a de chegada (ADR-039)
          occurredAt: new Date(Number(status.timestamp) * 1000),
          errorCode: status.errors?.[0]?.code ? String(status.errors[0].code) : null,
        },
      });
    } catch (error) {
      // reentrega do MESMO recibo: o unique deduplica e o fato continua um só
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
    return true;
  }

  /** Contato pelo telefone; cria se não existir, com o nome do perfil. */
  private async resolveContact(
    workspaceId: string,
    waId: string,
    profileName?: string,
  ): Promise<{ id: string }> {
    const phone = `+${waId.replace(/\D/g, '')}`;
    const existente = await this.prisma.raw.contact.findFirst({
      where: { workspaceId, phones: { has: phone } },
      select: { id: true },
    });
    if (existente) return existente;
    return this.prisma.raw.contact.create({
      data: {
        workspaceId,
        name: profileName?.trim() || phone,
        phones: [phone],
        source: 'whatsapp',
      },
      select: { id: true },
    });
  }

  private async resolveConversation(
    // a transação do client CRU (não há CLS neste caminho): o tipo vem do
    // próprio Prisma, e cada operação leva workspaceId explícito
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string,
    contactId: string,
  ): Promise<{ id: string; status: string }> {
    const aberta = (await tx.conversation.findFirst({
      where: { workspaceId, channelId, contactId, status: { not: 'closed' } },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true, status: true },
    })) as { id: string; status: string } | null;
    if (aberta) return aberta;
    return (await tx.conversation.create({
      data: { workspaceId, channelId, contactId },
      select: { id: true, status: true },
    })) as { id: string; status: string };
  }

  private extractMedia(message: {
    type: string;
    image?: { id?: string; mime_type?: string };
    document?: { id?: string; mime_type?: string; filename?: string };
    audio?: { id?: string; mime_type?: string };
  }): { mediaId: string; mimeType: string; fileName?: string } | null {
    const fonte = message.image ?? message.document ?? message.audio;
    if (!fonte?.id) return null;
    return {
      mediaId: fonte.id,
      mimeType: fonte.mime_type ?? 'application/octet-stream',
      fileName: (message.document as { filename?: string } | undefined)?.filename,
    };
  }
}

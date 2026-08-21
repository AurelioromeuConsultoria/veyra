import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactsService } from '../contacts/contacts.service';
import { UsageService } from '../usage/usage.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
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
    private readonly contacts: ContactsService,
    private readonly usage: UsageService,
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
    const occurredAt = new Date(Number(message.timestamp) * 1000);
    const media = this.extractMedia(message);
    const body = message.text?.body?.trim() || (media ? `[${message.type}]` : '');
    if (!body) return false;
    const phone = `+${message.from.replace(/\D/g, '')}`;
    // a linha do contador precisa existir antes da transação: criá-la lá dentro
    // exporia a corrida da primeira escrita a um P2002, que aborta a transação
    // inteira no Postgres
    await this.usage.ensureCounterRow(workspaceId, 'contacts');

    /**
     * TUDO numa transação, sob LOCK CONSULTIVO por (workspace, canal, telefone).
     *
     * Sem o lock, duas entregas simultâneas do mesmo evento — que a Meta faz —
     * criavam dois contatos e uma delas estourava no unique da mensagem: dedupe
     * verificado fora da transação é uma corrida perdida. O lock serializa por
     * telefone, então conversas de contatos diferentes seguem em paralelo.
     */
    await this.prisma.raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        `${workspaceId}:${channelId}`,
        phone,
      );

      // DEDUPE dentro do lock: agora "não existe" é uma afirmação estável
      const existente = await tx.message.findFirst({
        where: { workspaceId, channelId, externalId: message.id },
        select: { id: true },
      });
      if (existente) return;

      const contactId = await this.resolveContact(tx, workspaceId, phone, profileName);
      const conversation = await this.resolveConversation(
        tx,
        workspaceId,
        channelId,
        contactId,
        occurredAt,
      );

      const created = await tx.message.create({
        data: {
          workspaceId,
          conversationId: conversation.id,
          channelId,
          direction: 'inbound',
          authorType: 'contact',
          authorContactId: contactId,
          body,
          externalId: message.id,
          deliveredAt: occurredAt,
        },
      });

      // NUNCA REGREDIR: entrega fora de ordem não pode encurtar a janela nem
      // reordenar o inbox. Guarda o MAIOR timestamp visto.
      await tx.conversation.updateMany({
        where: { workspaceId, id: conversation.id },
        data: {
          lastMessageAt: this.later(conversation.lastMessageAt, occurredAt),
          // JANELA DE ATENDIMENTO (ADR-038): mensagem recebida abre a janela.
          // Consentimento é OUTRA coisa e NÃO é criado aqui.
          lastInboundAt: this.later(conversation.lastInboundAt, occurredAt),
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
          contactId,
        },
      });

      if (media) {
        // REFERÊNCIA em tabela, não evento interno sem consumidor: o dispatcher
        // marcaria o evento como entregue e a mídia desapareceria. A coleta
        // autenticada acontece na 9.1.b.
        await tx.inboundMedia.create({
          data: {
            workspaceId,
            messageId: created.id,
            providerMediaId: media.mediaId,
            mimeType: media.mimeType,
            fileName: media.fileName ?? null,
          },
        });
      }
    });
    return true;
  }

  /** O maior de dois instantes, tolerando ausência. */
  private later(current: Date | null | undefined, candidate: Date): Date {
    return current && current.getTime() > candidate.getTime() ? current : candidate;
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
    const { workspaceId, channelId } = credential;
    // o recibo referencia o wamid, que vive no DISPATCH (Message é append-only).
    // O `message.channelId` no filtro garante que o recibo é do MESMO canal que
    // a credencial resolveu — sem isso, um número aceitaria recibo de mensagem
    // enviada por outro canal do mesmo workspace.
    const dispatch = await this.prisma.raw.messageDispatch.findFirst({
      where: { workspaceId, externalId: status.id, message: { channelId } },
      select: { messageId: true },
    });
    if (!dispatch) {
      this.logger.warn('Recibo sem dispatch correspondente neste canal — ignorado');
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

  /**
   * Contato pelo telefone; se não existir, cria PELO DOMÍNIO — com quota,
   * Activity e `contact.created` no outbox, para que um lead chegando por
   * WhatsApp dispare automação como qualquer outro (ADR-040).
   */
  private async resolveContact(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    phone: string,
    profileName?: string,
  ): Promise<string> {
    const existente = await tx.contact.findFirst({
      where: { workspaceId, phones: { has: phone } },
      select: { id: true },
    });
    if (existente) return existente.id;
    return this.contacts.createFromExternalChannel(tx as unknown as Db, workspaceId, {
      name: profileName?.trim() || phone,
      phone,
      source: 'whatsapp',
    });
  }

  private async resolveConversation(
    // a transação do client CRU (não há CLS neste caminho): o tipo vem do
    // próprio Prisma, e cada operação leva workspaceId explícito
    tx: Prisma.TransactionClient,
    workspaceId: string,
    channelId: string,
    contactId: string,
    /** instante da mensagem: conversa NOVA nasce com ele, não com `now()` */
    occurredAt: Date,
  ): Promise<{ id: string; status: string; lastMessageAt: Date; lastInboundAt: Date | null }> {
    const aberta = await tx.conversation.findFirst({
      where: { workspaceId, channelId, contactId, status: { not: 'closed' } },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true, status: true, lastMessageAt: true, lastInboundAt: true },
    });
    if (aberta) return aberta;
    // o default `now()` serve para conversa criada à mão; aqui o instante é o
    // da mensagem, senão a regra de "não regredir" fixaria a conversa no agora
    return tx.conversation.create({
      data: {
        workspaceId,
        channelId,
        contactId,
        lastMessageAt: occurredAt,
        lastInboundAt: occurredAt,
      },
      select: { id: true, status: true, lastMessageAt: true, lastInboundAt: true },
    });
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

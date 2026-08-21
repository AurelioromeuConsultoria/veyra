import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConsentStatus,
  ConversationDto,
  ConversationPageDto,
  CreateConversationInput,
  CreateMessageInput,
  ListConversationsInput,
  ListMessagesInput,
  MessageAttachmentDto,
  MessageDto,
  MessagePageDto,
  MessageTemplateDto,
  SendPolicyDto,
  UpdateConversationInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { decideSend, SERVICE_WINDOW_MS } from '../channels/send-policy';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsageService } from '../usage/usage.service';
import { AuthContext } from '../common/decorators';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * Consentimento é por (contato, canal). Chave única para os dois lugares que o
 * consultam, para nenhum deles esquecer o canal — foi o defeito que a revisão
 * pegou: a tela dizia "opt-in registrado" com base em outro canal.
 */
const consentKey = (contactId: string, channelType: string): string =>
  `${contactId}:${channelType}`;

type ConversationRow = {
  id: string;
  channelId: string;
  channelType?: 'internal' | 'email' | 'whatsapp';
  contactId: string | null;
  subject: string | null;
  status: 'open' | 'pending' | 'closed';
  assigneeMembershipId: string | null;
  lastMessageAt: Date;
  /** última mensagem DO CONTATO: origem da janela de 24h (ADR-038) */
  lastInboundAt: Date | null;
  /** endereço exato no canal externo (o wa_id que falou com a gente) */
  externalAddress: string | null;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  authorType: 'contact' | 'user' | 'ai' | 'system';
  authorMembershipId: string | null;
  authorContactId: string | null;
  body: string;
  deliveredAt: Date | null;
  createdAt: Date;
};

interface Cursor {
  at: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at.toISOString()}|${cursor.id}`).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { at, id };
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly send: WhatsappSendService,
    private readonly usage: UsageService,
  ) {}

  /**
   * Canal interno de sistema do workspace (ADR-023). O cliente nunca escolhe
   * canal nesta entrega; a unicidade é garantida pelo banco (unique parcial).
   */
  private async systemChannelId(): Promise<string> {
    const channel = await this.prisma.db.channel.findFirst({
      where: { systemMark: true },
      select: { id: true },
    });
    if (!channel) {
      // provisionamento e backfill garantem a existência: ausência é bug, não input
      throw new Error('Workspace sem canal interno — provisionamento incompleto');
    }
    return channel.id;
  }

  async list(input: ListConversationsInput): Promise<ConversationPageDto> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const where = {
      ...(input.status === 'all' ? {} : { status: input.status }),
      ...(input.assigneeMembershipId ? { assigneeMembershipId: input.assigneeMembershipId } : {}),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(cursor
        ? {
            OR: [
              { lastMessageAt: { lt: cursor.at } },
              { lastMessageAt: cursor.at, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = (await this.prisma.db.conversation.findMany({
      where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    } as never)) as unknown as ConversationRow[];

    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: await this.toDtos(page),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.lastMessageAt, id: last.id })
          : null,
    };
  }

  async get(id: string): Promise<ConversationDto> {
    const row = (await this.prisma.db.conversation.findFirst({
      where: { id },
    })) as unknown as ConversationRow | null;
    if (!row) throw new NotFoundException('Conversa não encontrada');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async create(input: CreateConversationInput): Promise<ConversationDto> {
    await this.validateReferences(input);
    const channelId = await this.systemChannelId();
    const created = await this.prisma.db.conversation.create({
      data: {
        channelId,
        contactId: input.contactId ?? null,
        subject: input.subject ?? null,
        assigneeMembershipId: input.assigneeMembershipId ?? null,
        // sempre preenchido: o keyset do inbox não tem caso especial de null
        lastMessageAt: new Date(),
      },
    } as never);
    return this.get((created as unknown as { id: string }).id);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationDto> {
    const existing = (await this.prisma.db.conversation.findFirst({
      where: { id },
    })) as unknown as ConversationRow | null;
    if (!existing) throw new NotFoundException('Conversa não encontrada');
    await this.validateReferences(input);

    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: { id },
        data: {
          subject: input.subject,
          status: input.status,
          assigneeMembershipId: input.assigneeMembershipId,
        },
      });
      // ADR-026: atribuir a OUTRA pessoa avisa quem recebeu; quem atribui a si
      // mesmo não se autonotifica. dedupeKey pelo par (conversa, destinatário):
      // reatribuir para quem já foi avisado não repete o aviso — evita
      // tempestade de notificação ao alternar responsável
      const assignee = input.assigneeMembershipId;
      if (
        assignee &&
        assignee !== existing.assigneeMembershipId &&
        assignee !== auth.membershipId
      ) {
        await this.notifications.emit(
          tx,
          auth.workspaceId as string,
          assignee,
          'conversation_assigned',
          { subject: input.subject ?? existing.subject ?? 'Sem assunto' },
          `conversation_assigned:${id}:${assignee}`,
        );
      }
    });
    return this.get(id);
  }

  /**
   * Registro manual de mensagem. O autor é DERIVADO da direção — cliente não
   * escolhe quem falou. `Message` é append-only: enviada, não se reescreve.
   */
  async addMessage(
    auth: AuthContext,
    conversationId: string,
    input: CreateMessageInput,
  ): Promise<MessageDto> {
    const conversation = (await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
    })) as unknown as ConversationRow | null;
    if (!conversation) throw new NotFoundException('Conversa não encontrada');

    if (input.direction === 'inbound' && !conversation.contactId) {
      throw new BadRequestException(
        'Conversa sem contato não recebe mensagem de entrada — vincule um contato antes',
      );
    }

    // anexos: precisam existir NESTE workspace (o findMany filtrado garante) e,
    // se a conversa for de canal EXTERNO, precisam estar `clean` — arquivo
    // pendente de verificação não sai do Veyra (§7.5). Esta checagem vem ANTES
    // do roteamento de canal: é sobre o CONTEÚDO, e recusar por conteúdo antes
    // de discutir política de canal dá o erro mais útil ao usuário.
    const attachments = await this.files.loadForAttachment(input.attachmentIds ?? []);
    const channel = await this.prisma.db.channel.findFirst({
      where: { id: conversation.channelId },
      select: { type: true },
    });
    const isExternal = channel?.type !== 'internal';
    if (attachments.length > 0 && isExternal) {
      this.files.assertSendableExternally(attachments);
    }

    // CANAL EXTERNO: o envio tem política, reserva de quota e despacho pelo
    // outbox (ADR-039). O canal interno grava direto, como sempre.
    if (isExternal && input.direction === 'outbound' && channel?.type !== 'whatsapp') {
      /**
       * Só WhatsApp tem transporte hoje. Rotear qualquer canal não-interno para o
       * remetente de WhatsApp criaria uma mensagem que o worker nunca conseguiria
       * enviar (não acharia credencial) — falha tardia e obscura em vez de
       * recusa clara.
       */
      throw new BadRequestException(
        'Este canal ainda não tem transporte de envio configurado no Veyra',
      );
    }
    if (isExternal && input.direction === 'outbound') {
      /**
       * RECUSA EXPLÍCITA: o transporte ainda não envia mídia, e seguir adiante
       * criaria a mensagem SEM o anexo — 201 para quem escreveu, nada para quem
       * deveria receber. Falha silenciosa é pior que limitação declarada; o
       * envio com anexo entra quando o scanner existir (9.2).
       */
      if (attachments.length > 0) {
        throw new BadRequestException(
          'Envio com anexo ainda não é suportado neste canal — envie o texto e compartilhe o arquivo por outro meio',
        );
      }
      const { messageId } = await this.send.enqueueOutbound(auth.workspaceId as string, {
        conversationId,
        body: input.body,
        template: input.template,
        actorMembershipId: auth.membershipId ?? null,
      });
      const row = (await this.prisma.db.message.findFirst({
        where: { id: messageId },
      })) as unknown as MessageRow;
      const [dto] = await this.toMessageDtos([row]);
      return dto;
    }

    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          // derivado da conversa NO SERVIDOR (ADR-023), nunca do cliente
          channelId: conversation.channelId,
          direction: input.direction,
          authorType: input.direction === 'outbound' ? 'user' : 'contact',
          authorMembershipId: input.direction === 'outbound' ? auth.membershipId : null,
          authorContactId: input.direction === 'inbound' ? conversation.contactId : null,
          body: input.body,
          // canal interno entrega na hora; canal externo passará pelo outbox
          deliveredAt: new Date(),
        },
      } as never);

      if (attachments.length > 0) {
        await tx.messageAttachment.createMany({
          data: attachments.map((file) => ({
            workspaceId: auth.workspaceId as string,
            messageId: (message as unknown as { id: string }).id,
            fileObjectId: file.id,
          })),
        } as never);
      }

      await tx.conversation.updateMany({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          // mensagem em conversa fechada a reabre — o inbox não perde o assunto
          status: conversation.status === 'closed' ? 'open' : undefined,
        },
      });

      await this.activities.record(
        tx,
        auth.workspaceId as string,
        input.direction === 'outbound' ? 'message_sent' : 'message_received',
        {
          actorMembershipId: auth.membershipId,
          payload: {}, // nunca o corpo da mensagem na timeline
          targets: { conversationId, contactId: conversation.contactId },
        },
      );
      return (message as unknown as { id: string }).id;
    });

    const row = (await this.prisma.db.message.findFirst({
      where: { id },
    })) as unknown as MessageRow;
    const [dto] = await this.toMessageDtos([row]);
    return dto;
  }

  async listMessages(conversationId: string, input: ListMessagesInput): Promise<MessagePageDto> {
    const conversation = await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException('Conversa não encontrada');

    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const rows = (await this.prisma.db.message.findMany({
      where: {
        conversationId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    } as never)) as unknown as MessageRow[];

    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: await this.toMessageDtos(page),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Veredito do SERVIDOR sobre o que o compositor pode enviar agora, com os
   * templates aprovados quando o texto livre não é permitido.
   *
   * Existe para que a UI não recalcule política: ela não vê consentimento
   * revogado nem recibo atrasado, e uma segunda implementação da regra
   * divergiria da que o worker aplica de fato (ADR-038, ADR-039).
   */
  async sendPolicy(workspaceId: string, id: string): Promise<SendPolicyDto> {
    const row = (await this.prisma.db.conversation.findFirst({
      where: { id },
    })) as unknown as ConversationRow | null;
    if (!row) throw new NotFoundException('Conversa não encontrada');

    const channel = await this.prisma.db.channel.findFirst({
      where: { id: row.channelId },
      select: { type: true },
    });
    const channelType = (channel?.type ?? 'internal') as SendPolicyDto['channelType'];
    const windowExpiresAt = row.lastInboundAt
      ? new Date(row.lastInboundAt.getTime() + SERVICE_WINDOW_MS).toISOString()
      : null;

    // canal interno não tem janela, consentimento nem template: registro direto
    if (channelType === 'internal') {
      return {
        channelType,
        mode: 'free_form',
        reason: null,
        windowExpiresAt: null,
        consentStatus: null,
        templates: [],
      };
    }

    /**
     * COTA faz parte do veredito. Sem ela, a política dizia `free_form` e o
     * envio devolvia 402 — a tela prometia um envio que o servidor recusa. O
     * atendente precisa saber que o limite do plano é a razão, e não achar que
     * a mensagem falhou por defeito.
     */
    /**
     * Só WhatsApp tem transporte. Sem este ramo, a política prometia envio num
     * canal que `addMessage` recusa com 400 — a mesma divergência tela/servidor
     * que a cota criava, e a frase é deliberadamente a MESMA das duas pontas.
     */
    if (channelType !== 'whatsapp') {
      return {
        channelType,
        mode: 'blocked',
        reason: 'Este canal ainda não tem transporte de envio configurado no Veyra',
        windowExpiresAt,
        consentStatus: null,
        templates: [],
      };
    }

    const [consents, templates, cotaEsgotada] = await Promise.all([
      this.resolveConsents([row]),
      this.prisma.db.messageTemplate.findMany({
        where: { channelId: row.channelId, status: 'approved' },
        select: { name: true, language: true, paramCount: true },
        orderBy: { name: 'asc' },
      }),
      this.usage.isExhausted(workspaceId, 'messages_sent'),
    ]);
    const consentStatus: ConsentStatus = row.contactId
      ? (consents.get(consentKey(row.contactId, channelType)) ?? 'none')
      : 'none';
    if (cotaEsgotada) {
      return {
        channelType,
        mode: 'blocked',
        reason: 'Cota de mensagens do plano esgotada neste período',
        windowExpiresAt,
        consentStatus,
        templates: [],
      };
    }
    /**
     * A MESMA função pura que o worker usa, consultada sem template: se ela
     * permite texto livre, a janela está aberta; se recusa, o motivo já é a
     * explicação que a tela mostra.
     */
    const decision = decideSend({
      lastInboundAt: row.lastInboundAt,
      hasActiveConsent: consentStatus === 'granted',
      template: null,
      templateParams: [],
      externalAddress: row.externalAddress,
      now: new Date(),
    });

    if (decision.allowed) {
      return {
        channelType,
        mode: 'free_form',
        reason: null,
        windowExpiresAt,
        consentStatus,
        templates: templates as MessageTemplateDto[],
      };
    }
    /**
     * Sem endereço externo não há como enviar nada — nem template. É diferente
     * de "janela fechada", e dizer "use um template" aí mandaria o atendente
     * tentar algo que também vai falhar.
     */
    if (decision.reason === 'no_external_address') {
      return {
        channelType,
        mode: 'blocked',
        reason: 'Esta conversa não tem endereço externo: só é possível enviar após o contato falar',
        windowExpiresAt,
        consentStatus,
        templates: [],
      };
    }
    // janela fechada: template é o caminho, e ele exige consentimento vigente
    if (consentStatus !== 'granted') {
      return {
        channelType,
        mode: 'blocked',
        reason:
          'Janela de 24h fechada e sem consentimento registrado: registre o opt-in do contato para retomar por template',
        windowExpiresAt,
        consentStatus,
        templates: templates as MessageTemplateDto[],
      };
    }
    if (templates.length === 0) {
      return {
        channelType,
        mode: 'blocked',
        reason: 'Janela de 24h fechada e nenhum template aprovado cadastrado neste canal',
        windowExpiresAt,
        consentStatus,
        templates: [],
      };
    }
    return {
      channelType,
      mode: 'template',
      reason: 'Janela de 24h fechada: use um template aprovado',
      windowExpiresAt,
      consentStatus,
      templates: templates as MessageTemplateDto[],
    };
  }

  private async validateReferences(input: {
    contactId?: string | null;
    assigneeMembershipId?: string | null;
  }): Promise<void> {
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId } });
      if (!contact) throw new BadRequestException('Contato inválido');
    }
    if (input.assigneeMembershipId) {
      const assignee = await this.prisma.db.membership.findFirst({
        where: { id: input.assigneeMembershipId, status: 'active' },
      });
      if (!assignee) throw new BadRequestException('Responsável inválido');
    }
  }

  private async toDtos(rows: ConversationRow[]): Promise<ConversationDto[]> {
    const [contactNames, memberNames, channels] = await Promise.all([
      this.resolveContactNames(rows.map((r) => r.contactId)),
      this.resolveMemberNames(rows.map((r) => r.assigneeMembershipId)),
      this.prisma.db.channel.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.channelId))] } },
        select: { id: true, type: true },
      }),
    ]);
    const channelType = new Map(channels.map((c) => [c.id, c.type]));
    return rows.map((row) => ({
      id: row.id,
      channelType: (channelType.get(row.channelId) ?? 'internal') as ConversationDto['channelType'],
      contactId: row.contactId,
      contactName: row.contactId ? (contactNames.get(row.contactId) ?? null) : null,
      subject: row.subject,
      status: row.status,
      assigneeMembershipId: row.assigneeMembershipId,
      assigneeName: row.assigneeMembershipId
        ? (memberNames.get(row.assigneeMembershipId) ?? null)
        : null,
      lastMessageAt: row.lastMessageAt.toISOString(),
      /**
       * Derivado, não armazenado: a janela é `lastInboundAt + 24h` e nada mais.
       * Guardar o instante calculado abriria a chance de ele divergir do fato
       * que o gera. Canal interno não tem janela.
       */
      windowExpiresAt:
        channelType.get(row.channelId) === 'internal' || !row.lastInboundAt
          ? null
          : new Date(row.lastInboundAt.getTime() + SERVICE_WINDOW_MS).toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Estado do consentimento por (contato, CANAL), em UMA consulta. `granted`
   * exige marca ativa; `revoked` distingue "nunca houve" de "houve e foi
   * retirado" — a diferença muda o que o atendente faz em seguida.
   *
   * A chave inclui o TIPO DE CANAL porque o consentimento é por canal
   * (`@@unique(workspaceId, contactId, channelType, activeMark)`) e é assim que
   * o envio o verifica. Sem isso, um opt-in de e-mail apareceria como opt-in de
   * WhatsApp: a tela afirmaria a existência de uma evidência que nunca foi dada
   * — exatamente a fusão que o ADR-038 proíbe, e com peso de LGPD.
   */
  private async resolveConsents(rows: ConversationRow[]): Promise<Map<string, ConsentStatus>> {
    const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
    if (contactIds.length === 0) return new Map();
    const consents = await this.prisma.db.contactChannelConsent.findMany({
      where: { contactId: { in: contactIds } },
      select: { contactId: true, channelType: true, activeMark: true },
    });
    const estado = new Map<string, ConsentStatus>();
    for (const consent of consents) {
      const chave = consentKey(consent.contactId, consent.channelType);
      if (consent.activeMark === true) estado.set(chave, 'granted');
      else if (!estado.has(chave)) estado.set(chave, 'revoked');
    }
    return estado;
  }

  private async toMessageDtos(rows: MessageRow[]): Promise<MessageDto[]> {
    const [memberNames, contactNames, attachments, dispatches] = await Promise.all([
      this.resolveMemberNames(rows.map((r) => r.authorMembershipId)),
      this.resolveContactNames(rows.map((r) => r.authorContactId)),
      this.resolveAttachments(rows.map((r) => r.id)),
      this.resolveDispatches(rows.map((r) => r.id)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction,
      authorType: row.authorType,
      authorName: row.authorMembershipId
        ? (memberNames.get(row.authorMembershipId) ?? null)
        : row.authorContactId
          ? (contactNames.get(row.authorContactId) ?? null)
          : null,
      body: row.body,
      attachments: attachments.get(row.id) ?? [],
      dispatchState: (dispatches.get(row.id)?.state ?? null) as MessageDto['dispatchState'],
      dispatchError: dispatches.get(row.id)?.errorCode ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Estado do despacho por mensagem. É o que torna visível a fila de casos
   * incertos e de falhas definitivas — sem isso, uma mensagem aceita com 201
   * morria em `failed_permanent` sem nada aparecer para quem a enviou.
   */
  private async resolveDispatches(
    messageIds: string[],
  ): Promise<Map<string, { state: string; errorCode: string | null }>> {
    if (messageIds.length === 0) return new Map();
    const rows = (await this.prisma.db.messageDispatch.findMany({
      where: { messageId: { in: messageIds } },
      select: { messageId: true, state: true, errorCode: true },
    } as never)) as unknown as { messageId: string; state: string; errorCode: string | null }[];
    return new Map(
      rows.map((row) => [row.messageId, { state: row.state, errorCode: row.errorCode }]),
    );
  }

  private async resolveAttachments(
    messageIds: string[],
  ): Promise<Map<string, MessageAttachmentDto[]>> {
    if (messageIds.length === 0) return new Map();
    const links = (await this.prisma.db.messageAttachment.findMany({
      where: { messageId: { in: messageIds } },
    } as never)) as unknown as { messageId: string; fileObjectId: string }[];
    if (links.length === 0) return new Map();
    const files = (await this.prisma.db.fileObject.findMany({
      where: { id: { in: [...new Set(links.map((l) => l.fileObjectId))] } },
    } as never)) as unknown as {
      id: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      scanStatus: 'pending' | 'clean' | 'quarantined';
    }[];
    const byId = new Map(files.map((f) => [f.id, f]));
    const result = new Map<string, MessageAttachmentDto[]>();
    for (const link of links) {
      const file = byId.get(link.fileObjectId);
      if (!file) continue;
      result.set(link.messageId, [
        ...(result.get(link.messageId) ?? []),
        {
          fileObjectId: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          scanStatus: file.scanStatus,
        },
      ]);
    }
    return result;
  }

  private async resolveContactNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const contacts = await this.prisma.db.contact.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(contacts.map((c) => [c.id, c.name]));
  }

  private async resolveMemberNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: unique } },
      select: { id: true, userId: true },
    });
    // raw justificado: nome (User global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true },
    });
    const byUser = new Map(users.map((u) => [u.id, u.name]));
    return new Map(memberships.map((m) => [m.id, byUser.get(m.userId) ?? '']));
  }
}

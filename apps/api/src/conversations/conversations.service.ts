import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ConversationDto,
  ConversationPageDto,
  CreateConversationInput,
  CreateMessageInput,
  ListConversationsInput,
  ListMessagesInput,
  MessageAttachmentDto,
  MessageDto,
  MessagePageDto,
  UpdateConversationInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthContext } from '../common/decorators';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type ConversationRow = {
  id: string;
  channelId: string;
  channelType?: 'internal' | 'email' | 'whatsapp';
  contactId: string | null;
  subject: string | null;
  status: 'open' | 'pending' | 'closed';
  assigneeMembershipId: string | null;
  lastMessageAt: Date;
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
    if (isExternal && input.direction === 'outbound') {
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
      createdAt: row.createdAt.toISOString(),
    }));
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

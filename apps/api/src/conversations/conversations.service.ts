import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
import { PermissionsService } from '../auth/permissions.service';
import {
  decideSend,
  MENSAGEM_NUMERO_NAO_CONFERE,
  MENSAGEM_REMETENTE_A_IDENTIFICAR,
  SERVICE_WINDOW_MS,
} from '../channels/send-policy';
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
  /** RAI (ADR-052 item 2): `unidentified` não tem contato */
  senderStatus: 'identified' | 'unidentified';
  senderIdentifiedAt: Date | null;
  createdAt: Date;
};

/** O que a tela pode ver da conversa, conforme quem pergunta (C13). */
type Visao = { podeVerRai: boolean; mostraNumero: boolean };

/** C13: a RAI não vai para quem não pode identificá-la. */
const MENSAGEM_ATRIBUIR_RAI =
  'Esta conversa só pode ser atribuída a quem pode identificar o remetente';

/** O 409 do único de conversa aberta (critério 4 da aprovação da F4.1a). */
const MENSAGEM_OUTRA_ABERTA = 'Já existe outra conversa aberta para este número.';

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
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * C13 (ADR-052): a conversa RAI só existe para quem tem `contacts:write`,
   * além de `conversations:read`; o número completo, só com `contacts:read`.
   */
  private async visao(auth: AuthContext): Promise<Visao> {
    const [podeVerRai, mostraNumero] = await Promise.all([
      this.permissions.has(auth, 'contacts:write'),
      this.permissions.has(auth, 'contacts:read'),
    ]);
    return { podeVerRai, mostraNumero };
  }

  /** A conversa como quem pergunta pode vê-la: a RAI invisível é 404. */
  private async lerVisivel(
    auth: AuthContext,
    id: string,
  ): Promise<{ row: ConversationRow; visao: Visao }> {
    const row = (await this.prisma.db.conversation.findFirst({
      where: { id },
    })) as unknown as ConversationRow | null;
    const visao = await this.visao(auth);
    if (!row || (row.senderStatus === 'unidentified' && !visao.podeVerRai)) {
      throw new NotFoundException('Conversa não encontrada');
    }
    return { row, visao };
  }

  /**
   * Reabrir (ou responder numa conversa encerrada) com outra aberta da mesma
   * chave violaria o único (ADR-052 item 2): 409. Ele aponta a outra conversa
   * SÓ se quem pede pode acessá-la; senão, a mensagem é genérica.
   */
  private async conflitoAoReabrir(row: ConversationRow, visao: Visao): Promise<void> {
    if (!row.externalAddress) return;
    const where =
      row.senderStatus === 'unidentified'
        ? { senderStatus: 'unidentified' as const }
        : row.contactId
          ? { contactId: row.contactId }
          : null;
    if (!where) return;
    const outra = (await this.prisma.db.conversation.findFirst({
      where: {
        ...where,
        channelId: row.channelId,
        externalAddress: row.externalAddress,
        status: { not: 'closed' },
        id: { not: row.id },
      },
      select: { id: true, senderStatus: true },
    })) as unknown as { id: string; senderStatus: string } | null;
    if (!outra) return;
    const acessivel = outra.senderStatus !== 'unidentified' || visao.podeVerRai;
    throw new ConflictException(
      acessivel
        ? { message: MENSAGEM_OUTRA_ABERTA, conversationId: outra.id }
        : MENSAGEM_OUTRA_ABERTA,
    );
  }

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

  async list(auth: AuthContext, input: ListConversationsInput): Promise<ConversationPageDto> {
    const visao = await this.visao(auth);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const where = {
      // C13: sem `contacts:write`, a RAI não aparece nem na contagem da página
      ...(visao.podeVerRai ? {} : { senderStatus: 'identified' as const }),
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
      items: await this.toDtos(page, visao),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.lastMessageAt, id: last.id })
          : null,
    };
  }

  async get(auth: AuthContext, id: string): Promise<ConversationDto> {
    const { row, visao } = await this.lerVisivel(auth, id);
    const [dto] = await this.toDtos([row], visao);
    return dto;
  }

  async create(auth: AuthContext, input: CreateConversationInput): Promise<ConversationDto> {
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
    return this.get(auth, (created as unknown as { id: string }).id);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationDto> {
    const { row: existing, visao } = await this.lerVisivel(auth, id);
    await this.validateReferences(input);
    // C13: a conversa RAI só vai para quem pode identificar o remetente — a
    // notificação da atribuição revelaria a conversa a quem não pode vê-la
    const soConversaIdentificada =
      input.assigneeMembershipId !== undefined &&
      input.assigneeMembershipId !== null &&
      !(await this.permissions.membershipHas(input.assigneeMembershipId, 'contacts:write'));
    if (soConversaIdentificada && existing.senderStatus === 'unidentified') {
      throw new BadRequestException(MENSAGEM_ATRIBUIR_RAI);
    }
    if (existing.status === 'closed' && input.status && input.status !== 'closed') {
      await this.conflitoAoReabrir(existing, visao);
    }

    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      /**
       * A conferência acima leu a conversa FORA da transação: um desfazer ou um
       * rejeitar concorrente pode tê-la levado à RAI no meio. A condição na
       * própria escrita é a garantia; sem linha escrita, ela virou RAI.
       */
      const { count } = await tx.conversation.updateMany({
        where: { id, ...(soConversaIdentificada ? { senderStatus: 'identified' } : {}) },
        data: {
          subject: input.subject,
          status: input.status,
          assigneeMembershipId: input.assigneeMembershipId,
        },
      });
      if (count === 0) {
        const ainda = await tx.conversation.findFirst({ where: { id }, select: { id: true } });
        if (!ainda) throw new NotFoundException('Conversa não encontrada');
        throw new BadRequestException(MENSAGEM_ATRIBUIR_RAI);
      }
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
    return this.get(auth, id);
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
    const { row: conversation, visao } = await this.lerVisivel(auth, conversationId);

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
    const attachments = await this.files.loadForAttachment(auth, input.attachmentIds ?? []);
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
      const [dto] = await this.toMessageDtos([row], conversation);
      return dto;
    }

    // mensagem em conversa encerrada a reabre: com outra aberta da mesma chave,
    // o único seria violado (ADR-052 item 2)
    if (conversation.status === 'closed') await this.conflitoAoReabrir(conversation, visao);

    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId,
          // derivado da conversa NO SERVIDOR (ADR-023), nunca do cliente
          channelId: conversation.channelId,
          direction: input.direction,
          // a AUTORIA é gravada; a ATRIBUIÇÃO ao contato vem da conversa (C12)
          authorType: input.direction === 'outbound' ? 'user' : 'contact',
          authorMembershipId: input.direction === 'outbound' ? auth.membershipId : null,
          body: input.body,
          // canal interno entrega na hora; canal externo passará pelo outbox
          deliveredAt: new Date(),
        },
      } as never);

      if (attachments.length > 0) {
        /**
         * PRENDE os arquivos antes de ligá-los (escrita sem efeito), como o
         * expurgo da exclusão de contato: as duas escritas se serializam. Se o
         * expurgo veio antes, o arquivo sumiu e o anexo é recusado; se veio
         * depois, ele vê este vínculo e o arquivo fica (revisão da F4.1a).
         */
        const presos = await tx.fileObject.updateMany({
          where: { id: { in: attachments.map((file) => file.id) } },
          data: { scanAttempts: { increment: 0 } },
        } as never);
        if ((presos as unknown as { count: number }).count !== attachments.length) {
          throw new BadRequestException('Arquivo inválido');
        }
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
          // sem `contactId`: a timeline do contato vem da conversa (C12)
          targets: { conversationId },
        },
      );
      return (message as unknown as { id: string }).id;
    });

    const row = (await this.prisma.db.message.findFirst({
      where: { id },
    })) as unknown as MessageRow;
    const [dto] = await this.toMessageDtos([row], conversation);
    return dto;
  }

  async listMessages(
    auth: AuthContext,
    conversationId: string,
    input: ListMessagesInput,
  ): Promise<MessagePageDto> {
    const { row: conversation } = await this.lerVisivel(auth, conversationId);

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
      items: await this.toMessageDtos(page, conversation),
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
  async sendPolicy(auth: AuthContext, id: string): Promise<SendPolicyDto> {
    const workspaceId = auth.workspaceId as string;
    const { row } = await this.lerVisivel(auth, id);

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

    /**
     * O MESMO predicado do envio (ADR-052 item 2), para a tela não prometer o
     * que o envio nega — e antes da cota: a RAI não recebe resposta, e a
     * identificada só com o número exato do cadastro do contato.
     */
    const remetente = await this.send.remetenteDoEnvio(row);
    if (remetente !== 'confere') {
      return {
        channelType,
        mode: 'blocked',
        reason:
          remetente === 'a_identificar'
            ? MENSAGEM_REMETENTE_A_IDENTIFICAR
            : MENSAGEM_NUMERO_NAO_CONFERE,
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
      remetente,
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

  private async toDtos(rows: ConversationRow[], visao: Visao): Promise<ConversationDto[]> {
    const [contactNames, memberNames, channels, doLegado] = await Promise.all([
      this.resolveContactNames(rows.map((r) => r.contactId)),
      this.resolveMemberNames(rows.map((r) => r.assigneeMembershipId)),
      this.prisma.db.channel.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.channelId))] } },
        select: { id: true, type: true },
      }),
      this.conversasDoLegado(rows),
    ]);
    const channelType = new Map(channels.map((c) => [c.id, c.type]));
    return rows.map((row) => ({
      id: row.id,
      channelType: (channelType.get(row.channelId) ?? 'internal') as ConversationDto['channelType'],
      contactId: row.contactId,
      contactName: row.contactId ? (contactNames.get(row.contactId) ?? null) : null,
      senderStatus: row.senderStatus,
      // o número completo só com `contacts:read`; para os outros, os 4 últimos
      senderAddress: row.externalAddress
        ? visao.mostraNumero
          ? row.externalAddress
          : `•••• ${row.externalAddress.slice(-4)}`
        : null,
      senderIdentifiedByPerson: row.senderIdentifiedAt !== null,
      senderRelinkBlocked: doLegado.has(row.id),
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
   * As conversas com atribuição GRAVADA ao contato, anterior à F4.1a (o
   * legado, ADR-052): a mesma condição que `ConversationSenderService` confere
   * sob as travas, em duas consultas para a página inteira. Só as de canal
   * externo, que são as que se religam.
   */
  private async conversasDoLegado(rows: ConversationRow[]): Promise<Set<string>> {
    const ids = rows.filter((r) => r.externalAddress).map((r) => r.id);
    if (ids.length === 0) return new Set();
    const [mensagens, atividades] = await Promise.all([
      this.prisma.db.message.findMany({
        where: { conversationId: { in: ids }, authorContactId: { not: null } },
        select: { conversationId: true },
        distinct: ['conversationId'],
      } as never),
      this.prisma.db.activity.findMany({
        where: { conversationId: { in: ids }, contactId: { not: null } },
        select: { conversationId: true },
        distinct: ['conversationId'],
      } as never),
    ]);
    return new Set(
      [...mensagens, ...atividades].map(
        (r) => (r as unknown as { conversationId: string }).conversationId,
      ),
    );
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

  /**
   * O autor exibido: o membro; senão o contato GRAVADO na mensagem (o legado,
   * anterior à F4.1a); senão, para a mensagem do contato, o contato ATUAL da
   * conversa (C12). Na conversa RAI, nenhum nome — a tela diz "remetente a
   * identificar".
   */
  private async toMessageDtos(
    rows: MessageRow[],
    conversa: Pick<ConversationRow, 'contactId'>,
  ): Promise<MessageDto[]> {
    const [memberNames, contactNames, attachments, dispatches] = await Promise.all([
      this.resolveMemberNames(rows.map((r) => r.authorMembershipId)),
      this.resolveContactNames([...rows.map((r) => r.authorContactId), conversa.contactId]),
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
          : row.authorType === 'contact' && conversa.contactId
            ? (contactNames.get(conversa.contactId) ?? null)
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

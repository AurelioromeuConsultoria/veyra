import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
  SendPolicyDto,
  UpdateConversationInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { PermissionsService } from '../auth/permissions.service';
import {
  decideSend,
  MENSAGEM_NUMERO_NAO_CONFERE,
  MENSAGEM_REMETENTE_A_IDENTIFICAR,
  MENSAGEM_JANELA_FECHADA_TEMPLATE,
  SERVICE_WINDOW_MS,
} from '../channels/send-policy';
import { bloqueioAtivo, MENSAGEM_PEDIDO_DE_PARAR } from '../consents/consent-records';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { UsageService } from '../usage/usage.service';
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

/**
 * QUEM lê o texto das conversas (ADR-061, adendo 9, item 8). `pessoa` (o
 * padrão, para falhar fechado): a regra do E8 — no `uniforme`, o texto de toda
 * conversa com pessoa ou a identificar sai como "Conteúdo restrito". `ia`: as
 * capacidades da IA leem o texto como antes; elas não passam pelo filtro de
 * leitura (decisão do adendo 9) e seguem sob a E6, que já recusa o paciente.
 */
export type LeitorDoTexto = 'pessoa' | 'ia';

type ConversaDoTexto = Pick<ConversationRow, 'contactId' | 'senderStatus'>;

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
  /** o contato da conversa quando a mensagem foi gravada (ADR-061, adendo 9) */
  receivedContactId: string | null;
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

/**
 * O corpo da mensagem de mídia é o marcador do TIPO (`[image]`, `[audio]`,
 * `[document]`, gravado pela ingestão). Com a mídia protegida (E8; ADR-061,
 * adendos 5 e 6), nem o tipo sai: o marcador vira o genérico. A decisão olha a
 * CONVERSA (de contato oculto, ou RAI na dúvida) e não só o anexo — a mídia
 * ainda não coletada (ou cuja coleta falhou) não tem anexo, e o tipo vazaria.
 * Um texto de verdade fica como está.
 */
const MARCADOR_DE_MIDIA = /^\[[a-z_]+\]$/;
export const MARCADOR_GENERICO = '[anexo]';
function corpoVisivel(
  row: { body: string; direction: string },
  anexos: readonly MessageAttachmentDto[],
  conversaOculta: boolean,
): string {
  if (!MARCADOR_DE_MIDIA.test(row.body)) return row.body;
  const oculta =
    anexos.some((a) => a.restricted) || (conversaOculta && row.direction === 'inbound');
  return oculta ? MARCADOR_GENERICO : row.body;
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
    private readonly files: FilesService,
    private readonly protegido: ProtectedContentService,
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

  async list(
    auth: AuthContext,
    input: ListConversationsInput,
    leitor: LeitorDoTexto = 'pessoa',
  ): Promise<ConversationPageDto> {
    const visao = await this.visao(auth);
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const where = {
      // C13: sem `contacts:write`, a RAI não aparece nem na contagem da página
      ...(visao.podeVerRai ? {} : { senderStatus: 'identified' as const }),
      ...(input.status === 'all' ? {} : { status: input.status }),
      ...(input.assigneeMembershipId ? { assigneeMembershipId: input.assigneeMembershipId } : {}),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      // "A identificar" (ADR-062, adendo 1, item 3): só ESTREITA. Vai num AND à
      // parte de propósito — no mesmo nível, a chave `senderStatus` do filtro
      // substituiria a do C13 acima e devolveria a RAI a quem não pode vê-la
      ...(input.senderStatus ? { AND: [{ senderStatus: input.senderStatus }] } : {}),
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
      items: await this.toDtos(auth, page, visao, leitor),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.lastMessageAt, id: last.id })
          : null,
    };
  }

  async get(
    auth: AuthContext,
    id: string,
    leitor: LeitorDoTexto = 'pessoa',
  ): Promise<ConversationDto> {
    const { row, visao } = await this.lerVisivel(auth, id);
    const [dto] = await this.toDtos(auth, [row], visao, leitor);
    return dto;
  }

  /**
   * O texto da conversa é oculto para quem pede (ADR-061, adendo 9, item 8)?
   * `null`: a conversa que não existe mais, na dúvida.
   */
  private async textoOculto(auth: AuthContext, conversa: ConversaDoTexto | null): Promise<boolean> {
    return (await this.protegido.conversasComTextoOculto(auth, [{ chave: 0, conversa }])).size > 0;
  }

  /**
   * O texto desta conversa é oculto para a PESSOA que pede (ADR-061, adendo 9,
   * item 8)? Para a IA: ela lê o texto como antes (`leitor: 'ia'`), mas não lê
   * POR quem não o lê — no `uniforme`, as capacidades sobre conversa com pessoa
   * ou a identificar são recusadas, igual para todo contato, antes de qualquer
   * outra conferência (a E6 diria quem é paciente).
   */
  async textoOcultoParaPessoa(
    auth: AuthContext,
    conversa: Pick<ConversationDto, 'contactId' | 'senderStatus'>,
  ): Promise<boolean> {
    return this.textoOculto(auth, conversa);
  }

  /**
   * Quem pede não lê o texto de NENHUMA conversa com pessoa (o `uniforme`)? Para
   * o que não tem uma conversa à mão antes de agir — a fila e a decisão sobre
   * os rascunhos de resposta da IA, que sempre são de uma conversa com pessoa.
   */
  async semLeituraDoTextoDasConversas(auth: AuthContext): Promise<boolean> {
    return this.protegido.semClassificacao(auth);
  }

  /** O mesmo, como recusa: 403 "Conteúdo restrito", igual para todo contato. */
  async exigirLeituraDoTextoDasConversas(auth: AuthContext): Promise<void> {
    if (await this.semLeituraDoTextoDasConversas(auth)) {
      throw new ForbiddenException(CONTEUDO_RESTRITO);
    }
  }

  /**
   * QUEM NÃO LÊ NÃO ESCREVE (ADR-061, adendo 9, item 8; a regra das notas e
   * tarefas no `uniforme`): o texto escrito numa conversa cujo texto é oculto
   * para quem pede — a mensagem registrada, o assunto, a conversa nova com
   * pessoa — é recusado com o mesmo 403, igual para todo contato.
   */
  private async exigirTextoVisivel(auth: AuthContext, conversa: ConversaDoTexto): Promise<void> {
    if (await this.textoOculto(auth, conversa)) throw new ForbiddenException(CONTEUDO_RESTRITO);
  }

  /**
   * As conferências de um registro de mensagem ANTES de escrever: a conversa
   * visível (a RAI invisível é 404, C13) e o texto visível (403 no
   * `uniforme`). A guarda da repetição usa as mesmas, para responder como um
   * pedido novo responderia agora.
   */
  async conferirRegistro(auth: AuthContext, conversationId: string): Promise<void> {
    const { row } = await this.lerVisivel(auth, conversationId);
    await this.exigirTextoVisivel(auth, row);
  }

  /**
   * As conferências da criação ANTES de escrever (a conversa nova com pessoa:
   * o assunto é texto sobre ela; adendo 9, item 8). A guarda da repetição usa
   * a mesma.
   */
  async conferirCriacao(auth: AuthContext, input: { contactId?: string | null }): Promise<void> {
    if (input.contactId) {
      await this.exigirTextoVisivel(auth, {
        contactId: input.contactId,
        senderStatus: 'identified',
      });
    }
  }

  async create(auth: AuthContext, input: CreateConversationInput): Promise<ConversationDto> {
    await this.conferirCriacao(auth, input);
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
    // o assunto (inclusive limpá-lo) é texto; o estado e o responsável, estrutura
    if (input.subject !== undefined) await this.exigirTextoVisivel(auth, existing);
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
    // antes de qualquer outra conferência: a recusa é a mesma para todo contato
    await this.exigirTextoVisivel(auth, conversation);

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
      const [dto] = await this.toMessageDtos(auth, [row], conversation);
      return dto;
    }

    // mensagem em conversa encerrada a reabre: com outra aberta da mesma chave,
    // o único seria violado (ADR-052 item 2)
    if (conversation.status === 'closed') await this.conflitoAoReabrir(conversation, visao);

    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      /**
       * A LINHA DA CONVERSA presa ANTES de qualquer escrita (escrita sem efeito
       * de quem já vai tocar `lastMessageAt`), e o remetente relido sob ela
       * (ADR-061, adendo 9, item 2, e o backlog do adendo 6): a correção do
       * remetente prende a mesma linha antes de contar a mídia, então as duas se
       * serializam. Se ela veio antes, o remetente mudou e o registro é recusado
       * sem efeito; se veio depois, ela vê esta mensagem e o anexo dela. O
       * contato gravado como o do recebimento é o relido aqui.
       */
      await tx.conversation.updateMany({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      });
      const presa = (await tx.conversation.findFirst({
        where: { id: conversationId },
        select: { contactId: true, senderStatus: true },
      })) as unknown as Pick<ConversationRow, 'contactId' | 'senderStatus'> | null;
      if (
        !presa ||
        presa.contactId !== conversation.contactId ||
        presa.senderStatus !== conversation.senderStatus
      ) {
        throw new ConflictException('A conversa acabou de mudar. Recarregue e tente de novo.');
      }
      const message = await tx.message.create({
        data: {
          conversationId,
          // derivado da conversa NO SERVIDOR (ADR-023), nunca do cliente
          channelId: conversation.channelId,
          // o contato da conversa AGORA, relido sob a trava (adendo 9, item 2)
          receivedContactId: presa.contactId,
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
    const [dto] = await this.toMessageDtos(auth, [row], conversation);
    return dto;
  }

  async listMessages(
    auth: AuthContext,
    conversationId: string,
    input: ListMessagesInput,
    leitor: LeitorDoTexto = 'pessoa',
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
      items: await this.toMessageDtos(auth, page, conversation, leitor),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Veredito do SERVIDOR sobre o que o compositor pode enviar agora: o texto
   * livre com a janela aberta; com ela fechada, o template pelo envio do
   * negócio (F4.1c-3), cujas opções e prévia vêm de rotas próprias.
   *
   * Existe para que a UI não recalcule política: ela não vê o pedido de parar
   * nem recibo atrasado, e uma segunda implementação da regra
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

    /**
     * QUEM NÃO LÊ NÃO ESCREVE (ADR-061, adendo 9, item 8): no `uniforme`, a
     * conversa com pessoa ou a identificar não recebe texto de quem pede — o
     * registro responde 403. Vem ANTES de todo outro motivo (o pedido de
     * parar, o remetente, a cota, a janela), para que o veredito seja o mesmo
     * para todo contato: um motivo diferente diria algo da pessoa.
     */
    if (await this.textoOculto(auth, row)) {
      return {
        channelType,
        mode: 'blocked',
        reason: CONTEUDO_RESTRITO,
        windowExpiresAt: channelType === 'internal' ? null : windowExpiresAt,
        consentStatus: null,
        templates: [],
      };
    }

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
     * O pedido de parar vem primeiro (C16, F4.1b): nada sai para o número, e a
     * tela mostra o bloqueio — a mesma recusa do envio e do worker. O recibo,
     * a data e quem registrou ficam com `consents:read`.
     */
    if (await bloqueioAtivo(this.prisma.db, row.externalAddress)) {
      return {
        channelType,
        mode: 'blocked',
        reason: MENSAGEM_PEDIDO_DE_PARAR,
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

    if (await this.usage.isExhausted(workspaceId, 'messages_sent')) {
      return {
        channelType,
        mode: 'blocked',
        reason: 'Cota de mensagens do plano esgotada neste período',
        windowExpiresAt,
        consentStatus: null,
        templates: [],
      };
    }
    /**
     * A MESMA função pura que o worker usa, consultada sem template: se ela
     * permite texto livre, a janela está aberta; se recusa, o motivo já é a
     * explicação que a tela mostra.
     *
     * O consentimento da 9.1 é histórico e não autoriza nada (C7): o estado
     * dele não aparece mais aqui.
     */
    const decision = decideSend({
      lastInboundAt: row.lastInboundAt,
      remetente,
      bloqueado: false,
      templatePedido: false,
      externalAddress: row.externalAddress,
      now: new Date(),
    });

    if (decision.allowed) {
      return {
        channelType,
        mode: 'free_form',
        reason: null,
        windowExpiresAt,
        consentStatus: null,
        templates: [],
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
        consentStatus: null,
        templates: [],
      };
    }
    /**
     * A janela fechada (F4.1c-3): o template sai pelo envio do negócio — o
     * compositor busca as opções revisadas e consentidas, mostra a prévia e
     * aprova. A lista `templates` é a do envio comum, que não manda template:
     * fica vazia.
     */
    return {
      channelType,
      mode: 'template',
      reason: MENSAGEM_JANELA_FECHADA_TEMPLATE,
      windowExpiresAt,
      consentStatus: null,
      templates: [],
    };
  }

  /**
   * A conversa para o consentimento e o pedido de parar (ADR-052 item 5,
   * F4.1b), com a MESMA visibilidade das outras rotas: a RAI só para quem tem
   * `contacts:write` (C13), e o número completo só com `contacts:read`.
   */
  async alvoDoConsentimento(
    auth: AuthContext,
    id: string,
  ): Promise<{
    contactId: string | null;
    senderStatus: string;
    externalAddress: string | null;
    mostraNumero: boolean;
  }> {
    const { row, visao } = await this.lerVisivel(auth, id);
    return {
      contactId: row.contactId,
      senderStatus: row.senderStatus,
      externalAddress: row.externalAddress,
      mostraNumero: visao.mostraNumero,
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

  private async toDtos(
    auth: AuthContext,
    rows: ConversationRow[],
    visao: Visao,
    leitor: LeitorDoTexto,
  ): Promise<ConversationDto[]> {
    const [contactNames, memberNames, channels, doLegado, ocultas] = await Promise.all([
      this.resolveContactNames(rows.map((r) => r.contactId)),
      this.resolveMemberNames(rows.map((r) => r.assigneeMembershipId)),
      this.prisma.db.channel.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.channelId))] } },
        select: { id: true, type: true },
      }),
      this.conversasDoLegado(rows),
      leitor === 'ia'
        ? new Set<string>()
        : this.protegido.conversasComTextoOculto(
            auth,
            rows.map((r) => ({ chave: r.id, conversa: r })),
          ),
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
      // o texto oculto (adendo 9, item 8): sempre o mesmo, com ou sem assunto
      ...(ocultas.has(row.id)
        ? { subject: CONTEUDO_RESTRITO, textRestricted: true as const }
        : { subject: row.subject }),
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
   * O autor exibido: o membro; senão o contato GRAVADO na mensagem (o legado,
   * anterior à F4.1a); senão, para a mensagem do contato, o contato ATUAL da
   * conversa (C12). Na conversa RAI, nenhum nome — a tela diz "remetente a
   * identificar".
   */
  private async toMessageDtos(
    auth: AuthContext,
    rows: MessageRow[],
    conversa: ConversaDoTexto,
    leitor: LeitorDoTexto = 'pessoa',
  ): Promise<MessageDto[]> {
    const [
      memberNames,
      contactNames,
      attachments,
      dispatches,
      conversaOculta,
      recebidosOcultos,
      textoOculto,
    ] = await Promise.all([
      this.resolveMemberNames(rows.map((r) => r.authorMembershipId)),
      this.resolveContactNames([...rows.map((r) => r.authorContactId), conversa.contactId]),
      this.resolveAttachments(
        auth,
        rows.map((r) => r.id),
      ),
      this.resolveDispatches(rows.map((r) => r.id)),
      this.conversaOculta(auth, conversa),
      // o contato do recebimento (adendo 9, item 2): o marcador da mídia ainda
      // não coletada também não revela o tipo depois da correção do remetente
      this.protegido.contatosGravadosOcultos(
        auth,
        rows.map((r) => r.receivedContactId),
      ),
      // o texto da conversa (adendo 9, item 8)
      leitor === 'ia' ? false : this.textoOculto(auth, conversa),
    ]);
    return rows.map((row) =>
      this.comTextoDaConversa(textoOculto, {
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
        body: corpoVisivel(
          row,
          attachments.get(row.id) ?? [],
          conversaOculta ||
            (row.receivedContactId !== null && recebidosOcultos.has(row.receivedContactId)),
        ),
        attachments: attachments.get(row.id) ?? [],
        dispatchState: (dispatches.get(row.id)?.state ?? null) as MessageDto['dispatchState'],
        dispatchError: dispatches.get(row.id)?.errorCode ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      }),
    );
  }

  /**
   * A mensagem de uma conversa de texto oculto para quem lê (ADR-061, adendo
   * 9, item 8): o corpo — inclusive o marcador da mídia, que diria o tipo —
   * sai como "Conteúdo restrito", e o código do despacho sai `null` (há
   * códigos que só a origem de uma extensão produz, como o cancelamento da
   * origem invalidada). A estrutura (direção, autoria, anexos já restritos
   * pela regra da mídia, estado do despacho, datas) fica. Igual para todo
   * contato.
   */
  private comTextoDaConversa(oculto: boolean, dto: MessageDto): MessageDto {
    if (!oculto) return dto;
    return { ...dto, body: CONTEUDO_RESTRITO, dispatchError: null, textRestricted: true };
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

  /** A conversa é de contato oculto para quem pede, ou RAI na dúvida (adendo 5)? */
  private async conversaOculta(
    auth: AuthContext,
    conversa: Pick<ConversationRow, 'contactId' | 'senderStatus'>,
  ): Promise<boolean> {
    if (conversa.contactId) {
      return (await this.protegido.contatosOcultos(auth, [conversa.contactId])).size > 0;
    }
    return conversa.senderStatus === 'unidentified' && (await this.protegido.duvidaOculta(auth));
  }

  /**
   * A REPETIÇÃO do registro de mensagem (mesma `Idempotency-Key`; adendo 6):
   * o corpo guardado com a regra de leitura de AGORA — os anexos que passaram
   * a ser protegidos saem restritos, e o marcador, genérico. A conversa é a de
   * agora; sem ela (excluída), a regra conservadora da dúvida.
   */
  async reprojetarMensagem(
    auth: AuthContext,
    conversationId: string,
    guardada: MessageDto,
  ): Promise<MessageDto> {
    const conversa = (await this.prisma.db.conversation.findFirst({
      where: { id: conversationId },
      select: { contactId: true, senderStatus: true },
    } as never)) as unknown as Pick<ConversationRow, 'contactId' | 'senderStatus'> | null;
    // o contato do recebimento da mensagem guardada (adendo 9, item 2)
    const gravada = (await this.prisma.db.message.findFirst({
      where: { id: guardada.id },
      select: { receivedContactId: true },
    } as never)) as unknown as { receivedContactId: string | null } | null;
    const oculta = conversa
      ? (await this.conversaOculta(auth, conversa)) ||
        (await this.protegido.contatosGravadosOcultos(auth, [gravada?.receivedContactId])).size > 0
      : await this.protegido.duvidaOculta(auth);
    const ids = guardada.attachments.flatMap((a) => (a.restricted ? [] : [a.fileObjectId]));
    const protegidas =
      oculta && !conversa ? new Set(ids) : await this.files.midiaProtegida(auth, ids);
    const attachments: MessageAttachmentDto[] = guardada.attachments.map((a) =>
      a.restricted || protegidas.has(a.fileObjectId) ? { restricted: true } : a,
    );
    return {
      ...guardada,
      attachments,
      body: corpoVisivel(guardada, attachments, oculta),
    };
  }

  private async resolveAttachments(
    auth: AuthContext,
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
    // a mídia protegida (E8; ADR-061, adendo 5): nem id, nome, tipo ou tamanho
    const protegidas = await this.files.midiaProtegida(auth, [...byId.keys()]);
    const result = new Map<string, MessageAttachmentDto[]>();
    for (const link of links) {
      const file = byId.get(link.fileObjectId);
      if (!file) continue;
      if (protegidas.has(file.id)) {
        result.set(link.messageId, [...(result.get(link.messageId) ?? []), { restricted: true }]);
        continue;
      }
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

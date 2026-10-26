import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import {
  ContentUseGuard,
  ehIncerto,
  type DesfechoIncerto,
  type ResultadoDoUso,
} from '../content-use/content-use.guard';
import { OrigensDosUsos } from '../content-use/content-use.orphans';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../content-use/content-use.pools';
import { ContentRestrictionService } from '../extensions/content-restriction';
import type { ClaimedEvent } from '../outbox/outbox.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { classifyFailure } from './meta-errors';
import { META_TRANSPORT, type MetaTransport, type SendOutcome } from './meta.transport';
import { coincideExatamente } from '../contacts/phone-identity';
import { bloqueioAtivo, MENSAGEM_PEDIDO_DE_PARAR } from '../consents/consent-records';
import {
  decideSend,
  MENSAGEM_NUMERO_NAO_CONFERE,
  MENSAGEM_REMETENTE_A_IDENTIFICAR,
  MENSAGEM_TEMPLATE_INDISPONIVEL,
  type RemetenteDoEnvio,
  type SendDecision,
} from './send-policy';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/** Lease do envio: cobre a chamada ao provedor com folga (timeout de 15s). */
const DISPATCH_LEASE_MS = 2 * 60_000;

/**
 * Só é considerado abandonado o que está parado há MUITO mais que o lease do
 * outbox (5 min): abaixo disso o caminho normal — outro worker reassume o
 * evento — ainda está em curso, e a varredura só atrapalharia. O desfecho
 * consulta o outbox justamente porque o backoff dele chega a horas.
 */
const REAP_AFTER_MINUTES = 15;

/**
 * Os códigos com que as varreduras marcam incerto um despacho em voo. Só eles
 * podem ser reescritos para "não saiu" quando a guarda provou que a chamada
 * não começou (ADR-047 adendo 7 §9, G3.2).
 */
const CODIGOS_EM_VOO_DAS_VARREDURAS = [
  'abandoned_in_flight',
  'lease_expired_in_flight',
  'retries_exhausted_in_flight',
] as const;

export interface OutboundRequest {
  conversationId: string;
  body: string;
  template?: { name: string; language: string; params: string[] };
  actorMembershipId: string | null;
}

/**
 * MARCA DE FASE: símbolo local, não exportado. Como o campo é obrigatório e o
 * símbolo é inalcançável de fora, só `prepareOutbound` produz um
 * `PreparedOutbound` — nenhum chamador futuro monta um à mão e escreve+enfileira
 * um envio sem passar por janela, opt-in e quota. Fantasma: não existe em runtime.
 */
declare const marcaDePreparo: unique symbol;

/**
 * Resultado da fase de PREPARO: política aprovada e quota reservada. A reserva
 * já existe aqui — quem prepara é responsável por liberá-la se a escrita não
 * acontecer (`releaseReservation`).
 */
export interface PreparedOutbound {
  readonly [marcaDePreparo]: never;
  conversationId: string;
  channelId: string;
  /** o contato da conversa no preparo: o que a pessoa via quando escreveu */
  contactId: string | null;
  reservationId: string;
  template?: { name: string; language: string; params: string[] };
}

/** Quem escreve: o caminho humano e o de IA divergem só aqui (ADR-044.8). */
export interface OutboundAuthor {
  body: string;
  authorType: 'user' | 'system' | 'ai';
  authorMembershipId: string | null;
}

/**
 * A conversa foi RELIGADA depois de o envio ser aprovado (ADR-052 item 2)? Ela
 * virou "remetente a identificar", ou o contato dela não está entre os
 * conferidos por quem aprovou o envio — os da aprovação do rascunho da IA, ou o
 * contato que a pessoa via quando escreveu. O texto era para outra pessoa e não
 * sai. Como a RAI não recebe resposta (decisão de 2026-10-23), toda mensagem na
 * fila foi escrita para um contato; o despacho sem conferidos (anterior à G3.2
 * na IA, anterior à F4.1a na pessoa) só é barrado pela RAI.
 */
function religadaDesdeOEnvio(
  conversa: { contactId: string | null; senderStatus: string },
  contatosConferidos: readonly string[],
): boolean {
  if (conversa.senderStatus === 'unidentified') return true;
  if (contatosConferidos.length === 0) return false;
  return conversa.contactId === null || !contatosConferidos.includes(conversa.contactId);
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
export class WhatsappSendService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly outbox: OutboxService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
    @Inject(META_TRANSPORT) private readonly transport: MetaTransport,
    private readonly restriction: ContentRestrictionService,
    private readonly guarda: ContentUseGuard,
    private readonly origens: OrigensDosUsos,
    @Inject(CONFIG_DA_GUARDA) private readonly configDaGuarda: ConfigDaGuarda,
    private readonly travas: TravasDeIdentidade,
  ) {}

  /** Chamado pelo caminho HTTP (atendente). Roda com CLS da request. */
  async enqueueOutbound(
    workspaceId: string,
    input: OutboundRequest,
  ): Promise<{ messageId: string }> {
    const prepared = await this.prepareOutbound(workspaceId, input);
    try {
      const db = this.prisma.db as unknown as TxRunner;
      return await db.$transaction((tx) =>
        this.writeOutboundWithin(tx, workspaceId, prepared, {
          body: input.body,
          authorType: input.actorMembershipId ? 'user' : 'system',
          authorMembershipId: input.actorMembershipId,
        }),
      );
    } catch (error) {
      // a mensagem não foi criada: a reserva não pode ficar pendurada
      await this.releaseReservation(prepared);
      throw error;
    }
  }

  /**
   * FASE 1 — política e quota, sempre FORA de transação. A reserva de quota é
   * um efeito com TTL próprio (ADR-033) e a avaliação de política lê estado que
   * não pertence à transação de escrita.
   *
   * Existe separada de `enqueueOutbound` para que a aprovação de uma proposta
   * de IA use a MESMA avaliação, em vez de uma segunda cópia que envelheceria
   * em silêncio (ADR-044.4). Ela lança ANTES de qualquer escrita — é o que
   * mantém a proposta `pending` quando a janela fechou (ADR-044.6).
   */
  async prepareOutbound(
    workspaceId: string,
    input: Pick<OutboundRequest, 'conversationId' | 'template'>,
  ): Promise<PreparedOutbound> {
    const conversation = await this.loadConversation(input.conversationId);
    const decision = await this.evaluate(workspaceId, conversation, input.template !== undefined);
    if (!decision.allowed) throw new BadRequestException(this.explain(decision.reason));

    await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
    const reservation = await this.usage.reserve(workspaceId, 'messages_sent', 1);
    if (reservation === 'quota_exceeded') {
      // 402 estruturado, como o resto do sistema (ADR-033) — não um 400 genérico
      throw await this.usage.quotaExceeded(workspaceId, 'messages_sent');
    }
    // o ÚNICO cast para a marca de fase, aqui, depois de política e quota
    return {
      conversationId: conversation.id,
      channelId: conversation.channelId,
      contactId: conversation.contactId,
      reservationId: reservation.reservationId,
      template: input.template,
    } as PreparedOutbound;
  }

  /**
   * FASE 2 — escrita, DENTRO da transação de quem chama. Mensagem append-only,
   * despacho `reserved` e evento de outbox nascem juntos ou não nascem: o
   * worker só encontra o que a transação commitou.
   *
   * A aprovação de proposta de IA passa por aqui com a MESMA transação em que
   * faz o CAS da proposta — é o que garante no máximo uma mensagem sob
   * aprovação concorrente (ADR-044.5).
   */
  async writeOutboundWithin(
    tx: Db,
    workspaceId: string,
    prepared: PreparedOutbound,
    author: OutboundAuthor,
    /**
     * os contatos conferidos na APROVAÇÃO do rascunho da IA (ADR-047 adendo 7
     * §9, G3.2): o envio trava e reconfere todos eles, somados ao contato atual
     * da conversa. Validados aqui, como a fotografia do outbox.
     */
    aprovacao?: { contactIds: readonly string[] },
  ): Promise<{ messageId: string }> {
    const contatosDaAprovacao = [...new Set(aprovacao?.contactIds ?? [])];
    if (contatosDaAprovacao.length > 0) {
      // contatos DESTE workspace (o client filtrado confere): a aprovação os
      // segura em trava compartilhada, então nenhuma exclusão os apaga no meio
      const existentes = await tx.contact.count({ where: { id: { in: contatosDaAprovacao } } });
      if (existentes !== contatosDaAprovacao.length) {
        throw new Error('Contatos da aprovação inexistentes ou de outro workspace.');
      }
    }
    const message = await tx.message.create({
      data: {
        conversationId: prepared.conversationId,
        channelId: prepared.channelId,
        direction: 'outbound',
        authorType: author.authorType,
        authorMembershipId: author.authorMembershipId,
        body: author.body,
      },
    } as never);
    const messageId = (message as unknown as { id: string }).id;

    await tx.messageDispatch.create({
      data: {
        messageId,
        state: 'reserved',
        reservationId: prepared.reservationId,
        // guardado para o worker REVALIDAR o mesmo envio que foi pedido
        templateName: prepared.template?.name ?? null,
        templateLanguage: prepared.template?.language ?? null,
        templateParams: prepared.template ? (prepared.template.params as object) : undefined,
        /**
         * Os contatos conferidos por quem APROVOU o envio: os da aprovação do
         * rascunho da IA, ou, na mensagem escrita por pessoa, o contato da
         * conversa no preparo (ADR-052, revisão da F4.1a). O worker não envia
         * se a conversa tiver sido religada desde então.
         */
        approvalContactIds:
          aprovacao !== undefined
            ? contatosDaAprovacao
            : prepared.contactId
              ? [prepared.contactId]
              : [],
        // a ORIGEM DE IA, editada ou não (decisão de 2026-10-21): só a
        // aprovação de uma proposta da IA passa `aprovacao`
        fromAiProposal: aprovacao !== undefined,
      },
    } as never);
    await tx.conversation.updateMany({
      where: { id: prepared.conversationId },
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
  }

  /**
   * O marcador da mensagem de PESSOA (F4.1b), numa transação curta com o
   * `address:` do número compartilhado — o pedido de parar o pega exclusivo:
   * ou o marcador comita antes do pedido, que o conta como em voo, ou o pedido
   * comita antes, e a releitura aqui o vê. Sem isto, um despacho gravado entre
   * o cancelamento do pedido e o commit dele sairia depois, fora da trilha.
   */
  private async marcarSobOEndereco(
    workspaceId: string,
    messageId: string,
    claimToken: string,
    numero: string,
  ): Promise<'marcou' | 'perdeu' | 'bloqueado'> {
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: { timeout?: number }) => Promise<T>;
    };
    return db.$transaction(
      async (tx) => {
        await this.travas.paraMarcarEnvio(tx, workspaceId, numero);
        if (await bloqueioAtivo(tx, numero)) return 'bloqueado';
        const { count } = await tx.messageDispatch.updateMany({
          where: { messageId, claimToken, state: 'sending' },
          data: { dispatchedAt: new Date() },
        });
        return count > 0 ? 'marcou' : 'perdeu';
      },
      { timeout: this.configDaGuarda.mudancaTransacaoMs },
    );
  }

  /** Desfaz o preparo quando a escrita não aconteceu. */
  async releaseReservation(prepared: PreparedOutbound): Promise<void> {
    await this.usage.release(prepared.reservationId);
  }

  /**
   * O pedido de parar (ADR-052 item 5, F4.1b), na transação dele: todo despacho
   * NÃO INICIADO para o número, no workspace e em qualquer canal, vai a
   * `failed_permanent` com `stop_requested`, e a reserva volta. Não iniciado é
   * o que ainda não tem o marcador de despacho — reservado, a retentar, ou
   * reivindicado por um worker que ainda não marcou: esse perde a posse (o
   * marcador exige o `claimToken`) e não chama a Meta. O que já tem o marcador
   * não volta; só é contado, para a trilha — inclusive o da IA à espera da
   * guarda, que ainda reconfere o pedido e o recusa.
   */
  async cancelarNaoIniciadosDoNumero(
    tx: Db,
    workspaceId: string,
    numero: string,
  ): Promise<{ cancelados: number; emVoo: number }> {
    const doNumero = { message: { conversation: { externalAddress: numero } } };
    const cancelados = await tx.messageDispatch.updateManyAndReturn({
      where: {
        ...doNumero,
        OR: [
          { state: { in: ['reserved', 'failed_before_send'] } },
          { state: 'sending', dispatchedAt: null },
        ],
      },
      data: {
        state: 'failed_permanent',
        errorCode: 'stop_requested',
        claimToken: null,
        leaseExpiresAt: null,
      },
      select: { messageId: true, reservationId: true },
    });
    if (cancelados.length > 0) {
      // a reserva sai do despacho DEPOIS de lida: o RETURNING entrega o valor
      // pós-escrita, e zerá-la no mesmo comando a perderia. As linhas já estão
      // presas por esta transação, e `failed_permanent` não é reivindicável
      await tx.messageDispatch.updateMany({
        where: { messageId: { in: cancelados.map((c) => c.messageId) } },
        data: { reservationId: null },
      });
      for (const { reservationId } of cancelados) {
        if (reservationId) await this.usage.releaseWithin(tx, workspaceId, reservationId);
      }
    }
    const emVoo = await tx.messageDispatch.count({
      where: { ...doNumero, state: 'sending', dispatchedAt: { not: null } },
    });
    return { cancelados: cancelados.length, emVoo };
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
     * A reserva NÃO é zerada aqui: `isReservationAlive` decide adiante. Zerar
     * perdia a referência de uma reserva VIVA (worker reiniciado antes de
     * despachar), que continuava ocupando o contador até o TTL — inflando o uso
     * e podendo recusar envios de terceiros.
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
        approvalContactIds: string[] | null;
        fromAiProposal: boolean;
      }[]
    >(
      `UPDATE "MessageDispatch"
          SET "state" = 'sending',
              "claimToken" = gen_random_uuid(),
              "leaseExpiresAt" = now() + ($3::int * interval '1 millisecond'),
              "attempts" = "attempts" + 1,
              -- o trigger do banco já o faria (ADR-049); explícito porque o
              -- limiar da varredura depende desta coluna: linha recém-escrita
              -- não pode parecer "velha" e ser enterrada na 1a passada
              "updatedAt" = now()
        WHERE "workspaceId" = $1::uuid
          AND "messageId" = $2::uuid
          AND (
            "state" IN ('reserved', 'failed_before_send')
            OR ("state" = 'sending' AND "leaseExpiresAt" < now() AND "dispatchedAt" IS NULL)
          )
      RETURNING "reservationId", "templateName", "templateLanguage", "templateParams", "claimToken",
                "approvalContactIds", "fromAiProposal"`,
      workspaceId,
      messageId,
      DISPATCH_LEASE_MS,
    );
    const dispatch = claimed[0];
    // outro worker tem a posse, ou o envio já terminou: não reenviar
    if (!dispatch) return 'done';

    const message = (await this.prisma.db.message.findFirst({
      where: { id: messageId },
      select: { body: true, conversationId: true, authorType: true },
    })) as unknown as { body: string; conversationId: string; authorType: string } | null;
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
    /**
     * Mensagem de ORIGEM DA IA para contato restrito não sai (ADR-048 §6.3,
     * item 5): o contato pode ter ficado restrito entre a aprovação e este
     * worker. A origem é a autoria `ai` (rascunho sem edição, ADR-044.8) OU a
     * aprovação de uma proposta da IA, editada ou não — editar não remove a
     * origem nem a guarda (decisão de 2026-10-21, ADR-047 adendo 7 §9). A
     * mensagem LIVRE escrita por pessoa não passa por aqui: a clínica continua
     * falando com o paciente.
     *
     * Os contatos são os conferidos NA APROVAÇÃO somados ao contato atual da
     * conversa (ADR-047 adendo 7 §9, G3.2). Esta checagem é a RÁPIDA, antes de
     * reservar; a garantia é a reconferência sob a guarda, no envio.
     */
    const contatosDoEnvio = [
      ...new Set(
        [...(dispatch.approvalContactIds ?? []), conversation.contactId].filter(
          (id): id is string => typeof id === 'string',
        ),
      ),
    ];
    // conversa sem contato: o desconhecido vai à porta como tal (`null`)
    const sujeitosDoEnvio = contatosDoEnvio.length > 0 ? contatosDoEnvio : [null];
    const origemDaIa = message.authorType === 'ai' || dispatch.fromAiProposal === true;
    /**
     * Religada desde o envio, nada sai — da IA ou de pessoa (ADR-052, revisão
     * da F4.1a): a resposta escrita para X pode esperar horas na fila, e a
     * conversa ter sido rejeitada no meio. Para a mensagem de pessoa, esta é a
     * conferência; para a da IA, a garantia é a reconferência sob a guarda.
     */
    if (religadaDesdeOEnvio(conversation, dispatch.approvalContactIds ?? [])) {
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: 'conversation_relinked',
      });
      return 'done';
    }
    if (origemDaIa) {
      const verdict = await this.restriction.check(workspaceId, 'ai', sujeitosDoEnvio);
      if (verdict.unavailable) {
        // porta fora do ar: não envia AGORA, mas a mensagem já aprovada não é
        // perdida — mesmo caminho de uma falha transitória do provedor
        if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
        await this.finish(messageId, dispatch.claimToken, 'failed_before_send', {
          errorCode: 'restriction_unavailable',
        });
        return 'retry';
      }
      if (verdict.restricted.some(Boolean)) {
        if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
        await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
          errorCode: 'content_restricted',
        });
        return 'done';
      }
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
    // pedido de parar pode ter chegado desde a criação. O despacho de template
    // ainda pendente vai a `failed_permanent` com `template_flow_unavailable`
    // (F4.1b): consentimento antigo não autoriza template
    const decision = await this.evaluate(
      workspaceId,
      conversation,
      dispatch.templateName !== null || dispatch.templateLanguage !== null,
    );
    if (!decision.allowed) {
      if (dispatch.reservationId) await this.usage.release(dispatch.reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: decision.reason,
      });
      return 'done';
    }

    /**
     * A reserva precisa estar VIVA antes da chamada. Duas razões para ela não
     * estar: uma tentativa anterior a liberou, ou o TTL (10 min) venceu antes de
     * o backoff do outbox (até 25 min) trazer o evento de volta — e nesse caso o
     * job de expurgo já devolveu o valor ao orçamento. Confiar num id morto
     * fazia a mensagem sair mesmo com o teto ocupado por outro uso, e a cobrança
     * acontecia DEPOIS do efeito externo.
     */
    let reservationId = dispatch.reservationId;
    if (reservationId && !(await this.usage.isReservationAlive(reservationId))) {
      /**
       * Expirada mas talvez NÃO expurgada: o TTL é de 10 min e a varredura roda
       * a cada 5, então há uma janela em que a reserva ainda ocupa +1 no
       * contador. Devolver antes de reservar de novo evita o absurdo de o envio
       * ser recusado pela própria vaga que ele já havia pago.
       */
      await this.usage.release(reservationId);
      reservationId = null;
    }
    if (!reservationId) {
      const nova = await this.usage.reserve(workspaceId, 'messages_sent', 1);
      if (nova === 'quota_exceeded') {
        // sem vaga no teto: NÃO chama o transporte. O envio é recusado antes de
        // existir, em vez de acontecer e ser cobrado fora do limite.
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
    // é o que impede outro worker de reenviar se morrermos na chamada. O da
    // mensagem de PESSOA sai sob o `address:` do número, relendo o pedido de
    // parar (F4.1b); o da IA, antes da guarda, que reconfere o pedido sob as
    // travas dela
    let marcou: 'marcou' | 'perdeu' | 'bloqueado';
    try {
      marcou = origemDaIa
        ? (
            await this.prisma.db.messageDispatch.updateMany({
              where: { messageId, claimToken: dispatch.claimToken, state: 'sending' },
              data: { dispatchedAt: new Date() },
            })
          ).count > 0
          ? 'marcou'
          : 'perdeu'
        : await this.marcarSobOEndereco(
            workspaceId,
            messageId,
            dispatch.claimToken,
            conversation.externalAddress as string,
          );
    } catch (erro) {
      // a trava do endereço não veio no prazo: nada saiu, e a nova tentativa
      // é do outbox — que relê tudo
      // só o tipo e o código: a mensagem de um erro do Prisma traria os
      // argumentos da chamada, e entre eles o número
      const { name, code } = (erro ?? {}) as { name?: string; code?: string };
      this.logger.warn(
        `Marcador do envio ${messageId} sem a trava do endereço (${name ?? 'Error'} ${code ?? 'sem código'})`,
      );
      await this.usage.release(reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_before_send', {
        errorCode: 'not_started',
      });
      return 'retry';
    }
    if (marcou === 'bloqueado') {
      await this.usage.release(reservationId);
      await this.finish(messageId, dispatch.claimToken, 'failed_permanent', {
        errorCode: 'stop_requested',
      });
      return 'done';
    }
    if (marcou === 'perdeu') {
      // perdemos a posse antes de despachar: quem tem a posse decide, e a
      // reserva desta tentativa é liberada em vez de ficar pendurada até o TTL
      this.logger.warn(`Lease de envio ${messageId} perdido antes do despacho`);
      await this.usage.release(reservationId);
      return 'done';
    }

    const token = this.crypto.decrypt(credential.tokenCipher);
    // só o texto livre passa pela política na transição da F4.1b
    const enviar = (signal?: AbortSignal): Promise<SendOutcome> =>
      this.transport.sendText(
        { phoneNumberId: credential.phoneNumberId, token },
        conversation.externalAddress as string,
        message.body,
        signal,
      );

    // a mensagem de origem da IA (editada ou não) é USO de conteúdo do
    // contato: sai sob a guarda
    if (origemDaIa) {
      return this.enviarSobGuarda(
        workspaceId,
        messageId,
        dispatch.claimToken,
        reservationId,
        {
          contatos: contatosDoEnvio,
          sujeitos: sujeitosDoEnvio,
          conversationId: conversation.id,
          contatosDaAprovacao: dispatch.approvalContactIds ?? [],
        },
        enviar,
      );
    }
    const outcome = await enviar();

    if (outcome.ok) {
      /**
       * Conclui PRIMEIRO, cobra depois. Cobrar antes permitia cobrança dupla:
       * um worker travado cobrava e, em paralelo, o reaper do lease vencido
       * cobrava de novo pela mesma mensagem. Quem não tem a posse não cobra.
       */
      const posse = await this.finish(messageId, dispatch.claimToken, 'sent', {
        externalId: outcome.externalId,
      });
      if (posse) await this.chargeOne(workspaceId, reservationId);
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
        await this.audit.record(this.prisma.db as Db, workspaceId, 'message.dispatch_lease_lost', {
          entityType: 'message',
          entityId: messageId,
          actor: { type: 'system', id: 'whatsapp-dispatcher' },
          // o wamid é o que permite a um humano achar a mensagem no provedor
          after: { externalId: outcome.externalId, direction: 'outbound' },
        });
      }
      return 'done';
    }

    const classe = classifyFailure(outcome.failure);
    const errorCode = String(outcome.failure.metaCode ?? outcome.failure.status ?? 'network');

    if (classe === 'ambiguous') {
      // pode ter sido despachada: não reenvia, encerra e COBRA — mas só se a
      // posse ainda for nossa, para não cobrar em dobro com o reaper
      const posse = await this.finish(messageId, dispatch.claimToken, 'unknown_after_dispatch', {
        errorCode,
      });
      if (posse) await this.chargeOne(workspaceId, reservationId);
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
   * A ESPECIFICAÇÃO do uso `ai_message_dispatch` (ADR-047 adendo 7 §9, G3.2),
   * registrada no Core antes de qualquer envio da IA existir: a origem é o
   * despacho daquela tentativa (`messageId` + `claimToken`), sem metadados. Em
   * dúvida, o despacho daquele `claimToken`, ainda `sending`, vai para
   * `unknown_after_dispatch` e NUNCA é reenviado. A reserva, o detector cobra
   * pelo teto; a referência dela sai do despacho para nenhuma varredura cobrar
   * de novo. A transação pode ser `raw` (ativação): `workspaceId` explícito.
   */
  onModuleInit(): void {
    this.origens.registrar('ai_message_dispatch', {
      origem: ['messageId', 'claimToken'],
      metadados: {},
      marcarIncerta: async (tx, uso) => {
        const origem = (uso.origin ?? {}) as Record<string, unknown>;
        if (typeof origem.messageId !== 'string' || typeof origem.claimToken !== 'string') return;
        await tx.messageDispatch.updateMany({
          where: {
            workspaceId: uso.workspaceId,
            messageId: origem.messageId,
            claimToken: origem.claimToken,
            state: 'sending',
          },
          data: {
            state: 'unknown_after_dispatch',
            errorCode: 'in_doubt',
            claimToken: null,
            leaseExpiresAt: null,
            reservationId: null,
          },
        });
      },
    });
  }

  /**
   * O envio da mensagem da IA SOB A GUARDA de uso externo (ADR-047 adendo 7 §9,
   * G3.2). O marcador de despacho já foi gravado (antes da guarda: entre a
   * prova de vida e o início não pode haver I/O). A guarda trava e reconfere os
   * contatos da APROVAÇÃO somados ao da conversa, registra o uso antes do
   * envio e conclui o despacho na transação dela. A reserva é entregue à
   * guarda: daqui em diante só ela e os detectores a acertam.
   */
  private async enviarSobGuarda(
    workspaceId: string,
    messageId: string,
    claimToken: string,
    reservationId: string,
    escopo: {
      contatos: string[];
      sujeitos: (string | null)[];
      conversationId: string;
      contatosDaAprovacao: readonly string[];
    },
    enviar: (signal: AbortSignal) => Promise<SendOutcome>,
  ): Promise<'done' | 'retry'> {
    // o desfecho que a Meta devolveu, guardado fora da guarda: se ela cair
    // depois do envio, o wamid ainda vai para o despacho incerto
    const visto: { iniciou: boolean; emDuvida: boolean; desfecho?: SendOutcome } = {
      iniciou: false,
      emDuvida: false,
    };
    let resultado: ResultadoDoUso<'done' | 'retry'>;
    // a reconferência viu a conversa religada, o número que não confere ou o
    // pedido de parar: o motivo é esse, não a restrição
    let recusa: 'conversation_relinked' | 'number_not_exact' | 'stop_requested' | null = null;
    try {
      // a linha do período precisa existir ANTES: a cobrança acima do teto, dentro
      // da transação da guarda, não pode criá-la
      await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
      resultado = await this.guarda.executar<SendOutcome, 'done' | 'retry'>({
        workspaceId,
        kind: 'ai_message_dispatch',
        contactIds: escopo.contatos,
        prazoMs: this.configDaGuarda.prazoDaMetaMs,
        origem: { messageId, claimToken },
        reservas: [reservationId],
        reconferir: async () => {
          // a conversa RELIDA sob as travas (ADR-052 item 2): religada depois
          // da aprovação, o rascunho foi escrito para outra pessoa
          const atual = await this.prisma.db.conversation.findFirst({
            where: { id: escopo.conversationId },
            select: { contactId: true, senderStatus: true, externalAddress: true },
          });
          if (!atual || religadaDesdeOEnvio(atual, escopo.contatosDaAprovacao)) {
            recusa = 'conversation_relinked';
            return 'restrito';
          }
          /**
           * O número EXATO, de novo, sob as travas: uma troca de telefone que
           * comitou depois da checagem rápida esperou a guarda até aqui, e o
           * rascunho não sai para um número que já não confere (revisão da
           * F4.1a). Sob a guarda, o escritor de telefone espera o contato.
           */
          if ((await this.remetenteDoEnvio(atual)) !== 'confere') {
            recusa = 'number_not_exact';
            return 'restrito';
          }
          /**
           * O pedido de parar, de novo, sob as travas (F4.1b): o despacho da IA
           * já tem o marcador quando chega aqui, e o pedido não o cancela —
           * quem o recusa é esta reconferência. O pedido trava os contatos do
           * número, que a guarda segura compartilhados.
           */
          if (await bloqueioAtivo(this.prisma.db, atual.externalAddress)) {
            recusa = 'stop_requested';
            return 'restrito';
          }
          const veredito = await this.restriction.check(workspaceId, 'ai', escopo.sujeitos);
          if (veredito.unavailable) return 'indisponivel';
          return veredito.restricted.some(Boolean) ? 'restrito' : 'liberado';
        },
        iniciar: async (signal) => {
          visto.iniciou = true;
          const desfecho = await enviar(signal);
          visto.desfecho = desfecho;
          // a guarda já respondeu "em dúvida" com o envio pendente (passou do
          // prazo): a resposta tardia não muda o desfecho, mas o wamid ainda
          // vai para o despacho incerto e para a trilha
          if (visto.emDuvida && desfecho.ok) {
            void this.guardarWamidIncerto(workspaceId, messageId, desfecho.externalId);
          }
          return desfecho;
        },
        persistir: (tx, desfecho) =>
          this.concluirSobGuarda(tx, workspaceId, messageId, claimToken, reservationId, desfecho),
        // a guarda voltou ao SAVEPOINT e cobrou a reserva pelo teto: o despacho
        // fica incerto, nunca reenviado — com o wamid, se a Meta o devolveu
        persistenciaFalhou: async (tx, desfecho) => {
          await this.finish(
            messageId,
            claimToken,
            'unknown_after_dispatch',
            {
              errorCode: 'persistence_failed',
              ...(!ehIncerto(desfecho) && desfecho.ok ? { externalId: desfecho.externalId } : {}),
            },
            tx,
          );
        },
      });
    } catch (erro) {
      /**
       * A guarda só lança ANTES de começar (depois do registro, a recuperação
       * nunca lança), e a linha do período falha antes dela. Nada saiu: o
       * marcador é limpo e a reserva volta já — sem isto, a varredura acharia o
       * despacho `sending` com marcador e o cobraria como incerto.
       */
      if (visto.iniciou) throw erro;
      await this.usage.release(reservationId);
      await this.finish(messageId, claimToken, 'failed_before_send', { errorCode: 'not_started' });
      throw erro;
    }
    switch (resultado.tipo) {
      case 'concluido':
        return resultado.persistido ? (resultado.valor ?? 'done') : 'done';
      case 'em_duvida':
        // o tratador de origem levou (ou a reconciliação levará) o despacho a
        // `unknown_after_dispatch`; o wamid conhecido fica nele e na trilha (o
        // que chegar depois, pelo próprio envio, acima)
        visto.emDuvida = true;
        if (visto.desfecho?.ok) {
          await this.guardarWamidIncerto(workspaceId, messageId, visto.desfecho.externalId);
        }
        return 'done';
      case 'nao_comecou':
        // nada saiu e a guarda devolveu a reserva
        if (resultado.motivo === 'restrito') {
          // o marcador sai: a mensagem comprovadamente não foi despachada
          await this.finish(messageId, claimToken, 'failed_permanent', {
            errorCode: recusa ?? 'content_restricted',
            naoSaiu: true,
          });
          return 'done';
        }
        // porta indisponível, trava, sessão, registro, prova de vida, prazo: a
        // chamada não começou — a nova tentativa é do OUTBOX, um uso novo que
        // passa pela guarda e reconfere
        await this.finish(messageId, claimToken, 'failed_before_send', {
          errorCode:
            resultado.motivo === 'indisponivel' ? 'restriction_unavailable' : 'not_started',
        });
        return 'retry';
    }
  }

  /**
   * A Meta devolveu o wamid, mas a guarda caiu antes de concluir: o despacho
   * fica incerto (nunca reenviado), e o wamid vai para ele e para a trilha — é
   * o que permite a quem triar achar a mensagem no provedor, e aos recibos de
   * entrega chegarem a ela. Só preenche um `externalId` vazio, e só então
   * audita: sem linha atualizada, a guarda comitou `sent` com o wamid antes de
   * cair, e a trilha não pode dizer "em dúvida". Uma falha aqui não muda o
   * desfecho, que já é `done`.
   */
  private async guardarWamidIncerto(
    workspaceId: string,
    messageId: string,
    externalId: string,
  ): Promise<void> {
    try {
      const { count } = await this.prisma.db.messageDispatch.updateMany({
        where: {
          messageId,
          externalId: null,
          state: { in: ['sending', 'unknown_after_dispatch'] },
        },
        data: { externalId },
      });
      if (count === 0) return;
      await this.audit.record(this.prisma.db as Db, workspaceId, 'message.dispatch_in_doubt', {
        entityType: 'message',
        entityId: messageId,
        actor: { type: 'system', id: 'whatsapp-dispatcher' },
        after: { externalId, direction: 'outbound' },
      });
    } catch (erro) {
      this.logger.error(
        `Wamid do envio incerto ${messageId} não registrado (${erro instanceof Error ? erro.name : 'erro'})`,
      );
    }
  }

  /**
   * NA transação da guarda: o desfecho do envio vira estado do despacho, com
   * fencing pelo `claimToken`, e a reserva é acertada junto. Ambíguo,
   * abortado pelo prazo ou exceção depois de começar: `unknown_after_dispatch`,
   * cobrado, e nunca reenviado.
   */
  private async concluirSobGuarda(
    tx: Db,
    workspaceId: string,
    messageId: string,
    claimToken: string,
    reservationId: string,
    desfecho: SendOutcome | DesfechoIncerto,
  ): Promise<'done' | 'retry'> {
    const cobrar = async () => {
      if (await this.usage.settleWithin(tx, workspaceId, reservationId, 1)) return;
      // a reserva sumiu (adendo 6 §5): o gasto aconteceu, cobra acima do teto
      await this.usage.consumeOverLimit(tx, workspaceId, 'messages_sent', 1);
    };
    if (ehIncerto(desfecho)) {
      const posse = await this.finish(
        messageId,
        claimToken,
        'unknown_after_dispatch',
        { errorCode: 'uncertain' },
        tx,
      );
      if (posse) await cobrar();
      return 'done';
    }
    if (desfecho.ok) {
      const posse = await this.finish(
        messageId,
        claimToken,
        'sent',
        { externalId: desfecho.externalId },
        tx,
      );
      if (posse) {
        await cobrar();
      } else {
        // perdemos a posse DEPOIS de enviar: não sobrescreve quem assumiu; o
        // fato vai para a trilha (o wamid permite achar a mensagem no provedor)
        this.logger.error(
          `Lease de envio ${messageId} perdido após despacho bem-sucedido (${desfecho.externalId})`,
        );
        await this.audit.record(tx, workspaceId, 'message.dispatch_lease_lost', {
          entityType: 'message',
          entityId: messageId,
          actor: { type: 'system', id: 'whatsapp-dispatcher' },
          after: { externalId: desfecho.externalId, direction: 'outbound' },
        });
      }
      return 'done';
    }
    const classe = classifyFailure(desfecho.failure);
    const errorCode = String(desfecho.failure.metaCode ?? desfecho.failure.status ?? 'network');
    if (classe === 'ambiguous') {
      const posse = await this.finish(
        messageId,
        claimToken,
        'unknown_after_dispatch',
        { errorCode },
        tx,
      );
      if (posse) await cobrar();
      this.logger.warn(`Envio ${messageId} incerto (${errorCode}) — aguardando resolução humana`);
      return 'done';
    }
    // comprovadamente ANTES do envio: a reserva volta
    await this.usage.releaseWithin(tx, workspaceId, reservationId);
    if (classe === 'permanent') {
      await this.finish(messageId, claimToken, 'failed_permanent', { errorCode }, tx);
      return 'done';
    }
    await this.finish(messageId, claimToken, 'failed_before_send', { errorCode }, tx);
    return 'retry';
  }

  /**
   * Cobra UMA mensagem. Se a reserva já foi expurgada por TTL, o gasto ainda
   * aconteceu — cobra direto, sem barrar. Confiar no `settle` silencioso deixava
   * envio sem cobrança e o teto sem valer para retentativa.
   */
  private async chargeOne(
    workspaceId: string,
    reservationId: string,
    // o despacho que uma VARREDURA acabou de marcar incerto (para a triagem)
    messageId?: string,
  ): Promise<void> {
    const liquidada = await this.usage.settle(workspaceId, reservationId, 'messages_sent', 1);
    if (liquidada) return;
    /**
     * A reserva de um envio da IA, depois do registro do uso, é da GUARDA
     * (ADR-047 adendo 7 §9, G3.2): ela a acerta na própria transação, e um
     * detector a cobra pelo teto ao marcar o uso em dúvida. A varredura de
     * reservas não a devolve enquanto o uso está `authorized`. Sumida e listada
     * num uso, já foi decidida por eles: cobrar aqui seria a SEGUNDA cobrança
     * da mesma mensagem (a varredura comitou o despacho incerto, o detector
     * cobrou pelo teto, e esta liquidação chegou depois). A pergunta é da
     * guarda: fora de `content-use/`, ninguém lê `ContentUse`.
     */
    const situacao = await this.guarda.situacaoDaReserva(workspaceId, reservationId);
    if (situacao === 'nao_comecou') {
      /**
       * Todo uso que lista a reserva foi `aborted`: a guarda PROVOU que a
       * chamada não começou e devolveu a reserva. Nada a cobrar; e o despacho
       * que a varredura acabou de marcar incerto é reescrito para a triagem
       * distinguir "não saiu" de "entrega desconhecida" (limite aceito em
       * 2026-10-21): o estado fica, sem reenvio automático.
       */
      if (messageId) await this.marcarNaoSaiu(messageId);
      return;
    }
    if (situacao === 'decidida') {
      this.logger.warn(
        `Reserva ${reservationId} já acertada pela guarda de uso — sem nova cobrança`,
      );
      return;
    }
    // a linha do PERÍODO pode não existir (reserva de 31/08 liquidada em
    // 01/09): sem isto o `applyDelta` lançaria DEPOIS do efeito externo
    await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction((tx) => this.usage.consumeOverLimit(tx, workspaceId, 'messages_sent', 1));
  }

  /**
   * O despacho que uma varredura marcou incerto, mas que a guarda provou NÃO
   * ter saído (uso `aborted`): código próprio e marcador limpo, para a triagem
   * não confundi-lo com uma entrega desconhecida. Só reescreve o que as
   * varreduras escreveram — nunca um incerto decidido pela guarda ou pelo
   * provedor. `unknown_after_dispatch` não é elegível ao claim, com ou sem
   * marcador: nada é reenviado.
   */
  private async marcarNaoSaiu(messageId: string): Promise<void> {
    const { count } = await this.prisma.db.messageDispatch.updateMany({
      where: {
        messageId,
        state: 'unknown_after_dispatch',
        errorCode: { in: [...CODIGOS_EM_VOO_DAS_VARREDURAS] },
      },
      data: { errorCode: 'not_sent_guard_aborted', dispatchedAt: null },
    });
    if (count > 0) {
      this.logger.warn(
        `Envio ${messageId} não saiu (a guarda abortou antes) — incerto para triagem, sem cobrança`,
      );
    }
  }

  /**
   * Linha em voo, com marcador de despacho e lease vencido: chamamos a Meta e
   * não soubemos o resultado. Vai para `unknown_after_dispatch` com a quota
   * cobrada — nunca de volta para envio (ADR-039).
   */
  private async resolveAbandonedInFlight(workspaceId: string, messageId: string): Promise<boolean> {
    // `raw` justificado: UPDATE condicional com RETURNING (a decisão depende do
    // estado lido no MESMO comando). `workspaceId` explícito no WHERE.
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
      await this.chargeOne(workspaceId, abandonada.reservationId, messageId);
    } else {
      await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
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
   * O evento morreu no outbox (tentativas esgotadas): não haverá retentativa, e
   * deixar o dispatch em `failed_before_send` seria um estado que MENTE — o nome
   * promete uma retentativa que não vem.
   *
   * Roda no contexto do workspace da mensagem: o dispatcher do outbox é
   * cross-workspace, e sem isto o client protegido barraria a escrita (a
   * exceção era engolida pelo dispatcher e o dispatch ficava mentindo mesmo).
   */
  async markExhausted(workspaceId: string, messageId: string): Promise<void> {
    /**
     * UM comando, decidido inteiramente pelo BANCO.
     *
     * A versão anterior lia a linha, decidia em JS e escrevia — e comparava
     * `leaseExpiresAt` com `new Date()` do processo, enquanto o claim e a
     * varredura comparam com `now()` do Postgres. Com o app adiantado, um lease
     * VIVO parecia vencido e esta rotina rebaixava o despacho debaixo do dono:
     * ele enviava, perdia o fencing, e a mensagem entregue aparecia como "não
     * enviada". Com o app atrasado, o oposto — nada era encerrado.
     *
     * `raw` justificado: só em SQL a elegibilidade e a escrita usam o mesmo
     * relógio, num único statement atômico. `workspaceId` explícito no WHERE.
     */
    const [linha] = await this.prisma.raw.$queryRawUnsafe<
      { reservationId: string | null; despachou: boolean }[]
    >(
      /**
       * O `reservationId` ANTIGO vem de uma CTE que lê e TRAVA a linha antes do
       * UPDATE. `RETURNING` entrega valores PÓS-escrita, então devolver a coluna
       * que o próprio comando zera daria sempre `null` — e a liquidação perderia
       * a reserva, deixando-a pendurada até o TTL. É o mesmo defeito que
       * `resolveAbandonedInFlight` já tinha evitado; reintroduzi ao reescrever.
       *
       * `FOR UPDATE` na CTE garante que ninguém mude o estado entre a leitura da
       * reserva e a escrita — a decisão continua sendo de um único comando.
       */
      `WITH alvo AS (
         SELECT "messageId",
                "reservationId" AS "reservaAntiga",
                ("dispatchedAt" IS NOT NULL) AS "despachou"
           FROM "MessageDispatch"
          WHERE "workspaceId" = $1::uuid
            AND "messageId" = $2::uuid
            AND ("state" IN ('reserved', 'failed_before_send')
                 OR ("state" = 'sending' AND "leaseExpiresAt" < now()))
          FOR UPDATE
       )
       UPDATE "MessageDispatch" AS d
          SET "state" = CASE WHEN alvo."despachou"
                             THEN 'unknown_after_dispatch'::"DispatchState"
                             ELSE 'failed_permanent'::"DispatchState" END,
              "errorCode" = CASE WHEN alvo."despachou"
                                 THEN 'retries_exhausted_in_flight'
                                 ELSE 'retries_exhausted' END,
              "claimToken" = NULL,
              "leaseExpiresAt" = NULL,
              "reservationId" = NULL,
              "updatedAt" = now()
         FROM alvo
        WHERE d."messageId" = alvo."messageId"
      RETURNING alvo."reservaAntiga" AS "reservationId", alvo."despachou" AS "despachou"`,
      workspaceId,
      messageId,
    );
    if (!linha) return; // nada elegível: o dono vivo decide

    await this.cls.run(async () => {
      this.cls.set('workspaceId', workspaceId);
      await this.settleQuotaFor(workspaceId, messageId, linha.reservationId, linha.despachou);
    });
    if (linha.despachou) {
      this.logger.error(`Envio ${messageId} esgotou tentativas em voo — marcado incerto`);
    }
  }

  /**
   * Fecha a quota de um dispatch encerrado à força: cobra se pode ter saído,
   * devolve se provadamente não saiu. Sem isto a reserva ficaria pendurada até
   * o TTL, encolhendo o teto de quem não gastou nada.
   */
  private async settleQuotaFor(
    workspaceId: string,
    messageId: string,
    reservationId: string | null,
    despachou: boolean,
  ): Promise<void> {
    if (!reservationId) return;
    if (despachou) await this.chargeOne(workspaceId, reservationId, messageId);
    else await this.usage.release(reservationId);
  }

  /**
   * Varredura de dispatches abandonados: worker que morreu de forma que nem o
   * dispatcher percebeu (exceção entre o claim e a conclusão, processo morto).
   * É o consumidor do índice `(state, leaseExpiresAt)`, sem o qual a linha
   * ficaria `sending` para sempre e a mensagem sumiria em silêncio.
   *
   * O DESFECHO respeita quem ainda pode tentar:
   *  - COM marcador de despacho → `unknown_after_dispatch` e cobra: pode ter
   *    saído, e nunca reenviamos por conta própria (ADR-039).
   *  - sem marcador, com evento do outbox VIVO → `failed_before_send`, que é
   *    elegível ao claim: a retentativa legítima ainda vem (o backoff do outbox
   *    chega a horas, muito além deste limiar). Enterrar como `failed_permanent`
   *    matava a entrega — o mesmo dano do `lost` tratado como `dead`.
   *  - sem marcador e sem evento vivo → `failed_permanent`: ninguém mais tenta.
   *
   * `raw` justificado: varredura cross-workspace (SECURITY.md §2) com UPDATE
   * condicional e RETURNING; o workspaceId de cada linha é usado explicitamente
   * na quota, dentro do CLS.
   */
  async reapStaleDispatches(limit = 50): Promise<number> {
    const abandonadas = await this.prisma.raw.$queryRawUnsafe<
      {
        messageId: string;
        workspaceId: string;
        reservationId: string | null;
        despachou: boolean;
      }[]
    >(
      /**
       * O predicado é REPETIDO no WHERE externo, não só na subquery. Em READ
       * COMMITTED, quando este UPDATE bloqueia numa linha que outra transação
       * alterou, o Postgres refaz a qualificação contra a versão nova — mas a
       * subquery é reavaliada no snapshot ORIGINAL, que ainda vê `sending`.
       * Sem o predicado externo, a varredura sobrescrevia um `sent` acabado de
       * comitar: mensagem entregue aparecendo como "Não enviada", com reenvio
       * manual e cobrança em dobro. `SKIP LOCKED` evita que duas varreduras
       * disputem a mesma linha.
       */
      `UPDATE "MessageDispatch" AS d
          SET "state" = CASE
                WHEN d."dispatchedAt" IS NOT NULL THEN 'unknown_after_dispatch'::"DispatchState"
                WHEN EXISTS (
                  SELECT 1 FROM "OutboxEvent" e
                   WHERE e."workspaceId" = d."workspaceId"
                     AND e."dedupeKey" = 'whatsapp.send_pending:' || d."messageId"::text
                     AND e."status" IN ('pending', 'processing')
                ) THEN 'failed_before_send'::"DispatchState"
                ELSE 'failed_permanent'::"DispatchState" END,
              "errorCode" = CASE
                WHEN d."dispatchedAt" IS NOT NULL THEN 'abandoned_in_flight'
                ELSE 'abandoned_before_send' END,
              "claimToken" = NULL,
              "leaseExpiresAt" = NULL,
              "updatedAt" = now()
        WHERE d."messageId" IN (
                SELECT "messageId" FROM "MessageDispatch"
                 WHERE "state" = 'sending'
                   AND "leaseExpiresAt" < now() - ($1::int * interval '1 minute')
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
              )
          AND d."state" = 'sending'
          AND d."leaseExpiresAt" < now() - ($1::int * interval '1 minute')
      RETURNING d."messageId", d."workspaceId", d."reservationId",
                (d."dispatchedAt" IS NOT NULL) AS "despachou"`,
      REAP_AFTER_MINUTES,
      limit,
    );
    for (const linha of abandonadas) {
      // a varredura é cross-workspace, mas a QUOTA não: entra no contexto de
      // cada linha para que o ajuste passe pelo client protegido, como faria o
      // worker que morreu
      await this.cls.run(async () => {
        this.cls.set('workspaceId', linha.workspaceId);
        await this.settleQuotaFor(
          linha.workspaceId,
          linha.messageId,
          linha.reservationId,
          linha.despachou,
        );
        await this.prisma.db.messageDispatch.updateMany({
          // SÓ a reserva que liquidamos: entre o UPDATE e este laço, um worker
          // legítimo pode ter reivindicado a linha e escrito uma reserva NOVA —
          // apagá-la cegamente repetiria a perda de referência que saiu do claim
          where: { messageId: linha.messageId, reservationId: linha.reservationId },
          data: { reservationId: null },
        });
      });
    }
    const orfaos = await this.reapUnretriable();
    if (abandonadas.length > 0 || orfaos > 0) {
      this.logger.error(
        `${abandonadas.length} envio(s) abandonado(s) e ${orfaos} sem retentador resolvidos pela varredura`,
      );
    }
    return abandonadas.length + orfaos;
  }

  /**
   * `failed_before_send` e `reserved` prometem uma retentativa. Quando o evento
   * do outbox que a faria não existe mais — morreu, ou fechou como entregue enquanto um worker
   * travado perdia a posse —, a promessa é falsa e a linha ficaria para sempre
   * exibindo "aguardando nova tentativa" sem ninguém que possa tentar. Este é o
   * mesmo defeito de "estado que mente" pelo outro lado.
   *
   * `reserved` entra pelo mesmo motivo: se `dispatch` lançar ANTES do claim em
   * todas as tentativas, o dispatcher nunca chama `markExhausted` e a linha fica
   * exibindo "Enviando…" para sempre.
   *
   * Só linhas PARADAS há mais que o limiar, para não confundir a janela normal
   * entre concluir o dispatch e o outbox reprogramar o evento.
   *
   * `raw` justificado: varredura cross-workspace (SECURITY.md §2); o
   * workspaceId de cada linha é usado explicitamente na liquidação.
   */
  private async reapUnretriable(): Promise<number> {
    const orfaos = await this.prisma.raw.$queryRawUnsafe<
      { messageId: string; workspaceId: string; reservationId: string | null }[]
    >(
      `UPDATE "MessageDispatch" AS d
          SET "state" = 'failed_permanent'::"DispatchState",
              "errorCode" = 'no_retrier',
              "updatedAt" = now()
        WHERE d."messageId" IN (
                SELECT "messageId" FROM "MessageDispatch"
                 WHERE "state" IN ('failed_before_send', 'reserved')
                   AND "updatedAt" < now() - ($1::int * interval '1 minute')
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
              )
          AND d."state" IN ('failed_before_send', 'reserved')
          AND d."updatedAt" < now() - ($1::int * interval '1 minute')
          AND NOT EXISTS (
                SELECT 1 FROM "OutboxEvent" e
                 WHERE e."workspaceId" = d."workspaceId"
                   AND e."dedupeKey" = 'whatsapp.send_pending:' || d."messageId"::text
                   AND e."status" IN ('pending', 'processing')
              )
      RETURNING d."messageId", d."workspaceId", d."reservationId"`,
      REAP_AFTER_MINUTES,
      50,
    );
    for (const linha of orfaos) {
      await this.cls.run(async () => {
        this.cls.set('workspaceId', linha.workspaceId);
        // nada foi despachado neste estado: a quota volta
        await this.settleQuotaFor(linha.workspaceId, linha.messageId, linha.reservationId, false);
        await this.prisma.db.messageDispatch.updateMany({
          where: { messageId: linha.messageId, reservationId: linha.reservationId },
          data: { reservationId: null },
        });
      });
    }
    return orfaos.length;
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
    extra: { errorCode?: string; externalId?: string; naoSaiu?: boolean } = {},
    // a transação da guarda, no envio da IA; senão, o client protegido
    db: Db = this.prisma.db,
  ): Promise<boolean> {
    const { count } = await db.messageDispatch.updateMany({
      where: { messageId, claimToken, state: 'sending' },
      data: {
        state: state as never,
        claimToken: null,
        leaseExpiresAt: null,
        reservationId: null,
        /**
         * O marcador é zerado APENAS em `failed_before_send`, o único estado que
         * volta a ser elegível ao claim: herdado por uma tentativa nova, ele
         * mentia — morrer antes de chamar viraria `unknown_after_dispatch` com
         * cobrança de mensagem que provadamente nunca saiu.
         *
         * Nos estados terminais o marcador FICA: é o instante do despacho, e é
         * dele que depende quem for triar a fila de casos incertos depois. A
         * exceção é `naoSaiu`: a guarda provou que o envio não começou (o
         * marcador da IA vem antes dela), e manter o marcador mentiria.
         */
        ...(state === 'failed_before_send' || extra.naoSaiu ? { dispatchedAt: null } : {}),
        ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
        ...(extra.externalId !== undefined ? { externalId: extra.externalId } : {}),
      },
    });
    return count > 0;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * O REMETENTE diante do envio (ADR-052 item 2, decisões de 2026-10-23). A
   * conversa RAI não recebe resposta: a pessoa identifica antes de responder.
   * A identificada só recebe com o número do cadastro do contato de forma
   * EXATA — a forma normalizada igual, ou o mesmo número internacional com
   * "+". A coincidência só possível (sem DDD, o 9º dígito, a forma ainda não
   * preenchida) não autoriza envio, nem quando foi uma pessoa que identificou.
   * É o MESMO predicado no compositor (`sendPolicy`), no envio, na aprovação do
   * rascunho e no worker — nunca uma segunda cópia (ADR-038).
   */
  async remetenteDoEnvio(conversation: {
    contactId: string | null;
    senderStatus: string;
    externalAddress: string | null;
  }): Promise<RemetenteDoEnvio> {
    if (conversation.senderStatus === 'unidentified') return 'a_identificar';
    // sem número, a política recusa adiante (`no_external_address`)
    if (!conversation.externalAddress) return 'confere';
    // identificada, com número e sem contato: nada com que conferir (fail-closed)
    if (!conversation.contactId) return 'numero_nao_confere';
    const contato = (await this.prisma.db.contact.findFirst({
      where: { id: conversation.contactId },
      select: { phones: true, phonesNormalized: true },
    })) as unknown as { phones: string[]; phonesNormalized: string[] } | null;
    if (!contato) return 'numero_nao_confere';
    return coincideExatamente(conversation.externalAddress, contato)
      ? 'confere'
      : 'numero_nao_confere';
  }

  private async evaluate(
    workspaceId: string,
    conversation: {
      id: string;
      channelId: string;
      contactId: string | null;
      senderStatus: string;
      lastInboundAt: Date | null;
      externalAddress: string | null;
    },
    templatePedido: boolean,
  ): Promise<SendDecision> {
    /**
     * O consentimento da 9.1 (`ContactChannelConsent`) não autoriza mais nada:
     * é histórico (C7). O template é indisponível na transição, e o pedido de
     * parar é conferido por (workspace, número), em qualquer canal (F4.1b).
     */
    return decideSend({
      lastInboundAt: conversation.lastInboundAt,
      remetente: await this.remetenteDoEnvio(conversation),
      bloqueado: (await bloqueioAtivo(this.prisma.db, conversation.externalAddress)) !== null,
      templatePedido,
      externalAddress: conversation.externalAddress,
      now: new Date(),
    });
  }

  private async loadConversation(id: string): Promise<{
    id: string;
    channelId: string;
    contactId: string | null;
    senderStatus: string;
    lastInboundAt: Date | null;
    externalAddress: string | null;
  }> {
    const row = (await this.prisma.db.conversation.findFirst({
      where: { id },
      select: {
        id: true,
        channelId: true,
        contactId: true,
        senderStatus: true,
        lastInboundAt: true,
        externalAddress: true,
      },
    })) as unknown as {
      id: string;
      channelId: string;
      contactId: string | null;
      senderStatus: string;
      lastInboundAt: Date | null;
      externalAddress: string | null;
    } | null;
    if (!row) throw new NotFoundException('Conversa não encontrada');
    return row;
  }

  private explain(reason: string): string {
    switch (reason) {
      case 'window_closed_needs_template':
        return `A janela de 24h fechou. ${MENSAGEM_TEMPLATE_INDISPONIVEL}`;
      case 'template_flow_unavailable':
        return MENSAGEM_TEMPLATE_INDISPONIVEL;
      case 'stop_requested':
        return MENSAGEM_PEDIDO_DE_PARAR;
      case 'no_external_address':
        return 'Conversa sem endereço externo: não há destinatário para o envio';
      case 'sender_unidentified':
        return MENSAGEM_REMETENTE_A_IDENTIFICAR;
      case 'number_not_exact':
        return MENSAGEM_NUMERO_NAO_CONFERE;
      default:
        return 'Envio não permitido pela política do canal';
    }
  }
}

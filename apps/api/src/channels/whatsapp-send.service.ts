import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
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

/**
 * Só é considerado abandonado o que está parado há MUITO mais que o lease do
 * outbox (5 min): abaixo disso o caminho normal — outro worker reassume o
 * evento — ainda está em curso, e a varredura só atrapalharia. O desfecho
 * consulta o outbox justamente porque o backoff dele chega a horas.
 */
const REAP_AFTER_MINUTES = 15;

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
    private readonly audit: AuditService,
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
      }[]
    >(
      `UPDATE "MessageDispatch"
          SET "state" = 'sending',
              "claimToken" = gen_random_uuid(),
              "leaseExpiresAt" = now() + ($3::int * interval '1 millisecond'),
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
    // é o que impede outro worker de reenviar se morrermos na chamada
    const marcou = await this.prisma.db.messageDispatch.updateMany({
      where: { messageId, claimToken: dispatch.claimToken, state: 'sending' },
      data: { dispatchedAt: new Date() },
    });
    if (marcou.count === 0) {
      // perdemos a posse antes de despachar: quem tem a posse decide, e a
      // reserva desta tentativa é liberada em vez de ficar pendurada até o TTL
      this.logger.warn(`Lease de envio ${messageId} perdido antes do despacho`);
      await this.usage.release(reservationId);
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
   * Cobra UMA mensagem. Se a reserva já foi expurgada por TTL, o gasto ainda
   * aconteceu — cobra direto, sem barrar. Confiar no `settle` silencioso deixava
   * envio sem cobrança e o teto sem valer para retentativa.
   */
  private async chargeOne(workspaceId: string, reservationId: string): Promise<void> {
    const liquidada = await this.usage.settle(workspaceId, reservationId, 'messages_sent', 1);
    if (!liquidada) {
      // a linha do PERÍODO pode não existir (reserva de 31/08 liquidada em
      // 01/09): sem isto o `applyDelta` lançaria DEPOIS do efeito externo
      await this.usage.ensureCounterRow(workspaceId, 'messages_sent');
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
      await this.chargeOne(workspaceId, abandonada.reservationId);
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
    await this.cls.run(async () => {
      this.cls.set('workspaceId', workspaceId);
      const agora = new Date();
      /**
       * `sending` só é elegível se o lease NÃO estiver vivo — a mesma guarda do
       * claim e da varredura. Sem ela, um evento que morre enquanto OUTRO worker
       * detém a posse fazia esta rotina sobrescrever `failed_permanent` debaixo
       * dele: o worker enviava, perdia o fencing e a mensagem entregue aparecia
       * como "Não enviada", convidando ao reenvio manual.
       */
      const posseLivre = {
        OR: [
          { state: { in: ['reserved', 'failed_before_send'] as never } },
          { state: 'sending' as never, leaseExpiresAt: { lt: agora } },
        ],
      };
      const linha = await this.prisma.db.messageDispatch.findFirst({
        where: { messageId, ...posseLivre },
        select: { state: true, dispatchedAt: true, reservationId: true },
      });
      if (!linha) return;

      const despachou = linha.dispatchedAt !== null;
      /**
       * A GUARDA VAI NO `where`, não em JS: entre a leitura e a escrita o estado
       * pode mudar (varredura concorrente, ou dono vivo concluindo), e escrever
       * por `messageId` puro sobrescreveria um estado terminal já cobrado — a
       * mesma mentira de entrega que a varredura permeável causava. Se não
       * escrevermos nada, não liquidamos quota nenhuma.
       */
      const { count } = await this.prisma.db.messageDispatch.updateMany({
        where: {
          messageId,
          ...posseLivre,
          ...(despachou ? { dispatchedAt: { not: null } } : { dispatchedAt: null }),
        },
        data: {
          // COM marcador de despacho pode ter saído: nunca "não enviou"
          state: despachou ? 'unknown_after_dispatch' : 'failed_permanent',
          errorCode: despachou ? 'retries_exhausted_in_flight' : 'retries_exhausted',
          claimToken: null,
          leaseExpiresAt: null,
          reservationId: null,
        },
      });
      if (count === 0) return; // outro dono decidiu antes: nada a liquidar
      await this.settleQuotaFor(workspaceId, linha.reservationId, despachou);
      if (despachou) {
        this.logger.error(`Envio ${messageId} esgotou tentativas em voo — marcado incerto`);
      }
    });
  }

  /**
   * Fecha a quota de um dispatch encerrado à força: cobra se pode ter saído,
   * devolve se provadamente não saiu. Sem isto a reserva ficaria pendurada até
   * o TTL, encolhendo o teto de quem não gastou nada.
   */
  private async settleQuotaFor(
    workspaceId: string,
    reservationId: string | null,
    despachou: boolean,
  ): Promise<void> {
    if (!reservationId) return;
    if (despachou) await this.chargeOne(workspaceId, reservationId);
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
              "leaseExpiresAt" = NULL
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
        await this.settleQuotaFor(linha.workspaceId, linha.reservationId, linha.despachou);
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
   * `failed_before_send` promete uma retentativa. Quando o evento do outbox que
   * a faria não existe mais — morreu, ou fechou como entregue enquanto um worker
   * travado perdia a posse —, a promessa é falsa e a linha ficaria para sempre
   * exibindo "aguardando nova tentativa" sem ninguém que possa tentar. Este é o
   * mesmo defeito de "estado que mente" pelo outro lado.
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
              "errorCode" = 'no_retrier'
        WHERE d."messageId" IN (
                SELECT "messageId" FROM "MessageDispatch"
                 WHERE "state" = 'failed_before_send'
                   AND "updatedAt" < now() - ($1::int * interval '1 minute')
                 LIMIT $2
                 FOR UPDATE SKIP LOCKED
              )
          AND d."state" = 'failed_before_send'
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
        await this.settleQuotaFor(linha.workspaceId, linha.reservationId, false);
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
    extra: { errorCode?: string; externalId?: string } = {},
  ): Promise<boolean> {
    const { count } = await this.prisma.db.messageDispatch.updateMany({
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
         * dele que depende quem for triar a fila de casos incertos depois.
         */
        ...(state === 'failed_before_send' ? { dispatchedAt: null } : {}),
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

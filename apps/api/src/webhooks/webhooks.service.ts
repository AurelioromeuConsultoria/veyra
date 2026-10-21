import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { CreateWebhookInput, UpdateWebhookInput, WebhookDto } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/decorators';
import { CryptoService } from '../common/crypto.service';
import {
  ContentUseGuard,
  ehIncerto,
  type DesfechoIncerto,
  type Veredito,
} from '../content-use/content-use.guard';
import { OrigensDosUsos } from '../content-use/content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../content-use/content-use.pools';
import {
  ContentRestrictionService,
  type RestrictionSubject,
} from '../extensions/content-restriction';
import { PrismaService, type Db } from '../prisma/prisma.service';
import {
  INTERNAL_EVENT_TYPES,
  MAX_ATTEMPTS,
  OutboxService,
  type ClaimedEvent,
} from '../outbox/outbox.service';
import { resolveEventScope } from '../outbox/event-subjects';
import { UnsafeUrlError, assertSafeWebhookUrl, type SafeFetchResult } from './safe-http';

/**
 * TRANSPORTE INJETÁVEL (test seam, padrão do ADR-011 do Norteie): produção usa
 * `safePost` (https.request com IP pinado); testes de integração injetam um
 * fake, para que a suíte não dependa de DNS/rede real — a defesa SSRF em si é
 * coberta pelos testes unitários de `safe-http`.
 */
export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');
export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
  /** o prazo ABSOLUTO da guarda (10 s, DNS incluído): aborta a entrega */
  signal?: AbortSignal,
) => Promise<SafeFetchResult>;

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/** 3 ENTREGAS MORTAS consecutivas pausam o webhook (ajuste #7). */
const DEAD_DELIVERIES_TO_PAUSE = 3;

/**
 * Teto de destinos por workspace. O fan-out é sequencial: cada destino é uma
 * guarda (espera por sessão, travas, registro e o POST no prazo de 10 s), e o
 * heartbeat renova a posse do evento ANTES de cada um — nenhum evento perde a
 * posse por lentidão, e cada destino cabe com folga no lease de 5 min.
 */
const MAX_WEBHOOKS_PER_WORKSPACE = 20;

/**
 * Teto do número da tentativa nos metadados do uso. Não é `MAX_ATTEMPTS`: um
 * evento cuja posse venceu (worker morto) é reassumido e conta tentativa sem
 * passar por `markFailed`, então o número pode passar dele. Formato estrito,
 * com folga.
 */
const TENTATIVA_MAXIMA_NO_REGISTRO = 100;

/**
 * De quem é o evento (ADR-047 adendo 2 e adendo 7 §9, G3.3): o conjunto de
 * travas do uso de webhook e o que vai à porta.
 */
type EscopoDoEvento = {
  /** os contatos conhecidos — as travas de contato */
  contatos: string[];
  /** `deal:<id>` e `task:<id>` — as travas de entidade */
  entidades: string[];
  /** o que vai à porta: os contatos e, se houver, o desconhecido (`null`) */
  sujeitos: RestrictionSubject[];
};

/** O que um destino deu, sob a guarda. */
type DesfechoDoDestino =
  /** 2xx */
  | { tipo: 'entregue' }
  /** falha DO DESTINO: retentativa pelo outbox e penalidade de entrega morta */
  | { tipo: 'falhou'; erro: string }
  /** restrição: nada sai para nenhum destino mais */
  | { tipo: 'suprimido' }
  /** falha DO EVENTO (não começou, em dúvida): sem penalizar o destino */
  | { tipo: 'evento'; motivo: string };

type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  status: 'active' | 'paused' | 'disabled';
  failureCount: number;
  secretCipher: string;
  createdAt: Date;
};

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    private readonly restriction: ContentRestrictionService,
    private readonly guarda: ContentUseGuard,
    private readonly origens: OrigensDosUsos,
    private readonly cls: ClsService,
    @Inject(CONFIG_DA_GUARDA) private readonly configDaGuarda: ConfigDaGuarda,
  ) {}

  /**
   * A ESPECIFICAÇÃO do uso `webhook_delivery` (ADR-047 adendo 7 §9, G3.3),
   * registrada no Core antes de qualquer entrega sob a guarda: a origem é a
   * entrega gerada antes da guarda, com o destino e o evento; o único metadado
   * é o número da tentativa, que a linha da entrega exige. Em dúvida, a entrega
   * daquela tentativa nasce como falha incerta. A transação pode ser `raw`
   * (ativação): `workspaceId` explícito.
   */
  onModuleInit(): void {
    this.origens.registrar('webhook_delivery', {
      origem: ['deliveryId', 'webhookId', 'outboxEventId'],
      metadados: {
        attempt: (valor) =>
          Number.isInteger(valor) &&
          (valor as number) >= 1 &&
          (valor as number) <= TENTATIVA_MAXIMA_NO_REGISTRO,
      },
      marcarIncerta: async (tx, uso) => {
        const origem = (uso.origin ?? {}) as Record<string, unknown>;
        const attempt = (uso.runMetadata as Record<string, unknown> | null)?.attempt;
        if (
          typeof origem.deliveryId !== 'string' ||
          typeof origem.webhookId !== 'string' ||
          typeof origem.outboxEventId !== 'string' ||
          typeof attempt !== 'number'
        ) {
          return;
        }
        await this.registrarEntregaIncerta(
          tx,
          uso.workspaceId,
          {
            deliveryId: origem.deliveryId,
            webhookId: origem.webhookId,
            outboxEventId: origem.outboxEventId,
            attempt,
          },
          'in_doubt',
        );
      },
    });
  }

  async list(): Promise<WebhookDto[]> {
    const rows = (await this.prisma.db.webhook.findMany({
      orderBy: { createdAt: 'asc' },
    })) as unknown as WebhookRow[];
    return rows.map((row) => this.toDto(row));
  }

  /** O segredo é retornado UMA única vez, na criação (padrão do convite Owner). */
  async create(
    auth: AuthContext,
    input: CreateWebhookInput,
  ): Promise<WebhookDto & { secret: string }> {
    try {
      assertSafeWebhookUrl(input.url);
    } catch (error) {
      throw new BadRequestException(
        error instanceof UnsafeUrlError ? error.message : 'URL inválida',
      );
    }
    const existing = await this.prisma.db.webhook.count();
    if (existing >= MAX_WEBHOOKS_PER_WORKSPACE) {
      throw new BadRequestException(
        `Limite de ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks por workspace atingido`,
      );
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const webhook = await tx.webhook.create({
        data: {
          url: input.url,
          events: input.events,
          secretCipher: this.crypto.encrypt(secret),
        },
      } as never);
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.created', {
        entityType: 'webhook',
        entityId: webhook.id,
        actor: this.audit.actorFrom(auth),
        after: { url: input.url, events: input.events, status: 'active' },
      });
      return webhook.id;
    });
    const row = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow;
    return { ...this.toDto(row), secret };
  }

  async update(auth: AuthContext, id: string, input: UpdateWebhookInput): Promise<WebhookDto> {
    const existing = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow | null;
    if (!existing) throw new NotFoundException('Webhook não encontrado');
    if (input.url) {
      try {
        assertSafeWebhookUrl(input.url);
      } catch (error) {
        throw new BadRequestException(
          error instanceof UnsafeUrlError ? error.message : 'URL inválida',
        );
      }
    }
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.webhook.updateMany({
        where: { id },
        data: {
          url: input.url,
          events: input.events,
          status: input.status,
          // reativar manualmente zera o contador de entregas mortas
          failureCount: input.status === 'active' ? 0 : undefined,
        },
      });
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.updated', {
        entityType: 'webhook',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { url: existing.url, events: existing.events, status: existing.status },
        after: { url: input.url, events: input.events, status: input.status },
      });
    });
    const row = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow;
    return this.toDto(row);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow | null;
    if (!existing) throw new NotFoundException('Webhook não encontrado');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.deleted', {
        entityType: 'webhook',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { url: existing.url, status: existing.status },
        after: null,
      });
      await tx.webhook.deleteMany({ where: { id } });
    });
  }

  /** Assinatura: t=<ts>,v1=HMAC_SHA256(secret, `${ts}.${body}`) — resiste a replay. */
  sign(secret: string, timestamp: number, body: string): string {
    const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${mac}`;
  }

  /** Exposto para teste/documentação do consumidor. */
  verify(secret: string, header: string, body: string, toleranceSec = 300): boolean {
    const ts = Number(/t=(\d+)/.exec(header)?.[1]);
    const mac = /v1=([0-9a-f]+)/.exec(header)?.[1];
    if (!ts || !mac) return false;
    if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * De quem é o evento NA ENTREGA: os contatos e as entidades dele e, quando o
   * evento nasceu de uma cadeia de automação, também os do evento RAIZ (ADR-047
   * adendo 2; adendo 7 §9, G3.3). O conteúdo derivado — `{{title}}` de uma
   * tarefa criada a partir de `deal.created` — é do contato do deal raiz, e esse
   * vínculo pode ter surgido DEPOIS da emissão: só a fotografia não o veria. A
   * fotografia da emissão entra junto: só a resolução deixaria escapar um deal
   * desligado do contato entre emitir e entregar.
   *
   * `client`: o `raw` na checagem rápida (fora do CLS) ou a transação da guarda
   * na reconferência — `workspaceId` explícito em toda leitura.
   */
  private async escopoDoEvento(client: Db, event: ClaimedEvent): Promise<EscopoDoEvento> {
    const partes = [
      await resolveEventScope(client, event.workspaceId, event.eventType, event.payload),
    ];
    if (event.chainId) {
      const raiz = await client.outboxEvent.findFirst({
        where: { workspaceId: event.workspaceId, id: event.chainId },
        select: { eventType: true, payload: true },
      });
      partes.push(
        raiz
          ? await resolveEventScope(client, event.workspaceId, raiz.eventType, raiz.payload)
          : // raiz sumida: não dá para saber de quem era o conteúdo derivado
            { contacts: [null], entities: [] },
      );
    }
    const todos: RestrictionSubject[] = [
      ...(event.subjectContactIds ?? []),
      ...partes.flatMap((parte) => parte.contacts),
    ];
    const contatos = [...new Set(todos.filter((id): id is string => typeof id === 'string'))];
    return {
      contatos,
      entidades: [...new Set(partes.flatMap((parte) => parte.entities))],
      sujeitos: todos.some((id) => id === null) ? [...contatos, null] : contatos,
    };
  }

  /**
   * Entrega um evento do outbox aos webhooks ativos inscritos. Chamado pelo
   * worker; `raw` justificado (cross-workspace, com workspaceId explícito).
   */
  async deliver(event: ClaimedEvent): Promise<void> {
    // defesa em profundidade: o dispatcher já roteia eventos internos para o
    // handler próprio e o contrato de webhook nem os lista — mas um evento
    // interno carrega dado de infraestrutura (chave de storage) e não pode
    // sair para cliente por nenhum caminho
    if (INTERNAL_EVENT_TYPES.has(event.eventType)) {
      this.logger.error(`Evento interno ${event.eventType} chegou ao entregador de webhook`);
      await this.outbox.markDelivered(event.id, event.claimToken);
      return;
    }
    const webhooks = await this.prisma.raw.webhook.findMany({
      where: {
        workspaceId: event.workspaceId,
        status: 'active',
        events: { has: event.eventType },
      },
    });
    if (webhooks.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken); // ninguém inscrito
      return;
    }

    /**
     * RESTRIÇÃO DE CONTEÚDO, conferida NA ENTREGA e a cada tentativa (ADR-048
     * §6.5): um evento emitido antes de o contato ficar restrito também não
     * sai. Suprimido = concluído sem enviar; nada vai para o histórico de
     * entregas, que o cliente vê. Automações não passam por aqui e seguem
     * funcionando.
     */
    // `raw` justificado: a entrega roda fora do CLS; `workspaceId` explícito
    const escopo = await this.escopoDoEvento(this.prisma.raw as unknown as Db, event);
    if (this.restriction.active) {
      /**
       * A checagem RÁPIDA, antes do fan-out: suprime cedo, sem abrir guarda. A
       * garantia é a reconferência sob as travas, por destino (G3.3).
       */
      if (escopo.sujeitos.length > 0) {
        const verdict = await this.restriction.check(event.workspaceId, 'webhook', escopo.sujeitos);
        if (verdict.unavailable) {
          // nada sai, mas também nada se perde: o dispatcher devolve o evento ao
          // outbox com backoff (fail-closed é "não sai", não "descarta")
          throw new Error('Porta de restrição indisponível — entrega reagendada');
        }
        if (verdict.restricted.some(Boolean)) {
          this.logger.log(`Evento ${event.id} (${event.eventType}) suprimido: conteúdo restrito`);
          await this.outbox.markDelivered(event.id, event.claimToken);
          return;
        }
      }
    }

    // RETRY PARCIAL (correção do P1): quem já recebeu ESTE outboxEventId com
    // sucesso não é reentregue — o retry existe para os que falharam. Sem isso,
    // uma falha parcial duplicaria a entrega nos destinos saudáveis a cada
    // tentativa.
    const alreadyDelivered = await this.prisma.raw.webhookDelivery.findMany({
      where: {
        workspaceId: event.workspaceId,
        outboxEventId: event.id,
        error: null,
        responseStatus: { gte: 200, lt: 300 },
      },
      select: { webhookId: true },
    });
    const deliveredIds = new Set(alreadyDelivered.map((row) => row.webhookId));
    const pendingWebhooks = webhooks.filter((webhook) => !deliveredIds.has(webhook.id));
    if (pendingWebhooks.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken); // todos já receberam
      return;
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.eventType,
      createdAt: new Date().toISOString(),
      data: event.payload,
    });
    const failures: string[] = [];
    const failedIds: string[] = [];
    const succeededIds: string[] = [];
    let suppressed = false;

    for (const webhook of pendingWebhooks) {
      // HEARTBEAT: fan-out longo pode ultrapassar o lease. Renovar antes de
      // cada destino mantém a posse; se já a perdemos, outro worker assumiu o
      // evento e continuar aqui duplicaria entregas — abandona sem concluir.
      if (!(await this.outbox.renewLease(event.id, event.claimToken))) {
        this.logger.warn(`Lease de ${event.id} perdido durante o fan-out — entrega abandonada`);
        return;
      }
      const desfecho = await this.entregarAoDestino(event, webhook, body, escopo);
      if (desfecho.tipo === 'entregue') {
        succeededIds.push(webhook.id);
        continue;
      }
      if (desfecho.tipo === 'falhou') {
        failures.push(`${webhook.id}: ${desfecho.erro}`);
        failedIds.push(webhook.id);
        continue;
      }
      if (desfecho.tipo === 'suprimido') {
        suppressed = true;
        break;
      }
      // falha DO EVENTO: nenhum destino é penalizado, e o retry parcial retoma
      // daqui com um uso novo (ADR-047 §4, "o que estava em voo não sai")
      failures.push(`${webhook.id}: ${desfecho.motivo}`);
      break;
    }

    // sucesso zera o contador de quem entregou, mesmo em lote parcialmente falho
    if (succeededIds.length > 0) {
      await this.prisma.raw.webhook.updateMany({
        where: { workspaceId: event.workspaceId, id: { in: succeededIds } },
        data: { failureCount: 0 },
      });
    }
    if (suppressed) {
      this.logger.log(`Evento ${event.id} (${event.eventType}) suprimido no meio do fan-out`);
      await this.outbox.markDelivered(event.id, event.claimToken);
      return;
    }
    if (failures.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken);
      return;
    }

    const outcome = await this.outbox.markFailed(
      event.id,
      event.claimToken,
      event.attempts,
      failures.join('; '),
    );
    if (outcome === 'dead') {
      // AJUSTE #7: só a ENTREGA MORTA conta — instabilidade curta (retries) não
      // pausa webhook. Três eventos mortos consecutivos → pause automático.
      // SÓ quem falhou é penalizado: um webhook saudável não pode ser pausado
      // porque OUTRO do mesmo workspace está fora do ar
      for (const webhookId of failedIds) {
        const updated = await this.prisma.raw.webhook.update({
          where: { id: webhookId },
          data: { failureCount: { increment: 1 } },
        });
        if (updated.failureCount >= DEAD_DELIVERIES_TO_PAUSE) {
          await this.prisma.raw.webhook.updateMany({
            where: { id: webhookId, workspaceId: event.workspaceId },
            data: { status: 'paused' },
          });
          this.logger.warn(
            `Webhook ${webhookId} pausado após ${updated.failureCount} entregas mortas`,
          );
        }
      }
    }
  }

  /**
   * UM destino, numa tentativa, sob a guarda de uso externo (ADR-047 adendo 7
   * §9, G3.3): uso novo por destino e por tentativa, com registro, travas
   * (contatos e entidades, valendo mesmo sem contato), reconferência e o POST no
   * prazo de 10 s, DNS incluído. A entrega roda fora do CLS; a guarda, no
   * contexto do workspace DO EVENTO, como o client filtrado dela exige.
   */
  private async entregarAoDestino(
    event: ClaimedEvent,
    webhook: WebhookRow,
    body: string,
    escopo: EscopoDoEvento,
  ): Promise<DesfechoDoDestino> {
    const timestamp = Math.floor(Date.now() / 1000);
    let headers: Record<string, string>;
    try {
      // segredo ilegível é falha DESTE destino, antes de qualquer envio: os
      // outros seguem, e nenhuma guarda é aberta para o que não vai sair
      const secret = this.crypto.decrypt(webhook.secretCipher);
      headers = {
        'x-veyra-event': event.eventType,
        'x-veyra-delivery': event.id,
        'x-veyra-signature': this.sign(secret, timestamp, body),
      };
    } catch (e) {
      const erro = e instanceof Error ? e.message : 'falha desconhecida';
      await this.prisma.raw.webhookDelivery.create({
        data: {
          workspaceId: event.workspaceId,
          webhookId: webhook.id,
          outboxEventId: event.id,
          attempt: event.attempts,
          responseStatus: null,
          error: erro,
          durationMs: 0,
        },
      });
      return { tipo: 'falhou', erro };
    }

    // o id da entrega nasce ANTES da guarda: é a origem do uso, e o tratador o
    // usa para criar a entrega incerta se a guarda se perder
    const deliveryId = randomUUID();
    const resultado = await this.cls.run(() => {
      this.cls.set('workspaceId', event.workspaceId);
      return this.guarda.executar<SafeFetchResult, DesfechoDoDestino>({
        workspaceId: event.workspaceId,
        kind: 'webhook_delivery',
        contactIds: escopo.contatos,
        entityKeys: escopo.entidades,
        prazoMs: this.configDaGuarda.prazoDoWebhookMs,
        origem: { deliveryId, webhookId: webhook.id, outboxEventId: event.id },
        reservas: [],
        metadadosDoRun: { attempt: event.attempts },
        reconferir: (tx) => this.reconferir(tx, event, escopo),
        iniciar: (signal) => this.transport(webhook.url, body, headers, signal),
        persistir: (tx, desfecho) =>
          this.registrarEntrega(tx, event, webhook.id, deliveryId, desfecho),
        // a guarda voltou ao SAVEPOINT: a entrega desta tentativa fica incerta
        persistenciaFalhou: (tx) =>
          this.registrarEntregaIncerta(
            tx,
            event.workspaceId,
            { deliveryId, webhookId: webhook.id, outboxEventId: event.id, attempt: event.attempts },
            'persistence_failed',
          ),
      });
    });
    switch (resultado.tipo) {
      case 'concluido':
        return resultado.persistido && resultado.valor
          ? resultado.valor
          : { tipo: 'evento', motivo: 'entrega incerta (persistência)' };
      case 'em_duvida':
        // o tratador de origem criou (ou a reconciliação criará) a entrega
        // incerta; a nova tentativa é um uso novo, recusado depois de uma
        // restrição
        return { tipo: 'evento', motivo: 'entrega em dúvida' };
      case 'nao_comecou':
        if (resultado.motivo === 'restrito') return { tipo: 'suprimido' };
        return {
          tipo: 'evento',
          motivo:
            resultado.motivo === 'indisponivel'
              ? 'entrega não começou: porta de restrição indisponível ou de quem é o evento mudou'
              : `entrega não começou (${resultado.motivo})`,
        };
    }
  }

  /**
   * A reconferência SOB AS TRAVAS, na transação da guarda: resolve de novo de
   * quem é o evento. Contato ou entidade fora do conjunto travado (o deal ganhou
   * um contato, a tarefa trocou de deal entre a resolução e as travas) e o uso
   * não começa — a nova tentativa resolve de novo; nunca segue sem a trava de
   * quem o evento passou a ser.
   */
  private async reconferir(
    tx: Db,
    event: ClaimedEvent,
    travado: EscopoDoEvento,
  ): Promise<Veredito> {
    const agora = await this.escopoDoEvento(tx, event);
    const fora =
      agora.contatos.some((id) => !travado.contatos.includes(id)) ||
      agora.entidades.some((chave) => !travado.entidades.includes(chave));
    if (fora) {
      this.logger.warn(
        `Evento ${event.id}: de quem é o evento mudou entre a resolução e as travas — nova tentativa`,
      );
      return 'indisponivel';
    }
    const veredito = await this.restriction.check(event.workspaceId, 'webhook', agora.sujeitos);
    if (veredito.unavailable) return 'indisponivel';
    return veredito.restricted.some(Boolean) ? 'restrito' : 'liberado';
  }

  /** NA transação da guarda: a entrega desta tentativa, com o id gerado antes. */
  private async registrarEntrega(
    tx: Db,
    event: ClaimedEvent,
    webhookId: string,
    deliveryId: string,
    desfecho: SafeFetchResult | DesfechoIncerto,
  ): Promise<DesfechoDoDestino> {
    const incerto = ehIncerto(desfecho);
    const erro = incerto
      ? desfecho.erro instanceof Error
        ? desfecho.erro.message
        : 'falha desconhecida'
      : desfecho.status >= 400
        ? `HTTP ${desfecho.status}`
        : null;
    await tx.webhookDelivery.create({
      data: {
        id: deliveryId,
        workspaceId: event.workspaceId,
        webhookId,
        outboxEventId: event.id,
        attempt: event.attempts,
        responseStatus: incerto ? null : desfecho.status,
        error: erro,
        durationMs: incerto ? 0 : desfecho.durationMs,
      },
    });
    return erro ? { tipo: 'falhou', erro } : { tipo: 'entregue' };
  }

  /**
   * A entrega de uma tentativa como FALHA INCERTA, se ainda não existir — pelo
   * tratador de origem (`in_doubt`) ou quando a persistência falha. Destino ou
   * evento já apagados: não há histórico a manter (o cascade o apagaria), e a
   * FK recusaria a linha. A transação pode ser `raw`: `workspaceId` explícito.
   */
  private async registrarEntregaIncerta(
    tx: Db,
    workspaceId: string,
    entrega: { deliveryId: string; webhookId: string; outboxEventId: string; attempt: number },
    erro: string,
  ): Promise<void> {
    const destino = await tx.webhook.count({ where: { workspaceId, id: entrega.webhookId } });
    const evento = await tx.outboxEvent.count({
      where: { workspaceId, id: entrega.outboxEventId },
    });
    if (destino === 0 || evento === 0) return;
    await tx.webhookDelivery.createMany({
      data: [
        {
          id: entrega.deliveryId,
          workspaceId,
          webhookId: entrega.webhookId,
          outboxEventId: entrega.outboxEventId,
          attempt: entrega.attempt,
          responseStatus: null,
          error: erro,
          durationMs: 0,
        },
      ],
      skipDuplicates: true,
    });
  }

  /** DTO nunca expõe o segredo (nem cifrado). */
  private toDto(row: WebhookRow): WebhookDto {
    return {
      id: row.id,
      url: row.url,
      events: row.events,
      status: row.status,
      failureCount: row.failureCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export { MAX_ATTEMPTS };

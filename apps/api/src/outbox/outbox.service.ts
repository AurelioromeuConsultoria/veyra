import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { resolveEventSubjects, type EventSubject } from './event-subjects';

type AnyClient = Db | Prisma.TransactionClient;

/**
 * ALLOWLIST de payload por evento (ajuste #5): o que sai do Veyra para fora é
 * declarado aqui, com .strict() — nunca uma entidade Prisma inteira. Evento
 * novo = entrada nova + revisão de security + declarar de quais contatos ele é
 * (`subjectContactIds`, exigido pelo tipo do `enqueue`) e a entrada no mapa
 * evento → entidade da entrega de webhook.
 */
export const OUTBOX_EVENTS = {
  'contact.created': z.object({ id: z.string().uuid(), name: z.string().max(160) }).strict(),
  'contact.updated': z.object({ id: z.string().uuid(), name: z.string().max(160) }).strict(),
  'contact.deleted': z.object({ id: z.string().uuid() }).strict(),
  'deal.created': z
    .object({
      id: z.string().uuid(),
      title: z.string().max(160),
      amountCents: z.number().int(),
      currency: z.string().length(3),
    })
    .strict(),
  'deal.stage_changed': z
    .object({
      id: z.string().uuid(),
      fromStage: z.string().max(60),
      toStage: z.string().max(60),
    })
    .strict(),
  'deal.won': z.object({ id: z.string().uuid(), amountCents: z.number().int() }).strict(),
  'deal.lost': z.object({ id: z.string().uuid(), amountCents: z.number().int() }).strict(),
  'task.created': z.object({ id: z.string().uuid(), title: z.string().max(200) }).strict(),
  'task.completed': z.object({ id: z.string().uuid(), title: z.string().max(200) }).strict(),
  /**
   * INTERNO (ADR-024): expurgo físico de arquivo. Carrega a CHAVE de storage e
   * por isso NUNCA pode ser entregue a webhook de cliente — o dispatcher o
   * roteia para o handler interno e `INTERNAL_EVENT_TYPES` o mantém fora da
   * lista de eventos assináveis.
   */
  'file.purge': z.object({ key: z.string().max(200) }).strict(),
  /**
   * INTERNO: envio pendente pelo canal externo. O consumidor existe (o
   * dispatcher chama `WhatsappSendService.dispatch`) — evento interno sem
   * handler é entrega perdida, como a mídia da 9.1.a mostrou.
   */
  'whatsapp.send_pending': z.object({ messageId: z.string().uuid() }).strict(),
} as const;

/** Eventos que NUNCA saem para webhook: são trabalho interno da plataforma. */
const INTERNAL_EVENT_LIST = ['file.purge', 'whatsapp.send_pending'] as const;
export const INTERNAL_EVENT_TYPES = new Set<string>(INTERNAL_EVENT_LIST);
export type InternalEventType = (typeof INTERNAL_EVENT_LIST)[number];

export type OutboxEventType = keyof typeof OUTBOX_EVENTS;
export const OUTBOX_EVENT_TYPES = Object.keys(OUTBOX_EVENTS) as OutboxEventType[];

/** Só estes podem ser assinados por webhook (contrato público). */
export const WEBHOOK_EVENT_TYPES = OUTBOX_EVENT_TYPES.filter(
  (type) => !INTERNAL_EVENT_TYPES.has(type),
);

/** Backoff exponencial: 1min, 5min, 25min… até MAX_ATTEMPTS → dead. */
const BASE_DELAY_MS = 60_000;
export const MAX_ATTEMPTS = 6;
/**
 * Duração do lease de entrega. Precisa cobrir a pior entrega possível
 * (timeout de 5s × webhooks inscritos) com folga; expirado, outro worker
 * assume — é assim que um worker morto não trava o evento para sempre.
 */
export const LEASE_MS = 5 * 60_000;

/** Um evento reivindicado, com o token que prova a posse do lease. */
export type ClaimedEvent = {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  claimToken: string;
  /** causalidade da cadeia de automação (ADR-035) */
  chainId: string | null;
  depth: number;
  originAutomationId: string | null;
  /**
   * Contatos de quem era o evento NO MOMENTO DA EMISSÃO (ADR-047 adendo 2).
   * `null` = evento anterior a esta coluna: só a resolução na entrega vale.
   */
  subjectContactIds: string[] | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnqueueOptions {
  /**
   * CAUSALIDADE (ADR-035): quando o evento nasce de uma automação, a cadeia
   * viaja em COLUNAS — nunca no payload, que é o que sai para webhook.
   */
  causality?: { chainId: string | null; depth: number; originAutomationId: string };
  /**
   * Contatos de quem é o evento AGORA, na transação que o emite — fotografia
   * que a entrega soma à resolução do momento da entrega (ADR-047 adendo 2).
   * OBRIGATÓRIO em todo evento do catálogo de webhooks (`[]` = sem contato).
   */
  subjectContactIds?: readonly string[];
  /**
   * Evento DERIVADO herda os sujeitos do evento que o causou (ADR-047 adendo 2):
   * a tarefa que uma automação cria a partir de `deal.created` pode carregar o
   * título do deal, e é conteúdo do contato dele. Id do evento de origem, lido
   * no MESMO workspace; seus contatos já foram validados na emissão de origem.
   */
  inheritSubjectsFrom?: string;
}

/** Evento público EXIGE os sujeitos em tempo de compilação; interno não os tem. */
type PublicEnqueueOptions = Omit<EnqueueOptions, 'subjectContactIds'> & {
  subjectContactIds: readonly string[];
};
type InternalEnqueueOptions = Pick<EnqueueOptions, 'causality'>;
/**
 * `[T] extends [...]` SEM distribuir: com `T` sendo a união inteira (um emissor
 * genérico), a forma distributiva aceitava a chamada sem opções. Assim, só
 * quando `T` é COMPROVADAMENTE interno as opções ficam dispensáveis.
 */
export type EnqueueOptionsFor<T extends OutboxEventType> = [T] extends [InternalEventType]
  ? [options?: InternalEnqueueOptions]
  : [options: PublicEnqueueOptions];

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira DENTRO da transação de domínio: se ela abortar, o evento some
   * junto — efeito externo nunca escapa de uma operação revertida.
   */
  async enqueue<T extends OutboxEventType>(
    db: AnyClient,
    workspaceId: string,
    eventType: T,
    payload: Record<string, unknown>,
    dedupeKey: string,
    ...rest: EnqueueOptionsFor<T>
  ): Promise<void> {
    const options: EnqueueOptions = rest[0] ?? {};
    const { causality } = options;
    const parsed = OUTBOX_EVENTS[eventType].safeParse(payload);
    if (!parsed.success) {
      // bug de programação: payload fora da allowlist do evento
      throw new Error(`Payload inválido para ${eventType}: ${parsed.error.message}`);
    }
    const own = await this.validatedSubjects(db, workspaceId, eventType, options);
    const inherited =
      own === null
        ? []
        : await this.inheritedSubjects(db, workspaceId, options.inheritSubjectsFrom);
    // um `null` herdado (origem antiga sem entidade resolvível) não cabe numa
    // coluna de UUIDs: a resolução do evento raiz na entrega cobre esse caso
    const subjectContactIds =
      own === null
        ? null
        : [...new Set([...own, ...inherited.filter((id): id is string => id !== null)])];
    /**
     * PRÉ-CHECAGEM, e não `catch` de P2002. No Postgres, violação de unique
     * ABORTA o bloco inteiro: capturar o erro dentro da transação de domínio
     * deixava todo statement seguinte — e o próprio COMMIT — falhando com
     * 25P02. O caso concreto era ganhar um deal, reabri-lo e ganhá-lo de novo:
     * o `dedupeKey` repetia, a transação envenenava, e aquele deal nunca mais
     * podia ser marcado como ganho.
     *
     * A corrida remanescente (duas transações inserindo o mesmo `dedupeKey` ao
     * mesmo tempo) resulta em erro de unique que aborta UMA delas — que é o
     * comportamento correto para um efeito externo duplicado.
     */
    const existente = await db.outboxEvent.findFirst({
      where: { workspaceId, dedupeKey },
      select: { id: true },
    });
    if (existente) {
      this.logger.debug(`Evento ${eventType} já enfileirado (dedupe): ${dedupeKey}`);
      return;
    }
    await db.outboxEvent.create({
      data: {
        workspaceId,
        eventType,
        payload: parsed.data as object,
        dedupeKey,
        chainId: causality?.chainId ?? null,
        depth: causality?.depth ?? 0,
        originAutomationId: causality?.originAutomationId ?? null,
        // evento interno não tem contato a declarar; fica NULL como os antigos
        ...(subjectContactIds ? { subjectContactIds } : {}),
      },
    } as never);
  }

  /**
   * A fotografia NÃO tem FK (contato excluído depois não pode apagar nem
   * bloquear o evento). Por isso o isolamento é conferido AQUI, na emissão:
   * todo id precisa ser um contato do MESMO workspace do evento, lido na mesma
   * transação. Id de outro workspace, inexistente ou malformado derruba a
   * transação de domínio — nunca vira dado silencioso no outbox.
   */
  private async validatedSubjects(
    db: AnyClient,
    workspaceId: string,
    eventType: OutboxEventType,
    options: EnqueueOptions,
  ): Promise<string[] | null> {
    if (INTERNAL_EVENT_TYPES.has(eventType)) return null;
    if (!options.subjectContactIds) {
      throw new Error(
        `Evento público ${eventType} sem subjectContactIds — declare de quais contatos ele é ([] se de nenhum).`,
      );
    }
    const ids = [...new Set(options.subjectContactIds)];
    if (ids.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
      throw new Error(`subjectContactIds inválido em ${eventType}`);
    }
    if (ids.length === 0) return [];
    // workspaceId EXPLÍCITO no WHERE: vale tanto no client protegido (onde
    // diverge do contexto = nenhuma linha) quanto numa transação `raw`
    const found = (await db.contact.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    } as never)) as unknown as { id: string }[];
    if (found.length !== ids.length) {
      throw new Error(
        `subjectContactIds de ${eventType}: contato inexistente ou de outro workspace do evento`,
      );
    }
    return ids;
  }

  /**
   * Sujeitos herdados do evento de origem, lido com `workspaceId` explícito.
   * Sem revalidar a existência: os ids já foram conferidos na emissão de
   * origem, e o contato ter sido excluído depois não pode impedir a automação
   * nem apagar o vínculo (procedência).
   *
   * FALHA FECHADA no que não se sabe:
   * - origem inexistente no workspace (id errado, ou de outro workspace) LANÇA —
   *   herdar "nada" em silêncio liberaria justamente o conteúdo derivado;
   * - origem já terminal LANÇA: a fotografia dela foi zerada, e herdar de
   *   evento concluído é um caminho que ainda não existe e precisa ser pensado;
   * - a fotografia é SOMADA à resolução atual da entidade de origem. Isso
   *   cobre a origem anterior à coluna (o Prisma lê o NULL como `[]`, então
   *   "antigo" e "sem contato" não se distinguem por aqui) e um vínculo criado
   *   entre a emissão da origem e a automação.
   */
  private async inheritedSubjects(
    db: AnyClient,
    workspaceId: string,
    sourceEventId: string | undefined,
  ): Promise<EventSubject[]> {
    if (!sourceEventId) return [];
    const source = (await db.outboxEvent.findFirst({
      where: { workspaceId, id: sourceEventId },
      select: { subjectContactIds: true, status: true, eventType: true, payload: true },
    } as never)) as unknown as {
      subjectContactIds: string[] | null;
      status: string;
      eventType: string;
      payload: unknown;
    } | null;
    if (!source) {
      throw new Error('inheritSubjectsFrom: evento de origem inexistente neste workspace');
    }
    if (source.status === 'delivered' || source.status === 'dead') {
      throw new Error('inheritSubjectsFrom: evento de origem já concluído (fotografia zerada)');
    }
    return [
      ...(source.subjectContactIds ?? []),
      ...(await resolveEventSubjects(db, workspaceId, source.eventType, source.payload)),
    ];
  }

  /**
   * Reivindica um lote para entrega, com LEASE (correção do P1 da revisão).
   *
   * O `FOR UPDATE SKIP LOCKED` sozinho só protege DURANTE o UPDATE: terminado
   * o statement, o evento voltaria a `pending` com o mesmo `nextRetryAt` e
   * outra instância o entregaria em paralelo — seis workers concorrentes o
   * levariam a `dead` artificialmente. Aqui o MESMO UPDATE atômico muda o
   * status para `processing` e grava `claimedAt`/`leaseExpiresAt`, tornando o
   * evento invisível aos demais workers até o lease expirar.
   *
   * Elegíveis: `pending` no ponto ou `processing` com LEASE EXPIRADO (worker
   * que morreu no meio da entrega).
   *
   * Cada claim gera um `claimToken` novo (FENCING): quem reivindica depois
   * invalida o token anterior, então o worker antigo — lento, mas vivo — não
   * consegue mais concluir o evento (ver `markDelivered`/`markFailed`).
   *
   * prisma.raw justificado: worker é cross-workspace (SECURITY.md §2).
   */
  async claimBatch(limit = 20): Promise<ClaimedEvent[]> {
    return this.prisma.raw.$queryRawUnsafe(
      `UPDATE "OutboxEvent"
          SET "attempts" = "attempts" + 1,
              "status" = 'processing',
              "claimedAt" = now(),
              "leaseExpiresAt" = now() + ($2::int * interval '1 millisecond'),
              "claimToken" = gen_random_uuid()
         WHERE "id" IN (
           SELECT "id" FROM "OutboxEvent"
            WHERE ("status" = 'pending' AND "nextRetryAt" <= now())
               OR ("status" = 'processing' AND "leaseExpiresAt" < now())
            ORDER BY "nextRetryAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
       RETURNING "id", "workspaceId", "eventType", "payload", "attempts", "claimToken",
                 "chainId", "depth", "originAutomationId", "subjectContactIds"`,
      limit,
      LEASE_MS,
    );
  }

  /**
   * Renova o lease DURANTE uma entrega longa (heartbeat). Retorna `false` se o
   * lease já não é nosso — outro worker reivindicou o evento e este deve parar
   * imediatamente, em vez de continuar entregando em duplicidade.
   */
  async renewLease(id: string, claimToken: string): Promise<boolean> {
    // horário do BANCO: o claim compara `leaseExpiresAt < now()` em SQL, então
    // renovar com o relógio do processo faria a duração real do lease variar
    // com o desvio entre app e banco
    const count = await this.prisma.raw.$executeRawUnsafe(
      `UPDATE "OutboxEvent"
          SET "leaseExpiresAt" = now() + ($3::bigint * interval '1 millisecond')
        WHERE "id" = $1::uuid AND "claimToken" = $2::uuid AND "status" = 'processing'`,
      id,
      claimToken,
      LEASE_MS,
    );
    return count > 0;
  }

  /**
   * Encerra o evento e libera o lease. Só o DONO do lease conclui: `claimToken`
   * + `status='processing'` no WHERE. Um worker que estourou o lease e acordou
   * depois recebe `false` e não sobrescreve o trabalho de quem o assumiu.
   */
  async markDelivered(id: string, claimToken: string): Promise<boolean> {
    /**
     * A FOTOGRAFIA dos contatos é zerada ao concluir (ADR-047 adendo 2, LGPD):
     * ela só serve enquanto o evento ainda pode ser entregue. Mantê-la num
     * evento terminal religaria, para sempre, deals e tarefas ao id de um
     * contato que o titular mandou excluir (ADR-022 os desvincula).
     *
     * `raw` justificado: o dispatcher é cross-workspace, e só em SQL a coluna
     * volta a NULL (o tipo do Prisma para lista não admite nulo).
     */
    const count = await this.prisma.raw.$executeRawUnsafe(
      `UPDATE "OutboxEvent"
          SET "status" = 'delivered',
              "deliveredAt" = now(),
              "lastError" = NULL,
              "claimedAt" = NULL,
              "leaseExpiresAt" = NULL,
              "claimToken" = NULL,
              "subjectContactIds" = NULL
        WHERE "id" = $1::uuid AND "claimToken" = $2::uuid AND "status" = 'processing'`,
      id,
      claimToken,
    );
    if (count === 0) this.logger.warn(`Lease perdido ao concluir ${id} — conclusão ignorada`);
    return count > 0;
  }

  /**
   * Falha: reagenda com backoff ou marca `dead` no limite de tentativas.
   * `lost` = o lease não era mais nosso; quem o detém agora decide o destino.
   */
  async markFailed(
    id: string,
    claimToken: string,
    attempts: number,
    error: string,
  ): Promise<'retry' | 'dead' | 'lost'> {
    const dead = attempts >= MAX_ATTEMPTS;
    const backoffMs = BASE_DELAY_MS * 5 ** (attempts - 1);
    /**
     * O BACKOFF É CALCULADO NO POSTGRES, não com `new Date()` da aplicação.
     *
     * O claim compara `nextRetryAt <= now()` com o relógio do BANCO. Escrever
     * esse horário com o relógio do processo mistura duas fontes de tempo: com o
     * app adiantado, a retentativa atrasa o tanto do desvio; com o app atrasado,
     * o evento é reivindicado ANTES do backoff pedido — e várias instâncias
     * podem discordar entre si. Um desvio de 47 s num ambiente de
     * desenvolvimento tornou isso visível como falha de teste; em produção seria
     * entrega atrasada ou martelada, silenciosamente.
     *
     * `raw` justificado: só em SQL o horário nasce do mesmo relógio que o
     * compara. O `workspaceId` não entra porque o dispatcher é cross-workspace
     * (SECURITY.md §2) e a chave é o par id+claimToken, que é o fencing.
     */
    const count = await this.prisma.raw.$executeRawUnsafe(
      `UPDATE "OutboxEvent"
          SET "status" = $4::"OutboxStatus",
              "lastError" = $5,
              "nextRetryAt" = CASE
                WHEN $6::boolean THEN "nextRetryAt"
                ELSE now() + ($7::bigint * interval '1 millisecond')
              END,
              "claimedAt" = NULL,
              "leaseExpiresAt" = NULL,
              "claimToken" = NULL,
              -- evento MORTO não será mais entregue: a fotografia sai junto
              -- (mesma razão de LGPD do markDelivered)
              "subjectContactIds" = CASE
                WHEN $6::boolean THEN NULL
                ELSE "subjectContactIds"
              END
        WHERE "id" = $1::uuid AND "claimToken" = $2::uuid AND "status" = $3::"OutboxStatus"`,
      id,
      claimToken,
      'processing',
      dead ? 'dead' : 'pending',
      error.slice(0, 500),
      dead,
      backoffMs,
    );
    if (count === 0) {
      this.logger.warn(`Lease perdido ao falhar ${id} — reagendamento ignorado`);
      return 'lost';
    }
    return dead ? 'dead' : 'retry';
  }
}

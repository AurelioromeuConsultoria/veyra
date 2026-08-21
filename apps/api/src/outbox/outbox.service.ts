import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';

type AnyClient = Db | Prisma.TransactionClient;

/**
 * ALLOWLIST de payload por evento (ajuste #5): o que sai do Veyra para fora é
 * declarado aqui, com .strict() — nunca uma entidade Prisma inteira. Evento
 * novo = entrada nova + revisão de security.
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
export const INTERNAL_EVENT_TYPES = new Set<string>(['file.purge', 'whatsapp.send_pending']);

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
};

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enfileira DENTRO da transação de domínio: se ela abortar, o evento some
   * junto — efeito externo nunca escapa de uma operação revertida.
   */
  async enqueue(
    db: AnyClient,
    workspaceId: string,
    eventType: OutboxEventType,
    payload: Record<string, unknown>,
    dedupeKey: string,
    /**
     * CAUSALIDADE (ADR-035): quando o evento nasce de uma automação, a cadeia
     * viaja em COLUNAS — nunca no payload, que é o que sai para webhook.
     */
    causality?: { chainId: string | null; depth: number; originAutomationId: string },
  ): Promise<void> {
    const parsed = OUTBOX_EVENTS[eventType].safeParse(payload);
    if (!parsed.success) {
      // bug de programação: payload fora da allowlist do evento
      throw new Error(`Payload inválido para ${eventType}: ${parsed.error.message}`);
    }
    try {
      await db.outboxEvent.create({
        data: {
          workspaceId,
          eventType,
          payload: parsed.data as object,
          dedupeKey,
          chainId: causality?.chainId ?? null,
          depth: causality?.depth ?? 0,
          originAutomationId: causality?.originAutomationId ?? null,
        },
      } as never);
    } catch (error) {
      // dedupeKey repetido = evento já enfileirado (idempotência barata)
      if ((error as { code?: string }).code === 'P2002') {
        this.logger.debug(`Evento ${eventType} já enfileirado (dedupe): ${dedupeKey}`);
        return;
      }
      throw error;
    }
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
                 "chainId", "depth", "originAutomationId"`,
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
    const { count } = await this.prisma.raw.outboxEvent.updateMany({
      where: { id, claimToken, status: 'processing' },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    return count > 0;
  }

  /**
   * Encerra o evento e libera o lease. Só o DONO do lease conclui: `claimToken`
   * + `status='processing'` no WHERE. Um worker que estourou o lease e acordou
   * depois recebe `false` e não sobrescreve o trabalho de quem o assumiu.
   */
  async markDelivered(id: string, claimToken: string): Promise<boolean> {
    const { count } = await this.prisma.raw.outboxEvent.updateMany({
      where: { id, claimToken, status: 'processing' },
      data: {
        status: 'delivered',
        deliveredAt: new Date(),
        lastError: null,
        claimedAt: null,
        leaseExpiresAt: null,
        claimToken: null,
      },
    });
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
    const { count } = await this.prisma.raw.outboxEvent.updateMany({
      where: { id, claimToken, status: 'processing' },
      data: {
        // volta para `pending` (com backoff) ou morre; nos dois casos o lease
        // é liberado — só o claim o define
        status: dead ? 'dead' : 'pending',
        lastError: error.slice(0, 500),
        nextRetryAt: dead ? undefined : new Date(Date.now() + BASE_DELAY_MS * 5 ** (attempts - 1)),
        claimedAt: null,
        leaseExpiresAt: null,
        claimToken: null,
      },
    });
    if (count === 0) {
      this.logger.warn(`Lease perdido ao falhar ${id} — reagendamento ignorado`);
      return 'lost';
    }
    return dead ? 'dead' : 'retry';
  }
}

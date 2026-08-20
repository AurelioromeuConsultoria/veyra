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
  'task.completed': z.object({ id: z.string().uuid(), title: z.string().max(200) }).strict(),
} as const;

export type OutboxEventType = keyof typeof OUTBOX_EVENTS;
export const OUTBOX_EVENT_TYPES = Object.keys(OUTBOX_EVENTS) as OutboxEventType[];

/** Backoff exponencial: 1min, 5min, 25min… até MAX_ATTEMPTS → dead. */
const BASE_DELAY_MS = 60_000;
export const MAX_ATTEMPTS = 6;

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
   * Reserva um lote pendente para entrega. `FOR UPDATE SKIP LOCKED`: várias
   * instâncias do worker podem rodar sem entregar o mesmo evento duas vezes.
   * prisma.raw justificado: worker é cross-workspace (SECURITY.md §2).
   */
  async claimBatch(
    limit = 20,
  ): Promise<
    { id: string; workspaceId: string; eventType: string; payload: unknown; attempts: number }[]
  > {
    return this.prisma.raw.$queryRawUnsafe(
      `UPDATE "OutboxEvent" SET "attempts" = "attempts" + 1
         WHERE "id" IN (
           SELECT "id" FROM "OutboxEvent"
            WHERE "status" = 'pending' AND "nextRetryAt" <= now()
            ORDER BY "nextRetryAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
       RETURNING "id", "workspaceId", "eventType", "payload", "attempts"`,
      limit,
    );
  }

  async markDelivered(id: string): Promise<void> {
    await this.prisma.raw.outboxEvent.updateMany({
      where: { id },
      data: { status: 'delivered', deliveredAt: new Date(), lastError: null },
    });
  }

  /** Falha: reagenda com backoff ou marca `dead` no limite de tentativas. */
  async markFailed(id: string, attempts: number, error: string): Promise<'retry' | 'dead'> {
    const dead = attempts >= MAX_ATTEMPTS;
    await this.prisma.raw.outboxEvent.updateMany({
      where: { id },
      data: {
        status: dead ? 'dead' : 'pending',
        lastError: error.slice(0, 500),
        nextRetryAt: dead ? undefined : new Date(Date.now() + BASE_DELAY_MS * 5 ** (attempts - 1)),
      },
    });
    return dead ? 'dead' : 'retry';
  }
}

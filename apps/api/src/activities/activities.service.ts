import { BadRequestException, Injectable } from '@nestjs/common';
import type { ActivityDto, ActivityPageDto, ActivityType } from '@veyra/contracts';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';

/** aceita o db protegido OU uma transação raw (que exige workspaceId explícito) */
type AnyClient = Db | Prisma.TransactionClient;

/**
 * Mapa FECHADO ActivityType → schema de payload (ajuste #4): validado
 * exclusivamente aqui, com .strict() — chave extra é rejeitada. Cada timeline
 * recebe só o mínimo para exibição; NUNCA corpo de nota, e-mail ou dado
 * sensível. Tipo novo = entrada nova aqui + revisão de security.
 */
const ACTIVITY_PAYLOADS: Record<ActivityType, z.ZodType> = {
  contact_created: z.object({ name: z.string().max(160) }).strict(),
  deal_created: z.object({ title: z.string().max(160), amountCents: z.number().int() }).strict(),
  deal_stage_changed: z
    .object({ fromStage: z.string().max(60), toStage: z.string().max(60) })
    .strict(),
  deal_updated: z.object({ title: z.string().max(160) }).strict(),
  deal_won: z.object({ amountCents: z.number().int() }).strict(),
  deal_lost: z.object({ amountCents: z.number().int() }).strict(),
  task_created: z.object({ title: z.string().max(200) }).strict(),
  task_completed: z.object({ title: z.string().max(200) }).strict(),
  note_added: z.object({}).strict(), // sem corpo, por design
  note_deleted: z.object({}).strict(),
  // NUNCA o corpo da mensagem na timeline (LGPD/§5): a direção já está no tipo
  message_sent: z.object({}).strict(),
  message_received: z.object({}).strict(),
  event_scheduled: z.object({ title: z.string().max(200), startAt: z.string().max(40) }).strict(),
};

export interface ActivityTargets {
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  calendarEventId?: string | null;
}

interface Cursor {
  occurredAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { occurredAt, id };
}

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ÚNICO ponto de escrita na timeline (append-only, ADR-011). Chamado pelos
   * services de domínio DENTRO da transação da mutação (tx do db.$transaction).
   */
  async record(
    db: AnyClient,
    workspaceId: string,
    type: ActivityType,
    options: {
      actorMembershipId: string | null;
      payload: Record<string, unknown>;
      targets: ActivityTargets;
    },
  ): Promise<void> {
    const schema = ACTIVITY_PAYLOADS[type];
    const parsed = schema.safeParse(options.payload);
    if (!parsed.success) {
      // bug de programação, não input de usuário: falhar alto e cedo
      throw new Error(`Payload inválido para Activity ${type}: ${parsed.error.message}`);
    }
    await db.activity.create({
      data: {
        // explícito: no db protegido é validado contra o CLS (igual = ok);
        // na tx raw (moves sob lock) é o próprio carimbo
        workspaceId,
        type,
        actorType: options.actorMembershipId ? 'user' : 'system',
        actorMembershipId: options.actorMembershipId,
        payload: parsed.data as object,
        contactId: options.targets.contactId ?? null,
        companyId: options.targets.companyId ?? null,
        dealId: options.targets.dealId ?? null,
        taskId: options.targets.taskId ?? null,
        conversationId: options.targets.conversationId ?? null,
        calendarEventId: options.targets.calendarEventId ?? null,
      },
    } as never);
  }

  /** Timeline por alvo único, cursor keyset (occurredAt, id) desc (ajuste #5). */
  async list(
    target: { contactId?: string; dealId?: string },
    limit: number,
    rawCursor?: string,
    options: { includeDealEvents?: boolean } = {},
  ): Promise<ActivityPageDto> {
    const targetWhere = target.contactId
      ? { contactId: target.contactId }
      : { dealId: target.dealId };
    // sem pipelines:read, eventos de oportunidade (que carregam valores) não
    // entram nem na timeline do contato
    const visibilityWhere =
      options.includeDealEvents === false
        ? {
            type: {
              notIn: [
                'deal_created',
                'deal_stage_changed',
                'deal_updated',
                'deal_won',
                'deal_lost',
              ],
            },
          }
        : {};
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const where = {
      ...targetWhere,
      ...visibilityWhere,
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.db.activity.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    } as never);

    const page = rows.slice(0, limit);
    const actorNames = await this.resolveActorNames(page.map((row) => row.actorMembershipId));
    const items: ActivityDto[] = page.map((row) => ({
      id: row.id,
      type: row.type as ActivityType,
      actorType: row.actorType,
      actorName: row.actorMembershipId ? (actorNames.get(row.actorMembershipId) ?? null) : null,
      payload: row.payload as ActivityDto['payload'],
      occurredAt: row.occurredAt.toISOString(),
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
    };
  }

  private async resolveActorNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: ids } },
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

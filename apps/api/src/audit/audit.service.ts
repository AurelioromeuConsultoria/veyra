import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuditEntryDto, AuditPageDto, ListAuditInput } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { AuthContext } from '../common/decorators';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';

type AnyClient = Db | Prisma.TransactionClient;

/** Marcador para campo alterado porém FORA da allowlist (nunca o valor). */
export const REDACTED = '[changed]';

/**
 * ALLOWLIST de campos auditáveis por entidade (SECURITY.md §5, ajuste do plano):
 * padrão-NEGAR — campo novo só é auditado quando entra aqui. Fora da lista, o
 * before/after registra apenas que mudou (`[changed]`), nunca o valor. Nada de
 * hash, token, corpo de nota, anexo ou dado clínico de vertical futuro.
 */
export const AUDIT_FIELDS: Record<string, readonly string[]> = {
  contact: ['name', 'status', 'companyId', 'ownerMembershipId', 'source'],
  company: ['name', 'domain', 'size', 'ownerMembershipId'],
  deal: [
    'title',
    'amountCents',
    'currency',
    'stageId',
    'status',
    'ownerMembershipId',
    'expectedCloseDate',
  ],
  task: ['title', 'status', 'assigneeMembershipId', 'dueAt', 'priority'],
  note: [], // nada do corpo — só o fato de ter existido
  membership: ['roleId', 'status'],
  invite: ['email', 'roleId'],
  role: ['name', 'description'],
  customField: ['label', 'required', 'options'],
  pipeline: ['name', 'defaultMark'],
  stage: ['name', 'order', 'probability', 'type'],
  webhook: ['url', 'events', 'status'], // secretCipher JAMAIS
};

export interface AuditActorInput {
  type: 'user' | 'api' | 'system' | 'ai';
  /** membership quando o ator é usuário do workspace */
  membershipId?: string | null;
  /** origem quando NÃO é usuário: id da API key, nome do job, AiRun (ajuste #2) */
  id?: string | null;
}

interface Cursor {
  createdAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`).toString('base64url');
}
function decodeCursor(raw: string): Cursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { createdAt, id };
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * ÚNICO ponto de escrita da trilha (append-only, garantido no PrismaService).
   * Chamado DENTRO da transação da mutação.
   */
  async record(
    db: AnyClient,
    workspaceId: string,
    action: string,
    input: {
      entityType: keyof typeof AUDIT_FIELDS | string;
      entityId: string;
      actor: AuditActorInput;
      before?: Record<string, unknown> | null;
      after?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const allowlist = AUDIT_FIELDS[input.entityType] ?? [];
    await db.auditLog.create({
      data: {
        workspaceId,
        action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorType: input.actor.type,
        actorMembershipId: input.actor.membershipId ?? null,
        actorId: input.actor.id ?? null,
        before: this.project(input.before, allowlist),
        after: this.project(input.after, allowlist),
        requestId: this.cls.get<string>('requestId') ?? null,
      },
    } as never);
  }

  /** Atalho para o ator "usuário desta sessão". */
  actorFrom(auth: AuthContext): AuditActorInput {
    return { type: 'user', membershipId: auth.membershipId };
  }

  async list(input: ListAuditInput): Promise<AuditPageDto> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    const where = {
      ...(input.entityType ? { entityType: input.entityType } : {}),
      ...(input.entityId ? { entityId: input.entityId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.from || input.to
        ? {
            createdAt: {
              ...(input.from ? { gte: new Date(input.from) } : {}),
              ...(input.to ? { lte: new Date(input.to) } : {}),
            },
          }
        : {}),
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    } as never);

    const page = rows.slice(0, input.limit);
    const names = await this.resolveActorNames(page.map((row) => row.actorMembershipId));
    const items: AuditEntryDto[] = page.map((row) => ({
      id: row.id,
      actorType: row.actorType,
      actorLabel: row.actorMembershipId ? (names.get(row.actorMembershipId) ?? null) : row.actorId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: (row.before as Record<string, unknown> | null) ?? null,
      after: (row.after as Record<string, unknown> | null) ?? null,
      requestId: row.requestId,
      createdAt: row.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * Retenção (SECURITY.md §5): expurga trilha além da janela configurada.
   * prisma.raw justificado — AuditLog é append-only no client protegido e a
   * limpeza é rotina administrativa cross-workspace.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.raw.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }

  /** Mantém só os campos da allowlist; o resto vira [changed] (sem valor). */
  private project(
    data: Record<string, unknown> | null | undefined,
    allowlist: readonly string[],
  ): Record<string, unknown> | null {
    if (!data) return null;
    const projected: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      projected[key] = allowlist.includes(key) ? value : REDACTED;
    }
    return projected;
  }

  private async resolveActorNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const membershipIds = [...new Set(ids.filter((id): id is string => id !== null))];
    if (membershipIds.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: membershipIds } },
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

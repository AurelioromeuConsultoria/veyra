import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateTaskInput,
  ListTasksInput,
  Paginated,
  TaskDto,
  UpdateTaskInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuthContext } from '../common/decorators';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  assigneeMembershipId: string | null;
  status: 'open' | 'done';
  priority: 'low' | 'normal' | 'high';
  contactId: string | null;
  dealId: string | null;
  completedAt: Date | null;
  createdAt: Date;
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly outbox: OutboxService,
  ) {}

  async list(input: ListTasksInput): Promise<Paginated<TaskDto>> {
    const where = {
      ...(input.status === 'all' ? {} : { status: input.status }),
      ...(input.assigneeMembershipId ? { assigneeMembershipId: input.assigneeMembershipId } : {}),
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.dealId ? { dealId: input.dealId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.db.task.count({ where } as never),
      this.prisma.db.task.findMany({
        where,
        orderBy: [
          { status: 'asc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'desc' },
        ],
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      } as never) as unknown as Promise<TaskRow[]>,
    ]);
    return {
      items: await this.toDtos(rows),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async create(auth: AuthContext, input: CreateTaskInput): Promise<TaskDto> {
    await this.validateReferences(input);
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction((tx) =>
      this.createWithin(tx, auth.workspaceId as string, input, {
        type: 'user',
        membershipId: auth.membershipId ?? null,
      }),
    );
    return this.get(id);
  }

  /**
   * Criação DENTRO de uma transação de quem chama. Existe para que a execução
   * de uma proposta de IA (reivindicar → criar → registrar → concluir) caiba
   * numa transação só: se qualquer etapa falhar, nada sobra pela metade.
   *
   * `actor.type = 'ai'` registra a mutação como da IA, preservando o aprovador
   * em `membershipId` como contexto de aprovação.
   */
  async createWithin(
    tx: Db,
    workspaceId: string,
    input: CreateTaskInput,
    actor: { type: 'user' | 'ai'; membershipId: string | null },
    /** cadeia de causalidade quando a tarefa nasce de automação (ADR-035) */
    causality?: { chainId: string | null; depth: number; originAutomationId: string },
  ): Promise<string> {
    const task = await tx.task.create({
      data: {
        // explícito: no db protegido é validado contra o CLS (igual = ok); numa
        // transação `raw` — como a da automação — é o próprio carimbo
        workspaceId,
        title: input.title,
        description: input.description ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        assigneeMembershipId: input.assigneeMembershipId ?? null,
        priority: input.priority,
        contactId: input.contactId ?? null,
        dealId: input.dealId ?? null,
      },
    } as never);
    await this.activities.record(tx, workspaceId, 'task_created', {
      actorMembershipId: actor.membershipId,
      actorType: actor.type,
      payload: { title: input.title },
      targets: { taskId: task.id, contactId: input.contactId, dealId: input.dealId },
    });
    const taskId = (task as unknown as { id: string }).id;
    // evento público (webhooks) e gatilho de automação, na MESMA transação
    await this.outbox.enqueue(
      tx,
      workspaceId,
      'task.created',
      { id: taskId, title: input.title },
      `task.created:${taskId}`,
      causality,
    );
    return taskId;
  }

  async update(auth: AuthContext, id: string, input: UpdateTaskInput): Promise<TaskDto> {
    const existing = (await this.prisma.db.task.findFirst({
      where: { id },
    })) as unknown as TaskRow | null;
    if (!existing) throw new NotFoundException('Tarefa não encontrada');
    await this.validateReferences(input);

    const completing = input.status === 'done' && existing.status === 'open';
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { id },
        data: {
          title: input.title,
          description: input.description,
          dueAt:
            input.dueAt === undefined
              ? undefined
              : input.dueAt === null
                ? null
                : new Date(input.dueAt),
          assigneeMembershipId: input.assigneeMembershipId,
          priority: input.priority,
          status: input.status,
          contactId: input.contactId,
          dealId: input.dealId,
          completedAt: completing ? new Date() : input.status === 'open' ? null : undefined,
        },
      });
      if (completing) {
        await this.activities.record(tx, auth.workspaceId as string, 'task_completed', {
          actorMembershipId: auth.membershipId,
          payload: { title: input.title ?? existing.title },
          targets: {
            taskId: id,
            contactId: input.contactId ?? existing.contactId,
            dealId: input.dealId ?? existing.dealId,
          },
        });
      }
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.db.task.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Tarefa não encontrada');
  }

  async get(id: string): Promise<TaskDto> {
    const row = (await this.prisma.db.task.findFirst({
      where: { id },
    })) as unknown as TaskRow | null;
    if (!row) throw new NotFoundException('Tarefa não encontrada');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  private async validateReferences(input: {
    contactId?: string | null;
    dealId?: string | null;
    assigneeMembershipId?: string | null;
  }): Promise<void> {
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId } });
      if (!contact) throw new BadRequestException('Contato inválido');
    }
    if (input.dealId) {
      const deal = await this.prisma.db.deal.findFirst({ where: { id: input.dealId } });
      if (!deal) throw new BadRequestException('Oportunidade inválida');
    }
    if (input.assigneeMembershipId) {
      const assignee = await this.prisma.db.membership.findFirst({
        where: { id: input.assigneeMembershipId, status: 'active' },
      });
      if (!assignee) throw new BadRequestException('Responsável inválido');
    }
  }

  private async toDtos(rows: TaskRow[]): Promise<TaskDto[]> {
    const names = await this.resolveNames(rows.map((r) => r.assigneeMembershipId));
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      dueAt: row.dueAt?.toISOString() ?? null,
      assigneeMembershipId: row.assigneeMembershipId,
      assigneeName: row.assigneeMembershipId ? (names.get(row.assigneeMembershipId) ?? null) : null,
      status: row.status,
      priority: row.priority,
      contactId: row.contactId,
      dealId: row.dealId,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async resolveNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: ids }, status: { not: 'removed' } },
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

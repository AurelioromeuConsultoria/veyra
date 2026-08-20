import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BoardDto,
  CreateDealInput,
  DealDto,
  MoveDealInput,
  UpdateDealInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuthContext } from '../common/decorators';
import type { Prisma } from '../generated/prisma/client';
import { PipelinesService } from '../pipelines/pipelines.service';
import { PrismaService, type Db } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/** Gaps de 1024 entre posições: milhares de inserções sem rebalancear. */
const POSITION_GAP = 1024;

type DealRow = {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  contactId: string | null;
  companyId: string | null;
  ownerMembershipId: string | null;
  amountCents: number;
  currency: string;
  expectedCloseDate: Date | null;
  status: 'open' | 'won' | 'lost';
  position: number;
  stageEnteredAt: Date;
  createdAt: Date;
  contact: { name: string } | null;
  company: { name: string } | null;
};

const DEAL_INCLUDE = { contact: true, company: true } as const;

@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
    private readonly activities: ActivitiesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async board(pipelineId?: string): Promise<BoardDto> {
    const id = pipelineId ?? (await this.pipelines.resolveDefault());
    const pipeline = (await this.prisma.db.pipeline.findFirst({
      where: { id },
      include: { stages: { orderBy: { order: 'asc' } } },
    } as never)) as unknown as {
      id: string;
      name: string;
      stages: { id: string; name: string; type: 'open' | 'won' | 'lost' }[];
    } | null;
    if (!pipeline) throw new NotFoundException('Pipeline não encontrado');

    const deals = (await this.prisma.db.deal.findMany({
      where: { pipelineId: id },
      include: DEAL_INCLUDE,
      // tiebreak por id: ordem estável mesmo com positions empatadas
      orderBy: [{ stageId: 'asc' }, { position: 'asc' }, { id: 'asc' }],
    } as never)) as unknown as DealRow[];
    const ownerNames = await this.resolveOwnerNames(deals.map((d) => d.ownerMembershipId));

    return {
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      columns: pipeline.stages.map((stage) => {
        const columnDeals = deals.filter((deal) => deal.stageId === stage.id);
        return {
          stageId: stage.id,
          stageName: stage.name,
          stageType: stage.type,
          totalCents: columnDeals.reduce((sum, deal) => sum + deal.amountCents, 0),
          deals: columnDeals.map((deal) => this.toDto(deal, ownerNames)),
        };
      }),
    };
  }

  async get(id: string): Promise<DealDto> {
    const row = (await this.prisma.db.deal.findFirst({
      where: { id },
      include: DEAL_INCLUDE,
    } as never)) as unknown as DealRow | null;
    if (!row) throw new NotFoundException('Oportunidade não encontrada');
    return this.toDto(row, await this.resolveOwnerNames([row.ownerMembershipId]));
  }

  async create(auth: AuthContext, input: CreateDealInput): Promise<DealDto> {
    const pipelineId = input.pipelineId ?? (await this.pipelines.resolveDefault());
    const stage = input.stageId
      ? await this.prisma.db.stage.findFirst({ where: { id: input.stageId, pipelineId } })
      : await this.prisma.db.stage.findFirst({
          where: { pipelineId, type: 'open' },
          orderBy: { order: 'asc' },
        });
    // stage de OUTRO pipeline (mesmo workspace) → rejeitado aqui e, em última
    // instância, pela FK tripla no banco (ajuste #1)
    if (!stage) throw new BadRequestException('Estágio inválido para este pipeline');
    await this.validateReferences(input);

    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      // creates concorrentes na mesma coluna podem ler o mesmo `last` e gravar
      // a MESMA position; a ordenação do board tem tiebreak determinístico
      // (position, id), então a ordem é estável mesmo com empate — e o próximo
      // move normaliza as posições da coluna sob o advisory lock.
      const last = await tx.deal.findFirst({
        where: { pipelineId, stageId: stage.id },
        orderBy: { position: 'desc' },
      });
      const deal = await tx.deal.create({
        data: {
          title: input.title,
          pipelineId,
          stageId: stage.id,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          ownerMembershipId: input.ownerMembershipId ?? null,
          amountCents: input.amountCents,
          currency: input.currency,
          expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
          status: stage.type === 'open' ? 'open' : stage.type,
          position: (last?.position ?? 0) + POSITION_GAP,
        },
      } as never);
      await this.activities.record(
        tx as unknown as Db,
        auth.workspaceId as string,
        'deal_created',
        {
          actorMembershipId: auth.membershipId,
          payload: { title: input.title, amountCents: input.amountCents },
          targets: { dealId: deal.id, contactId: input.contactId, companyId: input.companyId },
        },
      );
      await this.outbox.enqueue(
        tx as unknown as Db,
        auth.workspaceId as string,
        'deal.created',
        {
          id: deal.id,
          title: input.title,
          amountCents: input.amountCents,
          currency: input.currency,
        },
        `deal.created:${deal.id}`,
      );
      return deal.id;
    });
    return this.get(id);
  }

  async update(auth: AuthContext, id: string, input: UpdateDealInput): Promise<DealDto> {
    const existing = (await this.prisma.db.deal.findFirst({
      where: { id },
    })) as unknown as DealRow | null;
    if (!existing) throw new NotFoundException('Oportunidade não encontrada');
    await this.validateReferences(input);
    const data = {
      title: input.title,
      contactId: input.contactId,
      companyId: input.companyId,
      ownerMembershipId: input.ownerMembershipId,
      amountCents: input.amountCents,
      currency: input.currency,
      expectedCloseDate:
        input.expectedCloseDate === undefined
          ? undefined
          : input.expectedCloseDate === null
            ? null
            : new Date(input.expectedCloseDate),
    };
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.deal.updateMany({ where: { id }, data });
      // ajuste #8: alteração vira Activity (payload mínimo) E AuditLog
      // (before/after por allowlist) — o AuditLog é o registro de "o que mudou"
      await this.activities.record(
        tx as unknown as Db,
        auth.workspaceId as string,
        'deal_updated',
        {
          actorMembershipId: auth.membershipId,
          payload: { title: input.title ?? existing.title },
          targets: { dealId: id, contactId: existing.contactId, companyId: existing.companyId },
        },
      );
      await this.audit.record(tx, auth.workspaceId as string, 'deal.updated', {
        entityType: 'deal',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: {
          title: existing.title,
          amountCents: existing.amountCents,
          currency: existing.currency,
          ownerMembershipId: existing.ownerMembershipId,
        },
        after: { ...data, expectedCloseDate: undefined },
      });
    });
    return this.get(id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.deal.findFirst({
      where: { id },
    })) as unknown as DealRow | null;
    if (!existing) throw new NotFoundException('Oportunidade não encontrada');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      // ajuste #8: exclusão é SÓ AuditLog — uma Activity ligada ao Deal morreria
      // no cascade e não deixaria histórico útil
      await this.audit.record(tx, auth.workspaceId as string, 'deal.deleted', {
        entityType: 'deal',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: {
          title: existing.title,
          amountCents: existing.amountCents,
          status: existing.status,
        },
        after: null,
      });
      await tx.deal.deleteMany({ where: { id } });
    });
  }

  /**
   * Mover no kanban (ajuste #3): a seção crítica inteira roda sob ADVISORY LOCK
   * por (workspace, pipeline) — leitura das posições, cálculo e escrita. Dois
   * arrastos simultâneos serializam, então a ordem final é estável e sem
   * posições duplicadas. Sem o lock, ambos leriam o mesmo estado e colidiriam.
   */
  async move(auth: AuthContext, dealId: string, input: MoveDealInput): Promise<DealDto> {
    const workspaceId = auth.workspaceId as string;
    await this.prisma.raw.$transaction(async (tx) => {
      // pipelineId é IMUTÁVEL: pode ser lido antes só para compor a chave do lock
      const pipelineOf = await tx.deal.findFirst({
        where: { id: dealId, workspaceId },
        select: { pipelineId: true },
      });
      if (!pipelineOf) throw new NotFoundException('Oportunidade não encontrada');

      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        'veyra_board',
        `${workspaceId}:${pipelineOf.pipelineId}`,
      );

      // RELEITURA dentro da seção crítica: stageId/amount não podem vir de um
      // snapshot pré-lock — dois moves do MESMO deal gerariam Activity com
      // fromStage obsoleto (a timeline é append-only: evento errado é para sempre)
      const deal = await this.findScoped(tx, workspaceId, dealId);
      if (!deal) throw new NotFoundException('Oportunidade não encontrada');

      // stage precisa ser do MESMO pipeline (a FK tripla garante no banco)
      const stage = await tx.stage.findFirst({
        where: { id: input.stageId, workspaceId, pipelineId: deal.pipelineId },
      });
      if (!stage) throw new BadRequestException('Estágio inválido para este pipeline');

      // recalcula posições da coluna-alvo DENTRO do lock
      const columnDeals = await tx.deal.findMany({
        where: { workspaceId, pipelineId: deal.pipelineId, stageId: stage.id, id: { not: dealId } },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      const index = Math.min(input.index ?? columnDeals.length, columnDeals.length);
      const ordered = [
        ...columnDeals.slice(0, index).map((d) => d.id),
        dealId,
        ...columnDeals.slice(index).map((d) => d.id),
      ];
      for (const [slot, id] of ordered.entries()) {
        await tx.deal.updateMany({
          where: { id, workspaceId },
          data: { position: (slot + 1) * POSITION_GAP },
        });
      }

      const movedStage = deal.stageId !== stage.id;
      if (movedStage) {
        const fromStage = await tx.stage.findFirst({
          where: { id: deal.stageId, workspaceId },
          select: { name: true },
        });
        await tx.deal.updateMany({
          where: { id: dealId, workspaceId },
          data: {
            stageId: stage.id,
            status: stage.type === 'open' ? 'open' : stage.type,
            stageEnteredAt: new Date(),
          },
        });
        await this.activities.record(tx as unknown as Db, workspaceId, 'deal_stage_changed', {
          actorMembershipId: auth.membershipId,
          payload: { fromStage: fromStage?.name ?? '—', toStage: stage.name },
          targets: { dealId, contactId: deal.contactId, companyId: deal.companyId },
        });
        await this.outbox.enqueue(
          tx as unknown as Db,
          workspaceId,
          'deal.stage_changed',
          { id: dealId, fromStage: fromStage?.name ?? '—', toStage: stage.name },
          `deal.stage_changed:${dealId}:${stage.id}:${Date.now()}`,
        );
        if (stage.type === 'won' || stage.type === 'lost') {
          await this.activities.record(
            tx as unknown as Db,
            workspaceId,
            stage.type === 'won' ? 'deal_won' : 'deal_lost',
            {
              actorMembershipId: auth.membershipId,
              payload: { amountCents: deal.amountCents },
              targets: { dealId, contactId: deal.contactId, companyId: deal.companyId },
            },
          );
          await this.outbox.enqueue(
            tx as unknown as Db,
            workspaceId,
            stage.type === 'won' ? 'deal.won' : 'deal.lost',
            { id: dealId, amountCents: deal.amountCents },
            `deal.${stage.type}:${dealId}`,
          );
        }
      }
    });
    return this.get(dealId);
  }

  // ── internos ───────────────────────────────────────────────────────────────

  /** raw dentro do lock: escopo por workspaceId SEMPRE explícito no where. */
  private findScoped(tx: Tx, workspaceId: string, dealId: string) {
    return tx.deal.findFirst({
      where: { id: dealId, workspaceId },
      select: {
        id: true,
        pipelineId: true,
        stageId: true,
        amountCents: true,
        contactId: true,
        companyId: true,
      },
    });
  }

  private async validateReferences(input: {
    contactId?: string | null;
    companyId?: string | null;
    ownerMembershipId?: string | null;
  }): Promise<void> {
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId } });
      if (!contact) throw new BadRequestException('Contato inválido');
    }
    if (input.companyId) {
      const company = await this.prisma.db.company.findFirst({ where: { id: input.companyId } });
      if (!company) throw new BadRequestException('Empresa inválida');
    }
    if (input.ownerMembershipId) {
      const owner = await this.prisma.db.membership.findFirst({
        where: { id: input.ownerMembershipId, status: 'active' },
      });
      if (!owner) throw new BadRequestException('Responsável inválido');
    }
  }

  private toDto(row: DealRow, ownerNames: Map<string, string>): DealDto {
    const days = Math.floor((Date.now() - row.stageEnteredAt.getTime()) / 86_400_000);
    return {
      id: row.id,
      title: row.title,
      pipelineId: row.pipelineId,
      stageId: row.stageId,
      contactId: row.contactId,
      contactName: row.contact?.name ?? null,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      ownerMembershipId: row.ownerMembershipId,
      ownerName: row.ownerMembershipId ? (ownerNames.get(row.ownerMembershipId) ?? null) : null,
      amountCents: row.amountCents,
      currency: row.currency,
      expectedCloseDate: row.expectedCloseDate?.toISOString() ?? null,
      status: row.status,
      position: row.position,
      daysInStage: Math.max(0, days),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async resolveOwnerNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
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

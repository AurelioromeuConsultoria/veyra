import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ClinicsServiceDto,
  CreateClinicsServiceInput,
  UpdateClinicsServiceInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
type ServiceRow = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number | null;
  currency: string;
  archivedAt: Date | null;
};

/**
 * Serviços do catálogo (ADR-048 adendo 1, item 1). Classe C. Arquivados,
 * nunca apagados: a agenda da F2 vai referenciá-los.
 */
@Injectable()
export class ClinicsServiceCatalog {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeArchived: boolean): Promise<ClinicsServiceDto[]> {
    const rows = (await this.prisma.db.clinicsService.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { name: 'asc' },
      // teto SEM paginação: dívida com gatilho (technical-debt.md)
      take: 500,
    })) as unknown as ServiceRow[];
    return rows.map(toDto);
  }

  async create(auth: AuthContext, input: CreateClinicsServiceInput): Promise<ClinicsServiceDto> {
    const workspaceId = auth.workspaceId as string;
    return (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const row = (await tx.clinicsService.create({
        data: {
          name: input.name,
          durationMin: input.durationMin,
          priceCents: input.priceCents,
          currency: input.currency,
        },
      } as never)) as unknown as ServiceRow;
      await this.audit.record(tx, workspaceId, 'clinics.service.created', {
        entityType: 'clinicsService',
        entityId: row.id,
        actor: this.audit.actorFrom(auth),
        after: {
          name: row.name,
          durationMin: row.durationMin,
          priceCents: row.priceCents,
          currency: row.currency,
        },
      });
      return toDto(row);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateClinicsServiceInput,
  ): Promise<ClinicsServiceDto> {
    const workspaceId = auth.workspaceId as string;
    return (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      // TRAVA antes de ler o `before` (dois PATCH simultâneos viram seriais)
      const { count } = await tx.clinicsService.updateMany({
        where: { id },
        data: { updatedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException('Serviço não encontrado');
      const before = await this.find(tx, id);
      await tx.clinicsService.updateMany({
        where: { id },
        data: { name: input.name, durationMin: input.durationMin, priceCents: input.priceCents },
      });
      const changed = (key: keyof UpdateClinicsServiceInput) =>
        input[key] === undefined ? undefined : before[key];
      await this.audit.record(tx, workspaceId, 'clinics.service.updated', {
        entityType: 'clinicsService',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: {
          name: changed('name'),
          durationMin: changed('durationMin'),
          priceCents: changed('priceCents'),
        },
        after: { name: input.name, durationMin: input.durationMin, priceCents: input.priceCents },
      });
      return toDto(await this.find(tx, id));
    });
  }

  /** Arquivar e desarquivar são idempotentes: repetir não audita de novo. */
  async setArchived(auth: AuthContext, id: string, archived: boolean): Promise<ClinicsServiceDto> {
    const workspaceId = auth.workspaceId as string;
    return (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const { count } = await tx.clinicsService.updateMany({
        where: { id, archivedAt: archived ? null : { not: null } },
        data: { archivedAt: archived ? new Date() : null },
      });
      const row = await this.find(tx, id);
      if (count > 0) {
        await this.audit.record(
          tx,
          workspaceId,
          archived ? 'clinics.service.archived' : 'clinics.service.unarchived',
          {
            entityType: 'clinicsService',
            entityId: id,
            actor: this.audit.actorFrom(auth),
            after: { archivedAt: row.archivedAt },
          },
        );
      }
      return toDto(row);
    });
  }

  private async find(tx: Db, id: string): Promise<ServiceRow> {
    const row = (await tx.clinicsService.findFirst({
      where: { id },
    })) as unknown as ServiceRow | null;
    if (!row) throw new NotFoundException('Serviço não encontrado');
    return row;
  }
}

function toDto(row: ServiceRow): ClinicsServiceDto {
  return {
    id: row.id,
    name: row.name,
    durationMin: row.durationMin,
    priceCents: row.priceCents,
    currency: row.currency,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

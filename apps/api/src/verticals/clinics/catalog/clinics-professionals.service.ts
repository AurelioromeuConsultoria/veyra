import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClinicsProfessionalDto,
  ClinicsWorkingIntervalDto,
  SetClinicsWorkingHoursInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
type ProfessionalRow = {
  id: string;
  name: string;
  membershipId: string | null;
  archivedAt: Date | null;
  membership: { status: string } | null;
  services: { serviceId: string }[];
  workingHours: ClinicsWorkingIntervalDto[];
};

const INCLUDE = {
  membership: { select: { status: true } },
  // CONJUNTO: ordem determinística (os vínculos nascem no mesmo createMany)
  services: { select: { serviceId: true }, orderBy: { serviceId: 'asc' } },
  workingHours: {
    select: { unitId: true, weekday: true, startMinute: true, endMinute: true },
    orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
  },
} as const;

/**
 * Profissionais (ADR-048 §3 e adendo 1, itens 3 a 5). Classe P: só o nome. O
 * vínculo com conta, os serviços habilitados e os horários são substituídos
 * por inteiro, numa transação, sob trava da linha do profissional — duas
 * edições simultâneas viram seriais, e a última vale por inteiro.
 */
@Injectable()
export class ClinicsProfessionalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeArchived: boolean): Promise<ClinicsProfessionalDto[]> {
    const rows = (await this.prisma.db.clinicsProfessional.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: INCLUDE,
      orderBy: { name: 'asc' },
      // teto SEM paginação: dívida com gatilho (technical-debt.md)
      take: 500,
    } as never)) as unknown as ProfessionalRow[];
    return rows.map(toDto);
  }

  async create(auth: AuthContext, name: string): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      const row = (await tx.clinicsProfessional.create({ data: { name } } as never)) as unknown as {
        id: string;
      };
      await this.audit.record(tx, workspaceId, 'clinics.professional.created', {
        entityType: 'clinicsProfessional',
        entityId: row.id,
        actor: this.audit.actorFrom(auth),
        after: { name }, // classe P: vira [changed] na trilha
      });
      return this.find(tx, row.id);
    });
  }

  async rename(auth: AuthContext, id: string, name: string): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      const before = await this.lock(tx, id);
      await tx.clinicsProfessional.updateMany({ where: { id }, data: { name } });
      await this.audit.record(tx, workspaceId, 'clinics.professional.updated', {
        entityType: 'clinicsProfessional',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        // classe P: os dois viram [changed] na trilha (fora da allowlist)
        before: { name: before.name },
        after: { name },
      });
      return this.find(tx, id);
    });
  }

  /** Idempotente: repetir não audita de novo. */
  async setArchived(
    auth: AuthContext,
    id: string,
    archived: boolean,
  ): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      const { count } = await tx.clinicsProfessional.updateMany({
        where: { id, archivedAt: archived ? null : { not: null } },
        data: { archivedAt: archived ? new Date() : null },
      });
      const row = await this.find(tx, id);
      if (count > 0) {
        await this.audit.record(
          tx,
          workspaceId,
          archived ? 'clinics.professional.archived' : 'clinics.professional.unarchived',
          {
            entityType: 'clinicsProfessional',
            entityId: id,
            actor: this.audit.actorFrom(auth),
            after: { archivedAt: row.archivedAt },
          },
        );
      }
      return row;
    });
  }

  /**
   * Vincula (ou desvincula, com `null`) uma conta. Só conta ATIVA deste
   * workspace; no máximo um profissional por conta (o unique do banco cobre a
   * corrida, com 409). Vincular NÃO muda papel nenhum (ADR-048 §3).
   */
  async setAccount(
    auth: AuthContext,
    id: string,
    membershipId: string | null,
  ): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      const before = await this.lock(tx, id);
      // repetir o MESMO vínculo não faz nada — nem revalida a conta, que pode ter
      // sido removida depois (o vínculo fica, sinalizado, até alguém desfazê-lo)
      if (before.membershipId === membershipId) return this.find(tx, id);
      if (membershipId !== null) {
        const conta = await tx.membership.findFirst({
          where: { id: membershipId, status: 'active' },
          select: { id: true },
        });
        if (!conta) throw new BadRequestException('Conta não encontrada ou inativa');
        const outro = await tx.clinicsProfessional.findFirst({
          where: { membershipId, id: { not: id } },
          select: { id: true },
        });
        if (outro) throw new ConflictException('Esta conta já está vinculada a outro profissional');
      }
      await tx.clinicsProfessional.updateMany({ where: { id }, data: { membershipId } });
      await this.audit.record(
        tx,
        workspaceId,
        membershipId
          ? 'clinics.professional.account_linked'
          : 'clinics.professional.account_unlinked',
        {
          entityType: 'clinicsProfessional',
          entityId: id,
          actor: this.audit.actorFrom(auth),
          before: { membershipId: before.membershipId },
          after: { membershipId },
        },
      );
      return this.find(tx, id);
    });
  }

  /**
   * O CONJUNTO de serviços que o profissional faz. Só serviços ATIVOS deste
   * workspace; um vínculo com serviço arquivado sai quando o conjunto é
   * substituído (a tela só oferece os ativos).
   */
  async setServices(
    auth: AuthContext,
    id: string,
    serviceIds: string[],
  ): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      await this.lock(tx, id);
      if (serviceIds.length > 0) {
        const ativos = await tx.clinicsService.count({
          where: { id: { in: serviceIds }, archivedAt: null },
        });
        if (ativos !== serviceIds.length) {
          throw new BadRequestException('Serviço inexistente ou arquivado');
        }
      }
      await tx.clinicsProfessionalService.deleteMany({ where: { professionalId: id } });
      if (serviceIds.length > 0) {
        await tx.clinicsProfessionalService.createMany({
          data: serviceIds.map((serviceId) => ({ professionalId: id, serviceId })),
        } as never);
      }
      await this.audit.record(tx, workspaceId, 'clinics.professional.services_replaced', {
        entityType: 'clinicsProfessional',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        after: { serviceIds },
      });
      return this.find(tx, id);
    });
  }

  /**
   * A SEMANA inteira. O contrato já recusou sobreposição no pedido (400); o
   * EXCLUDE do banco é a última linha (23P01 → 409, filtro global). Só
   * unidades ativas deste workspace. A trilha guarda a quantidade, nunca os
   * horários (classe P).
   */
  async setWorkingHours(
    auth: AuthContext,
    id: string,
    input: SetClinicsWorkingHoursInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.inTx(auth, async (tx, workspaceId) => {
      await this.lock(tx, id);
      const unitIds = [...new Set(input.intervals.map((interval) => interval.unitId))];
      if (unitIds.length > 0) {
        const ativas = await tx.clinicsUnit.count({
          where: { id: { in: unitIds }, archivedAt: null },
        });
        if (ativas !== unitIds.length) {
          throw new BadRequestException('Unidade inexistente ou arquivada');
        }
      }
      await tx.clinicsWorkingHours.deleteMany({ where: { professionalId: id } });
      if (input.intervals.length > 0) {
        await tx.clinicsWorkingHours.createMany({
          data: input.intervals.map((interval) => ({ ...interval, professionalId: id })),
        } as never);
      }
      await this.audit.record(tx, workspaceId, 'clinics.professional.hours_replaced', {
        entityType: 'clinicsProfessional',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        // a QUANTIDADE, com nome que não admite os horários em si (classe P)
        after: { intervalCount: input.intervals.length },
      });
      return this.find(tx, id);
    });
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private inTx<T>(auth: AuthContext, fn: (tx: Db, workspaceId: string) => Promise<T>): Promise<T> {
    const workspaceId = auth.workspaceId as string;
    return (this.prisma.db as unknown as TxRunner).$transaction((tx) => fn(tx, workspaceId));
  }

  /**
   * TRAVA a linha do profissional antes de qualquer efeito (o mesmo padrão de
   * `ContactsService.lockAndRead`): substituições simultâneas viram seriais.
   */
  private async lock(tx: Db, id: string): Promise<{ name: string; membershipId: string | null }> {
    const { count } = await tx.clinicsProfessional.updateMany({
      where: { id },
      data: { updatedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Profissional não encontrado');
    return (await tx.clinicsProfessional.findFirst({
      where: { id },
      select: { name: true, membershipId: true },
    })) as { name: string; membershipId: string | null };
  }

  private async find(tx: Db, id: string): Promise<ClinicsProfessionalDto> {
    const row = (await tx.clinicsProfessional.findFirst({
      where: { id },
      include: INCLUDE,
    } as never)) as unknown as ProfessionalRow | null;
    if (!row) throw new NotFoundException('Profissional não encontrado');
    return toDto(row);
  }
}

function toDto(row: ProfessionalRow): ClinicsProfessionalDto {
  return {
    id: row.id,
    name: row.name,
    account: row.membershipId
      ? { membershipId: row.membershipId, active: row.membership?.status === 'active' }
      : null,
    serviceIds: row.services.map((link) => link.serviceId),
    workingHours: row.workingHours.map((interval) => ({
      unitId: interval.unitId,
      weekday: interval.weekday,
      startMinute: interval.startMinute,
      endMinute: interval.endMinute,
    })),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

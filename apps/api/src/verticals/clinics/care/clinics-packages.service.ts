import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ClinicsPackageDto,
  ClinicsPackageStatus,
  CreateClinicsPackageInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

export type PackageRow = {
  id: string;
  patientId: string;
  serviceId: string;
  totalSessions: number;
  consumedSessions: number;
  totalPriceCents: number | null;
  currency: string;
  status: ClinicsPackageStatus;
  createdAt: Date;
  closedAt: Date | null;
};

/**
 * Pacote de sessões (ADR-048 adendo 7, F3.1). Classe S.
 *
 * O contador de sessões tem DOIS donos de escrita, e só dois: o registro de
 * atendimento (o consumo, `ClinicsAttendanceService`) e o cancelamento, aqui.
 * O banco guarda o resto: o CHECK mantém o intervalo, e o trigger recusa mudar
 * paciente, serviço, total, preço e moeda, recusa consumo que não seja `+1` com
 * o pacote ativo e passa a `completed` na última sessão, na mesma instrução.
 */
@Injectable()
export class ClinicsPackagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * O preço é o TOTAL digitado e confirmado por quem cria: ausente é "não
   * informado", nunca zero. A moeda vem do serviço. Nasce com zero consumidas.
   */
  async create(auth: AuthContext, input: CreateClinicsPackageInput): Promise<ClinicsPackageDto> {
    const workspaceId = auth.workspaceId as string;
    const row = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const paciente = await tx.clinicsPatient.findFirst({
        where: { id: input.patientId },
        select: { id: true },
      });
      if (!paciente) throw new NotFoundException('Paciente não encontrado');
      const servico = (await tx.clinicsService.findFirst({
        where: { id: input.serviceId },
        select: { currency: true, archivedAt: true },
      })) as unknown as { currency: string; archivedAt: Date | null } | null;
      if (!servico) throw new NotFoundException('Serviço não encontrado');
      if (servico.archivedAt)
        throw new ConflictException('Serviço arquivado não aceita pacote novo');
      const criado = (await tx.clinicsPackage.create({
        data: {
          workspaceId,
          patientId: input.patientId,
          serviceId: input.serviceId,
          totalSessions: input.totalSessions,
          totalPriceCents: input.totalPriceCents ?? null,
          currency: servico.currency,
          createdByMembershipId: auth.membershipId as string,
        },
      } as never)) as unknown as PackageRow;
      await this.audit.record(tx, workspaceId, 'clinics.package.created', {
        entityType: 'clinicsPackage',
        entityId: criado.id,
        actor: this.audit.actorFrom(auth),
        after: trilha(criado),
      });
      return criado;
    });
    return toPackageDto(row);
  }

  async listByPatient(patientId: string): Promise<ClinicsPackageDto[]> {
    const rows = (await this.prisma.db.clinicsPackage.findMany({
      where: { patientId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    })) as unknown as PackageRow[];
    return rows.map(toPackageDto);
  }

  async get(id: string): Promise<ClinicsPackageDto> {
    const row = (await this.prisma.db.clinicsPackage.findFirst({
      where: { id },
    })) as unknown as PackageRow | null;
    if (!row) throw new NotFoundException('Pacote não encontrado');
    return toPackageDto(row);
  }

  /**
   * Cancelar só muda o ESTADO, sem incremento, e só de um pacote ativo. A
   * corrida com a última sessão: se o consumo concluiu o pacote primeiro, o
   * cancelamento NÃO o transforma em `canceled` e responde 409. Repetir sobre um
   * pacote já cancelado devolve o estado atual.
   */
  async cancel(auth: AuthContext, id: string): Promise<ClinicsPackageDto> {
    const workspaceId = auth.workspaceId as string;
    const row = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      // a transição TRAVA a linha: um consumo concorrente espera aqui, e o
      // que vier depois reavalia o estado (READ COMMITTED)
      const { count } = await tx.clinicsPackage.updateMany({
        where: { id, status: 'active' },
        data: { status: 'canceled' },
      } as never);
      const atual = (await tx.clinicsPackage.findFirst({
        where: { id },
      })) as unknown as PackageRow | null;
      if (!atual) throw new NotFoundException('Pacote não encontrado');
      if (count === 0) {
        if (atual.status === 'canceled') return atual;
        throw new ConflictException('Pacote concluído não pode ser cancelado');
      }
      await this.audit.record(tx, workspaceId, 'clinics.package.canceled', {
        entityType: 'clinicsPackage',
        entityId: atual.id,
        actor: this.audit.actorFrom(auth),
        after: trilha(atual),
      });
      return atual;
    });
    return toPackageDto(row);
  }
}

/** A trilha do pacote: ids, contagens e estado; do preço, só se existe. */
export function trilha(row: PackageRow): Record<string, unknown> {
  return {
    patientId: row.patientId,
    serviceId: row.serviceId,
    totalSessions: row.totalSessions,
    consumedSessions: row.consumedSessions,
    status: row.status,
    hasPrice: row.totalPriceCents !== null,
  };
}

export function toPackageDto(row: PackageRow): ClinicsPackageDto {
  return {
    id: row.id,
    patientId: row.patientId,
    serviceId: row.serviceId,
    totalSessions: row.totalSessions,
    consumedSessions: row.consumedSessions,
    remainingSessions: row.totalSessions - row.consumedSessions,
    totalPriceCents: row.totalPriceCents,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClinicsUnitDto, UpdateClinicsUnitInput } from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
type UnitRow = { id: string; name: string; timezone: string };

/**
 * Unidade da clínica (ADR-048 adendo 1, item 2). No MVP é UMA por workspace,
 * criada pela ativação: a API só lê e edita nome e fuso — não cria nem arquiva.
 */
@Injectable()
export class ClinicsUnitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ClinicsUnitDto[]> {
    const rows = (await this.prisma.db.clinicsUnit.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'asc' },
    })) as unknown as UnitRow[];
    return rows.map(toDto);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateClinicsUnitInput,
  ): Promise<ClinicsUnitDto> {
    const workspaceId = auth.workspaceId as string;
    return (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      // TRAVA antes de ler o `before`: dois PATCH simultâneos viram seriais, e a
      // trilha de cada um registra o valor que ele de fato substituiu
      const { count } = await tx.clinicsUnit.updateMany({
        where: { id, archivedAt: null },
        data: { updatedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException('Unidade não encontrada');
      const before = (await tx.clinicsUnit.findFirst({ where: { id } })) as unknown as UnitRow;
      // mudar o fuso moveria a leitura LOCAL de compromissos já combinados
      // (ADR-048 adendo 2, item 4; adendo 4, item 9). A trava acima serializa
      // com quem agenda, que trava a mesma linha.
      if (input.timezone !== undefined && input.timezone !== before.timezone) {
        const futuro = await tx.clinicsAppointment.findFirst({
          where: {
            unitId: id,
            status: { in: ['scheduled', 'confirmed', 'arrived'] },
            // pelo FIM: um atendimento em andamento também prende o fuso
            endsAt: { gt: new Date() },
          },
          select: { id: true },
        } as never);
        if (futuro) {
          throw new ConflictException(
            'Há agendamentos futuros nesta unidade: o fuso não pode mudar enquanto existirem',
          );
        }
      }
      await tx.clinicsUnit.updateMany({
        where: { id },
        data: { name: input.name, timezone: input.timezone },
      });
      await this.audit.record(tx, workspaceId, 'clinics.unit.updated', {
        entityType: 'clinicsUnit',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: {
          name: input.name === undefined ? undefined : before.name,
          timezone: input.timezone === undefined ? undefined : before.timezone,
        },
        after: { name: input.name, timezone: input.timezone },
      });
      return toDto({ ...before, ...stripUndefined(input) });
    });
  }
}

function toDto(row: UnitRow): ClinicsUnitDto {
  return { id: row.id, name: row.name, timezone: row.timezone };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

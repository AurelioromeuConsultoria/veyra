import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import type {
  ClinicsAppointmentStatus,
  ClinicsAttendanceDto,
  ClinicsPackageStatus,
  ClinicsPermissionKey,
  RecordClinicsAttendanceInput,
} from '@veyra/contracts/verticals/clinics';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { trilha, type PackageRow } from '../care/clinics-packages.service';
import { ROTULO } from './clinics-appointments.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
type AttendanceRow = {
  id: string;
  appointmentId: string;
  professionalId: string;
  completedAt: Date;
  packageId: string | null;
};

/** De onde o atendimento pode ser registrado (H1: chegada não é obrigatória). */
const ATENDIVEIS: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived'];

/**
 * Registro de atendimento (ADR-048 adendo 2, item 5; adendo 4, item 7).
 * Classe S, 1:1 com o agendamento, criado na MESMA transação que o leva a
 * `attended`. Repetir devolve o registro existente; duas chamadas simultâneas
 * resultam em um só.
 *
 * O CONSUMO de pacote (adendo 7, F3.1) é explícito e acontece SÓ no caminho que
 * cria o registro, na mesma transação que a transição, o vínculo e a
 * auditoria: qualquer falha desfaz as quatro coisas, inclusive o `attended`.
 * Não existe recuo silencioso para "avulso".
 */
@Injectable()
export class ClinicsAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  async record(
    auth: AuthContext,
    appointmentId: string,
    input: RecordClinicsAttendanceInput,
  ): Promise<ClinicsAttendanceDto> {
    const workspaceId = auth.workspaceId as string;
    // `null` e ausente são a MESMA escolha: avulso. O id vai em minúsculas,
    // como o banco o devolve, para a repetição idêntica não virar 409
    const escolha = input.packageId?.toLowerCase() ?? null;
    // consumir pacote revela o estado dele (as recusas dizem por quê): quem
    // escolhe pacote precisa poder lê-lo. A regra mora AQUI, e não na rota,
    // para valer a qualquer chamador futuro (ADR-048 adendo 7)
    if (escolha) {
      const careRead = 'clinics:care:read' satisfies ClinicsPermissionKey;
      if (!(await this.permissions.has(auth, careRead as PermissionKey))) {
        throw new ForbiddenException('Consumir pacote exige a leitura do atendimento');
      }
    }
    try {
      const row = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        // a repetição é consultada ANTES de qualquer consumo: o mesmo pedido
        // funciona mesmo com o pacote já concluído ou cancelado
        const existente = await registroDe(tx, appointmentId);
        if (existente) return repeticao(existente, escolha);
        // a transição TRAVA a linha: uma chamada concorrente espera aqui e,
        // depois do commit desta, não acha mais o estado de origem
        const { count } = await tx.clinicsAppointment.updateMany({
          where: { id: appointmentId, status: { in: ATENDIVEIS } },
          data: { status: 'attended' },
        } as never);
        if (count === 0) {
          const vencedor = await registroDe(tx, appointmentId);
          if (vencedor) return repeticao(vencedor, escolha);
          const agendamento = (await tx.clinicsAppointment.findFirst({
            where: { id: appointmentId },
            select: { status: true },
          })) as unknown as { status: ClinicsAppointmentStatus } | null;
          if (!agendamento) throw new NotFoundException('Agendamento não encontrado');
          throw new ConflictException(
            `Agendamento com estado ${ROTULO[agendamento.status]} não aceita registro de atendimento`,
          );
        }
        const agendamento = (await tx.clinicsAppointment.findFirst({
          where: { id: appointmentId },
          select: { professionalId: true, patientId: true, serviceId: true },
        })) as unknown as { professionalId: string; patientId: string; serviceId: string };
        const consumido = escolha ? await consumir(tx, escolha, agendamento) : null;
        const criado = (await tx.clinicsAttendance.create({
          data: {
            workspaceId,
            appointmentId,
            professionalId: agendamento.professionalId,
            completedAt: new Date(),
            recordedByMembershipId: auth.membershipId as string,
            packageId: escolha,
          },
        } as never)) as unknown as AttendanceRow;
        await this.audit.record(tx, workspaceId, 'clinics.attendance.recorded', {
          entityType: 'clinicsAttendance',
          entityId: criado.id,
          actor: this.audit.actorFrom(auth),
          after: {
            appointmentId,
            professionalId: criado.professionalId,
            completedAt: criado.completedAt.toISOString(),
            packageId: criado.packageId,
          },
        });
        // a ÚLTIMA sessão concluiu o pacote, na mesma instrução do consumo: o
        // fato entra na trilha do pacote, na mesma transação
        if (consumido?.status === 'completed') {
          await this.audit.record(tx, workspaceId, 'clinics.package.completed', {
            entityType: 'clinicsPackage',
            entityId: consumido.id,
            actor: this.audit.actorFrom(auth),
            after: trilha(consumido),
          });
        }
        return criado;
      });
      return toDto(row);
    } catch (error) {
      // última linha: o unique por agendamento venceu uma corrida que a trava
      // não pegou — vale o registro que existe, com a MESMA escolha
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const vencedor = await registroDe(this.prisma.db, appointmentId);
        if (vencedor) return toDto(repeticao(vencedor, escolha));
      }
      throw error;
    }
  }

  async get(appointmentId: string): Promise<ClinicsAttendanceDto> {
    const row = await registroDe(this.prisma.db, appointmentId);
    if (!row) throw new NotFoundException('Atendimento não registrado');
    return toDto(row);
  }
}

async function registroDe(db: Db, appointmentId: string): Promise<AttendanceRow | null> {
  return (await db.clinicsAttendance.findFirst({
    where: { appointmentId },
  })) as unknown as AttendanceRow | null;
}

function toDto(row: AttendanceRow): ClinicsAttendanceDto {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    professionalId: row.professionalId,
    completedAt: row.completedAt.toISOString(),
    packageId: row.packageId,
  };
}

/**
 * A repetição: o MESMO pedido (mesma escolha de pacote, ou avulso) devolve o
 * registro existente, sem novo consumo. Uma escolha DIFERENTE — outro pacote,
 * avulso no lugar de pacote ou o contrário — é 409: o servidor não finge que
 * aplicou a nova escolha.
 */
function repeticao(existente: AttendanceRow, escolha: string | null): AttendanceRow {
  if ((existente.packageId ?? null) === escolha) return existente;
  throw new ConflictException(
    'Este atendimento já foi registrado com outra escolha; a nova não foi aplicada',
  );
}

/**
 * O CONSUMO: um único `UPDATE` condicional (`+1` com o pacote ativo, do mesmo
 * paciente e do mesmo serviço). A trava de linha serializa consumos e
 * cancelamentos concorrentes; na última sessão, o trigger do banco passa o
 * pacote a `completed` na MESMA instrução. Zero linhas: o motivo é lido e a
 * transação inteira volta — sem atendimento.
 */
async function consumir(
  tx: Db,
  packageId: string,
  agendamento: { patientId: string; serviceId: string },
): Promise<PackageRow> {
  const { count } = await tx.clinicsPackage.updateMany({
    where: {
      id: packageId,
      status: 'active',
      patientId: agendamento.patientId,
      serviceId: agendamento.serviceId,
    },
    data: { consumedSessions: { increment: 1 } },
  } as never);
  if (count === 1) {
    // o estado DEPOIS do consumo (a última sessão já o concluiu)
    return (await tx.clinicsPackage.findFirst({
      where: { id: packageId },
    })) as unknown as PackageRow;
  }
  const pacote = (await tx.clinicsPackage.findFirst({
    where: { id: packageId },
    select: { status: true, patientId: true, serviceId: true },
  })) as unknown as { status: ClinicsPackageStatus; patientId: string; serviceId: string } | null;
  if (!pacote) throw new NotFoundException('Pacote não encontrado');
  if (pacote.patientId !== agendamento.patientId || pacote.serviceId !== agendamento.serviceId) {
    throw new BadRequestException('O pacote é de outro paciente ou de outro serviço');
  }
  throw new ConflictException(
    pacote.status === 'completed'
      ? 'Pacote concluído: não há sessões a consumir; o atendimento não foi registrado'
      : 'Pacote cancelado: o atendimento não foi registrado',
  );
}

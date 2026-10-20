import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ClinicsAppointmentStatus,
  ClinicsAttendanceDto,
} from '@veyra/contracts/verticals/clinics';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { ROTULO } from './clinics-appointments.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
type AttendanceRow = {
  id: string;
  appointmentId: string;
  professionalId: string;
  completedAt: Date;
};

/** De onde o atendimento pode ser registrado (H1: chegada não é obrigatória). */
const ATENDIVEIS: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived'];

/**
 * Registro de atendimento (ADR-048 adendo 2, item 5; adendo 4, item 7).
 * Classe S, 1:1 com o agendamento, criado na MESMA transação que o leva a
 * `attended`. Repetir devolve o registro existente; duas chamadas simultâneas
 * resultam em um só.
 */
@Injectable()
export class ClinicsAttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(auth: AuthContext, appointmentId: string): Promise<ClinicsAttendanceDto> {
    const workspaceId = auth.workspaceId as string;
    try {
      const row = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        const existente = await registroDe(tx, appointmentId);
        if (existente) return existente;
        // a transição TRAVA a linha: uma chamada concorrente espera aqui e,
        // depois do commit desta, não acha mais o estado de origem
        const { count } = await tx.clinicsAppointment.updateMany({
          where: { id: appointmentId, status: { in: ATENDIVEIS } },
          data: { status: 'attended' },
        } as never);
        if (count === 0) {
          const vencedor = await registroDe(tx, appointmentId);
          if (vencedor) return vencedor;
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
          select: { professionalId: true },
        })) as unknown as { professionalId: string };
        const criado = (await tx.clinicsAttendance.create({
          data: {
            workspaceId,
            appointmentId,
            professionalId: agendamento.professionalId,
            completedAt: new Date(),
            recordedByMembershipId: auth.membershipId as string,
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
          },
        });
        return criado;
      });
      return toDto(row);
    } catch (error) {
      // última linha: o unique por agendamento venceu uma corrida que a trava
      // não pegou — vale o registro que existe
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const vencedor = await registroDe(this.prisma.db, appointmentId);
        if (vencedor) return toDto(vencedor);
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
  };
}

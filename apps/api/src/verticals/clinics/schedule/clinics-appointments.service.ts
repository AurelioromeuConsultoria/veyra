import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ChangeClinicsAppointmentStatusInput,
  ClinicsAppointmentDto,
  ClinicsAppointmentStatus,
  ClinicsCancelReason,
  CreateClinicsAppointmentInput,
  ListClinicsAppointmentsInput,
  RescheduleClinicsAppointmentInput,
} from '@veyra/contracts/verticals/clinics';
import {
  deslocamentoEmMinutos,
  horaLocal,
  resolverHoraLocal,
  somarDias,
} from '@veyra/contracts/verticals/clinics'; // valores (o bloco acima é só de tipos)
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import { postgresConstraintName, postgresErrorCode } from '../../../common/prisma-exception.filter';
import {
  MudancasDeRestricao,
  type ExecutorDeTransacao,
} from '../../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { chaveDoAgendamento } from '../outreach/clinics-outreach.precondition';
import { ValidadeDosPedidos } from '../outreach/clinics-outreach.validity';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type AppointmentRow = {
  id: string;
  patientId: string;
  professionalId: string;
  serviceId: string;
  unitId: string;
  startsAt: Date;
  endsAt: Date;
  status: ClinicsAppointmentStatus;
  cancelReason: ClinicsCancelReason | null;
  patient?: { contact?: { name: string } | null } | null;
  professional?: { name: string } | null;
  service?: { name: string } | null;
  attendance?: { id: string } | null;
};

type Unidade = { id: string; timezone: string };

/** De onde cada transição pode partir (adendo 4, item 6). */
const ORIGENS: Record<ChangeClinicsAppointmentStatusInput['to'], ClinicsAppointmentStatus[]> = {
  confirmed: ['scheduled'],
  arrived: ['confirmed'],
  canceled: ['scheduled', 'confirmed'],
  no_show: ['scheduled', 'confirmed'],
};

const REMARCAVEIS: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed'];

/** As mensagens chegam à tela: o estado em português, nunca o enum. */
export const ROTULO: Record<ClinicsAppointmentStatus, string> = {
  scheduled: 'Marcado',
  confirmed: 'Confirmado',
  arrived: 'Chegou',
  canceled: 'Cancelado',
  no_show: 'Faltou',
  attended: 'Atendido',
};

/**
 * O dia de uma unidade não passa de algumas dezenas; o teto é defesa. Acima
 * dele a rota RECUSA, em vez de devolver o dia cortado sem aviso: quem conta
 * (o Hoje da clínica, ADR-055 adendo 4) não pode afirmar um total que não sabe.
 */
const TETO_DO_DIA = 500;

const COM_NOMES = {
  patient: { select: { contact: { select: { name: true } } } },
  professional: { select: { name: true } },
  service: { select: { name: true } },
} as const;

/**
 * Agenda da clínica (ADR-048 adendo 2, item 4; adendo 4). Classe S. Client
 * protegido em tudo. O banco barra sobreposição (EXCLUDE); aqui ficam as
 * regras de catálogo, expediente e hora local da unidade.
 */
@Injectable()
export class ClinicsAppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly restricao: MudancasDeRestricao,
    private readonly validade: ValidadeDosPedidos,
  ) {}

  /** O dia LOCAL de uma unidade. O vínculo com atendimento só para quem lê atendimento. */
  async list(
    query: ListClinicsAppointmentsInput,
    comAtendimento: boolean,
  ): Promise<ClinicsAppointmentDto[]> {
    const unidade = await this.unidade(this.prisma.db, query.unitId);
    // janela JUSTA ao dia local (folga de 3 h para mudança de horário) e
    // filtro pela data local: o teto vale para o dia pedido, não para vizinhos
    const inicioDoDia = aproximarMeiaNoite(query.date, unidade.timezone);
    const fimDoDia = aproximarMeiaNoite(somarDias(query.date, 1), unidade.timezone);
    const rows = (await this.prisma.db.clinicsAppointment.findMany({
      where: {
        unitId: unidade.id,
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
        startsAt: {
          gte: new Date(inicioDoDia - 3 * 3_600_000),
          lt: new Date(fimDoDia + 3 * 3_600_000),
        },
      },
      include: {
        ...COM_NOMES,
        ...(comAtendimento ? { attendance: { select: { id: true } } } : {}),
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: TETO_DO_DIA + 1,
    } as never)) as unknown as AppointmentRow[];
    // a janela (com a folga) passou do teto: o dia pode estar incompleto
    if (rows.length > TETO_DO_DIA) {
      throw new UnprocessableEntityException(
        `Este dia tem mais de ${TETO_DO_DIA} horários e não cabe numa lista só.`,
      );
    }
    return rows
      .filter((row) => horaLocal(row.startsAt, unidade.timezone).data === query.date)
      .map((row) => toDto(row, unidade.timezone, comAtendimento));
  }

  async create(
    auth: AuthContext,
    input: CreateClinicsAppointmentInput,
  ): Promise<ClinicsAppointmentDto> {
    const workspaceId = auth.workspaceId as string;
    const { id, timezone } = await this.semSobreposicao(() =>
      (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        // o fuso é lido DEPOIS da trava: uma mudança de fuso que comitou
        // enquanto este agendamento esperava vale para ele (adendo 4, item 9)
        const unidade = await travarUnidade(tx, (await this.unidade(tx, input.unitId)).id);
        if (
          !(await tx.clinicsPatient.findFirst({
            where: { id: input.patientId },
            select: { id: true },
          }))
        ) {
          throw new NotFoundException('Paciente não encontrado');
        }
        const duracao = await this.catalogo(tx, input.professionalId, input.serviceId);
        const startsAt = inicio(input, unidade.timezone);
        const endsAt = new Date(startsAt.getTime() + duracao * 60_000);
        await this.expediente(tx, input.professionalId, unidade, startsAt, endsAt);
        const criado = (await tx.clinicsAppointment.create({
          data: {
            workspaceId,
            patientId: input.patientId,
            professionalId: input.professionalId,
            serviceId: input.serviceId,
            unitId: unidade.id,
            startsAt,
            endsAt,
            createdByMembershipId: auth.membershipId as string,
          },
          select: { id: true },
        } as never)) as unknown as { id: string };
        await this.audit.record(tx, workspaceId, 'clinics.appointment.created', {
          entityType: 'clinicsAppointment',
          entityId: criado.id,
          actor: this.audit.actorFrom(auth),
          after: {
            patientId: input.patientId,
            professionalId: input.professionalId,
            serviceId: input.serviceId,
            unitId: unidade.id,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            status: 'scheduled',
          },
        });
        return { id: criado.id, timezone: unidade.timezone };
      }),
    );
    return this.ler(id, timezone);
  }

  /**
   * Conserva a duração REGISTRADA; só trocar o serviço a recalcula pela duração
   * atual do novo. Volta a `scheduled`: a confirmação era do horário antigo.
   *
   * Remarcar invalida o pedido de confirmação do horário antigo (F4.2): a
   * `validity:` exclusiva do agendamento vem ANTES de qualquer linha, e os
   * pedidos de outro início são invalidados na mesma transação. O horário novo
   * exige pedido e aprovação novos.
   */
  async reschedule(
    auth: AuthContext,
    id: string,
    input: RescheduleClinicsAppointmentInput,
  ): Promise<ClinicsAppointmentDto> {
    const workspaceId = auth.workspaceId as string;
    const timezone = await this.semSobreposicao(() =>
      this.restricao.naTransacaoInterativa(this.mudancas(), async (tx) => {
        await this.validade.travar(tx, workspaceId, [chaveDoAgendamento(id)]);
        const visto = await tx.clinicsAppointment.findFirst({
          where: { id },
          select: { unitId: true },
        });
        if (!visto) throw new NotFoundException('Agendamento não encontrado');
        // ordem das travas: unidade → agendamento (adendo 4, item 9)
        const unidade = await travarUnidade(tx, (visto as { unitId: string }).unitId);
        const { count } = await tx.clinicsAppointment.updateMany({
          where: { id, status: { in: REMARCAVEIS } },
          data: { updatedAt: new Date() },
        } as never);
        if (count === 0) {
          throw new ConflictException('Só agendamento marcado ou confirmado pode ser remarcado');
        }
        const atual = (await tx.clinicsAppointment.findFirst({
          where: { id },
        })) as unknown as AppointmentRow;
        const serviceId = input.serviceId ?? atual.serviceId;
        const duracaoDoServico = await this.catalogo(tx, atual.professionalId, serviceId);
        const duracao =
          serviceId === atual.serviceId
            ? (atual.endsAt.getTime() - atual.startsAt.getTime()) / 60_000
            : duracaoDoServico;
        const startsAt = inicio(input, unidade.timezone);
        const endsAt = new Date(startsAt.getTime() + duracao * 60_000);
        await this.expediente(tx, atual.professionalId, unidade, startsAt, endsAt);
        await tx.clinicsAppointment.updateMany({
          where: { id },
          data: { startsAt, endsAt, serviceId, status: 'scheduled', cancelReason: null },
        } as never);
        await this.audit.record(tx, workspaceId, 'clinics.appointment.rescheduled', {
          entityType: 'clinicsAppointment',
          entityId: id,
          actor: this.audit.actorFrom(auth),
          before: {
            serviceId: atual.serviceId,
            startsAt: atual.startsAt.toISOString(),
            endsAt: atual.endsAt.toISOString(),
            status: atual.status,
          },
          after: {
            serviceId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            status: 'scheduled',
          },
        });
        await this.validade.invalidar(tx, auth, { appointmentId: id, exceto: startsAt });
        return unidade.timezone;
      }),
    );
    return this.ler(id, timezone);
  }

  /**
   * Transição a partir da ORIGEM permitida. Trava a linha ANTES de ler, como a
   * remarcação: a trilha registra o estado que a transição de fato substituiu.
   *
   * Antes da linha, a `validity:` exclusiva do agendamento (F4.2): toda
   * transição que não seja a confirmação tira o agendamento de "marcado ou
   * confirmado", e os pedidos de confirmação dele deixam de valer.
   */
  async changeStatus(
    auth: AuthContext,
    id: string,
    input: ChangeClinicsAppointmentStatusInput,
  ): Promise<ClinicsAppointmentDto> {
    const workspaceId = auth.workspaceId as string;
    const timezone = await this.restricao.naTransacaoInterativa(this.mudancas(), async (tx) => {
      await this.validade.travar(tx, workspaceId, [chaveDoAgendamento(id)]);
      const { count: existe } = await tx.clinicsAppointment.updateMany({
        where: { id },
        data: { updatedAt: new Date() },
      } as never);
      if (existe === 0) throw new NotFoundException('Agendamento não encontrado');
      const atual = (await tx.clinicsAppointment.findFirst({
        where: { id },
      })) as unknown as AppointmentRow;
      if (!ORIGENS[input.to].includes(atual.status)) {
        throw new ConflictException(
          `Transição inválida: ${ROTULO[atual.status]} → ${ROTULO[input.to]}`,
        );
      }
      const cancelReason =
        input.to === 'canceled' ? (input.cancelReason as ClinicsCancelReason) : null;
      await tx.clinicsAppointment.updateMany({
        where: { id, status: atual.status },
        data: { status: input.to, cancelReason },
      } as never);
      await this.audit.record(tx, workspaceId, 'clinics.appointment.status_changed', {
        entityType: 'clinicsAppointment',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { status: atual.status, cancelReason: atual.cancelReason },
        after: { status: input.to, cancelReason },
      });
      if (input.to !== 'confirmed') await this.validade.invalidar(tx, auth, { appointmentId: id });
      // o fuso de DENTRO da transação: a transição já valeu, nada depois dela
      // pode transformá-la em erro
      const unidade = (await tx.clinicsUnit.findFirst({
        where: { id: atual.unitId },
        select: { timezone: true },
      })) as unknown as { timezone: string };
      return unidade.timezone;
    });
    return this.ler(id, timezone);
  }

  // ── auxiliares ──────────────────────────────────────────────────────────

  /** O client que abre a transação das mudanças que invalidam pedidos. */
  private mudancas(): ExecutorDeTransacao {
    return this.prisma.db as unknown as ExecutorDeTransacao;
  }

  private async ler(id: string, timezone: string): Promise<ClinicsAppointmentDto> {
    const row = (await this.prisma.db.clinicsAppointment.findFirst({
      where: { id },
      include: COM_NOMES,
    } as never)) as unknown as AppointmentRow;
    return toDto(row, timezone, false);
  }

  /** A unidade pedida, ou a ÚNICA ativa (MVP: uma por workspace). */
  private async unidade(db: Db, unitId?: string): Promise<Unidade> {
    if (unitId) {
      const unidade = (await db.clinicsUnit.findFirst({
        where: { id: unitId, archivedAt: null },
        select: { id: true, timezone: true },
      })) as unknown as Unidade | null;
      if (!unidade) throw new NotFoundException('Unidade não encontrada');
      return unidade;
    }
    const ativas = (await db.clinicsUnit.findMany({
      where: { archivedAt: null },
      select: { id: true, timezone: true },
      take: 2,
    })) as unknown as Unidade[];
    if (ativas.length !== 1) throw new BadRequestException('Informe a unidade');
    return ativas[0];
  }

  /** Profissional e serviço ATIVOS, e o profissional habilitado. Devolve a duração atual. */
  private async catalogo(tx: Db, professionalId: string, serviceId: string): Promise<number> {
    const profissional = (await tx.clinicsProfessional.findFirst({
      where: { id: professionalId },
      select: { archivedAt: true },
    })) as unknown as { archivedAt: Date | null } | null;
    if (!profissional) throw new NotFoundException('Profissional não encontrado');
    if (profissional.archivedAt) throw new BadRequestException('Profissional arquivado');
    const servico = (await tx.clinicsService.findFirst({
      where: { id: serviceId },
      select: { archivedAt: true, durationMin: true },
    })) as unknown as { archivedAt: Date | null; durationMin: number } | null;
    if (!servico) throw new NotFoundException('Serviço não encontrado');
    if (servico.archivedAt) throw new BadRequestException('Serviço arquivado');
    const habilitado = await tx.clinicsProfessionalService.findFirst({
      where: { professionalId, serviceId },
      select: { id: true },
    });
    if (!habilitado) throw new BadRequestException('Profissional não habilitado para este serviço');
    return servico.durationMin;
  }

  /**
   * Início e fim LOCAIS no mesmo dia, dentro de um intervalo do profissional na
   * unidade. O fim local vem do INSTANTE de fim: atravessar uma mudança de
   * horário pode empurrá-lo para fora (adendo 4, item 4).
   */
  private async expediente(
    tx: Db,
    professionalId: string,
    unidade: Unidade,
    startsAt: Date,
    endsAt: Date,
  ): Promise<void> {
    const inicioLocal = horaLocal(startsAt, unidade.timezone);
    const fimLocal = horaLocal(endsAt, unidade.timezone);
    let fimMinuto: number;
    if (fimLocal.data === inicioLocal.data) fimMinuto = fimLocal.minutoDoDia;
    else if (fimLocal.data === somarDias(inicioLocal.data, 1) && fimLocal.minutoDoDia === 0)
      fimMinuto = 1440;
    else throw new BadRequestException('O atendimento precisa começar e terminar no mesmo dia');
    const intervalos = (await tx.clinicsWorkingHours.findMany({
      where: { professionalId, unitId: unidade.id, weekday: inicioLocal.diaDaSemana },
      select: { startMinute: true, endMinute: true },
    })) as unknown as { startMinute: number; endMinute: number }[];
    const cabe = intervalos.some(
      (i) => i.startMinute <= inicioLocal.minutoDoDia && fimMinuto <= i.endMinute,
    );
    if (!cabe) {
      throw new BadRequestException(
        'Fora do expediente do profissional (na hora local da unidade)',
      );
    }
  }

  /** A sobreposição barrada pelo BANCO vira 409 com motivo, nunca 500. */
  private async semSobreposicao<T>(acao: () => Promise<T>): Promise<T> {
    try {
      return await acao();
    } catch (error) {
      if (
        postgresErrorCode(error) === '23P01' &&
        postgresConstraintName(error) === 'ClinicsAppointment_no_overlap'
      ) {
        throw new ConflictException('Horário já ocupado para este profissional');
      }
      // o vínculo com um retorno (F3.2): trocar o serviço, a unidade ou o
      // paciente esbarra na FK do vínculo. O horário é livre: a regra temporal
      // é sobre o registro do atendimento, que a remarcação não muda
      if (vinculoDoRetorno(error)) {
        throw new ConflictException(
          'Este agendamento está vinculado a um retorno: desvincule-o antes de trocar o serviço',
        );
      }
      throw error;
    }
  }
}

/** A remarcação esbarrou na FK do vínculo de um retorno. */
function vinculoDoRetorno(error: unknown): boolean {
  if (postgresConstraintName(error) === 'ClinicsReturn_appointment_fkey') return true;
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003' &&
    JSON.stringify(error.meta ?? {}).includes('ClinicsReturn_appointment_fkey')
  );
}

/**
 * Trava a linha da unidade — serializa agenda e mudança de fuso (adendo 4,
 * item 9) — e devolve a unidade RELIDA depois da trava: o fuso que vale é o
 * que comitou por último, não o que foi visto antes de esperar.
 */
async function travarUnidade(tx: Db, unitId: string): Promise<Unidade> {
  const { count } = await tx.clinicsUnit.updateMany({
    where: { id: unitId, archivedAt: null },
    data: { updatedAt: new Date() },
  });
  if (count === 0) throw new NotFoundException('Unidade não encontrada');
  return (await tx.clinicsUnit.findFirst({
    where: { id: unitId },
    select: { id: true, timezone: true },
  })) as unknown as Unidade;
}

/** Instante aproximado da meia-noite local (ms): base da janela do dia. */
function aproximarMeiaNoite(data: string, timezone: string): number {
  const [ano, mes, dia] = data.split('-').map(Number);
  const ingenuo = Date.UTC(ano, mes - 1, dia);
  return ingenuo - deslocamentoEmMinutos(new Date(ingenuo), timezone) * 60_000;
}

/** Data e hora LOCAIS → instante, com as recusas da mudança de horário. */
function inicio(input: { date: string; time: string; utcOffset?: string }, timezone: string): Date {
  const r = resolverHoraLocal(input.date, input.time, timezone, input.utcOffset);
  if (r.kind === 'ok') return r.instante;
  if (r.kind === 'inexistente') {
    throw new BadRequestException('Horário inexistente nesse dia por mudança de fuso');
  }
  if (r.kind === 'ambigua') {
    throw new BadRequestException(
      `Horário ambíguo por mudança de fuso: informe utcOffset (${r.deslocamentos.join(' ou ')})`,
    );
  }
  throw new BadRequestException('utcOffset não corresponde a esse horário nesse fuso');
}

function toDto(
  row: AppointmentRow,
  timezone: string,
  comAtendimento: boolean,
): ClinicsAppointmentDto {
  const inicioLocal = horaLocal(row.startsAt, timezone);
  return {
    id: row.id,
    patientId: row.patientId,
    patientName: row.patient?.contact?.name ?? '',
    professionalId: row.professionalId,
    professionalName: row.professional?.name ?? '',
    serviceId: row.serviceId,
    serviceName: row.service?.name ?? '',
    unitId: row.unitId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    localDate: inicioLocal.data,
    localStart: inicioLocal.hora,
    localEnd: horaLocal(row.endsAt, timezone).hora,
    status: row.status,
    cancelReason: row.cancelReason,
    ...(comAtendimento ? { attendanceId: row.attendance?.id ?? null } : {}),
  };
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import {
  horaLocal,
  inicioDoDiaLocal,
  somarDias,
  type AssignClinicsReturnInput,
  type CancelClinicsReturnInput,
  type ClinicsAppointmentStatus,
  type ClinicsPermissionKey,
  type ClinicsReturnAssigneeDto,
  type ClinicsReturnCandidatesPageDto,
  type ClinicsReturnCancelReason,
  type ClinicsReturnDto,
  type ClinicsReturnStatus,
  type CreateClinicsReturnInput,
  type LinkClinicsReturnInput,
  type ListClinicsReturnCandidatesInput,
  type ListClinicsReturnsInput,
} from '@veyra/contracts/verticals/clinics';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import { postgresErrorCode } from '../../../common/prisma-exception.filter';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { agoraDoBanco } from '../../../prisma/relogio-do-banco';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

const LOG = new Logger('ClinicsReturns');

export type ReturnRow = {
  id: string;
  patientId: string;
  serviceId: string;
  unitId: string;
  originAttendanceId: string | null;
  dueDate: Date;
  status: ClinicsReturnStatus;
  assigneeMembershipId: string | null;
  appointmentId: string | null;
  fulfilledByAttendanceId: string | null;
  cancelReason: ClinicsReturnCancelReason | null;
  createdByMembershipId: string;
  closedByMembershipId: string | null;
  createdAt: Date;
  closedAt: Date | null;
};

type ReturnComNomes = ReturnRow & {
  patient: { contact: { name: string } };
  service: { name: string };
  appointment: { id: string; startsAt: Date; status: ClinicsAppointmentStatus } | null;
};

const COM_NOMES = {
  patient: { select: { contact: { select: { name: true } } } },
  service: { select: { name: true } },
  appointment: { select: { id: true, startsAt: true, status: true } },
} as const;

const chave = (key: ClinicsPermissionKey) => key as unknown as PermissionKey;
const AGENDA_LER = chave('clinics:schedule:read');
const AGENDA_ESCREVER = chave('clinics:schedule:write');
const ATENDIMENTO_LER = chave('clinics:care:read');
const ATENDIMENTO_ESCREVER = chave('clinics:care:write');

/** O que a recepção pode registrar; os demais motivos são decisão clínica. */
const MOTIVO_OPERACIONAL: ReadonlySet<ClinicsReturnCancelReason> = new Set([
  'patient_declined',
  'patient_unreachable',
]);

/** Estados do agendamento que aceitam vínculo (o atendido conclui na hora). */
const VINCULAVEIS: ClinicsAppointmentStatus[] = ['scheduled', 'confirmed', 'arrived', 'attended'];

// mensagens NEUTRAS: não distinguem o que a projeção esconde (a criação, a
// origem, o motivo de outro encerramento)
const NAO_PODE_CUMPRIR = 'Este agendamento não pode cumprir este retorno';
const ENCERRADO = 'Este retorno já foi encerrado; nada foi alterado';
const JA_VINCULADO = 'Este agendamento já está vinculado a outro retorno';
const MUDOU =
  'O retorno mudou enquanto o pedido era feito; nada foi alterado. Atualize e tente de novo';

/**
 * Retornos (ADR-048 adendo 7, F3.2). Classe S. Fica no Clinics, com permissões
 * do domínio, sem `Task` do Core.
 *
 * - CONCLUIR é comprovar um atendimento: não existe ação de concluir. O retorno
 *   passa a `done` quando o agendamento vinculado recebe o registro de
 *   atendimento, ou na hora do vínculo, se ele já o tem. O banco exige a prova
 *   (FK do registro do MESMO agendamento).
 * - Encerrar sem atendimento é cancelar, com motivo de lista fechada.
 * - Travas: agendamento(s), em ordem de id → retorno. O registro de atendimento
 *   segue agendamento → pacote → retorno. Ninguém trava na ordem inversa.
 *
 * Só este arquivo escreve `ClinicsReturn` (regra estática): o registro de
 * atendimento chama `cumprirRetornoDoAgendamento` e `criarRetornoAutomatico`.
 */
@Injectable()
export class ClinicsReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  // ── leitura (clinics:schedule:read), projetada por permissão ─────────────

  async list(auth: AuthContext, query: ListClinicsReturnsInput): Promise<ClinicsReturnDto[]> {
    const where: Record<string, unknown> = {};
    if (query.status) where.status = query.status;
    if (query.unitId) where.unitId = query.unitId;
    if (query.patientId) where.patientId = query.patientId;
    if (query.assignee) {
      where.assigneeMembershipId = query.assignee === 'none' ? null : query.assignee;
    }
    if (query.dueFrom || query.dueTo) {
      where.dueDate = {
        ...(query.dueFrom ? { gte: paraData(query.dueFrom) } : {}),
        ...(query.dueTo ? { lte: paraData(query.dueTo) } : {}),
      };
    }
    // um "hoje" só para o filtro e a projeção: nunca duas leituras que
    // discordem na virada do dia
    const hoje = query.overdue ? await this.hojePorUnidade() : undefined;
    if (hoje) {
      const vencidos = {
        OR: [...hoje].map(([unitId, dia]) => ({
          unitId,
          status: 'pending',
          dueDate: { lt: paraData(dia) },
        })),
      };
      where.AND = [query.overdue === 'true' ? vencidos : { NOT: vencidos }];
    }
    const rows = (await this.prisma.db.clinicsReturn.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: query.limit,
      include: COM_NOMES,
    } as never)) as unknown as ReturnComNomes[];
    return this.projetar(auth, rows, hoje);
  }

  async get(auth: AuthContext, id: string): Promise<ClinicsReturnDto> {
    return (await this.projetar(auth, [await lerComNomes(this.prisma.db, id)]))[0];
  }

  /**
   * Os candidatos a responsável: membros ATIVOS que veem a lista e podem agir
   * sobre o retorno. Só id e nome — a lista de membros não se abre aqui.
   */
  async assignees(auth: AuthContext): Promise<ClinicsReturnAssigneeDto[]> {
    await this.exigirAcao(auth);
    const memberships = (await this.prisma.db.membership.findMany({
      where: { status: 'active' },
      select: { id: true, userId: true, roleId: true },
    })) as unknown as { id: string; userId: string; roleId: string }[];
    const aptos = await papeisAptos(
      this.prisma.db,
      memberships.map((m) => m.roleId),
    );
    const elegiveis = memberships.filter((m) => aptos.has(m.roleId));
    const nomes = await this.nomes(elegiveis);
    return elegiveis
      .map((m) => ({ membershipId: m.id, name: nomes.get(m.userId) ?? '' }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.membershipId.localeCompare(b.membershipId));
  }

  /**
   * Candidatos ao vínculo (F3.3a; aprovação da F3.3, item 3): agendamentos do
   * mesmo paciente, serviço e unidade, em estado que aceita vínculo e sem
   * vínculo a retorno. As permissões são as de vincular.
   *
   * Só critérios VISÍVEIS na agenda: a lista não depende da prova (o registro
   * antes ou depois da criação) nem da origem, nem na contagem, nem na ordem,
   * nem na paginação. O agendamento de origem aparece como qualquer outro, e o
   * vínculo dele recebe a recusa neutra. É seleção, não garantia: o vínculo
   * reconfere tudo na transação. Paginada por (início, id), sem truncar.
   */
  async candidates(
    auth: AuthContext,
    id: string,
    query: ListClinicsReturnCandidatesInput,
  ): Promise<ClinicsReturnCandidatesPageDto> {
    await this.exigirAcao(auth);
    const r = await lerRetorno(this.prisma.db, id);
    if (r.status !== 'pending') throw new ConflictException(ENCERRADO);
    const posicao = query.cursor ? lerCursor(query.cursor) : null;
    let desde: Date | null = null;
    if (query.from) {
      const unidade = (await this.prisma.db.clinicsUnit.findFirst({
        where: { id: r.unitId },
        select: { timezone: true },
      })) as unknown as { timezone: string };
      desde = inicioDoDiaLocal(query.from, unidade.timezone);
    }
    const rows = (await this.prisma.db.clinicsAppointment.findMany({
      where: {
        patientId: r.patientId,
        serviceId: r.serviceId,
        unitId: r.unitId,
        status: { in: VINCULAVEIS },
        returns: { none: {} },
        ...(desde ? { startsAt: { gte: desde } } : {}),
        ...(posicao
          ? {
              OR: [
                { startsAt: { gt: posicao.startsAt } },
                { startsAt: posicao.startsAt, id: { gt: posicao.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: { id: true, startsAt: true, status: true, professional: { select: { name: true } } },
    } as never)) as unknown as {
      id: string;
      startsAt: Date;
      status: ClinicsAppointmentStatus;
      professional: { name: string };
    }[];
    const pagina = rows.slice(0, query.limit);
    const ultimo = pagina[pagina.length - 1];
    return {
      items: pagina.map((a) => ({
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        status: a.status,
        professionalName: a.professional.name,
      })),
      nextCursor: rows.length > query.limit && ultimo ? escreverCursor(ultimo) : null,
    };
  }

  // ── escrita ─────────────────────────────────────────────────────────────

  /** Criação manual (`clinics:care:write`): o retorno nasce pendente e sem agendamento. */
  async create(auth: AuthContext, input: CreateClinicsReturnInput): Promise<ClinicsReturnDto> {
    const workspaceId = auth.workspaceId as string;
    const id = await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const paciente = await tx.clinicsPatient.findFirst({
        where: { id: input.patientId },
        select: { id: true },
      });
      if (!paciente) throw new NotFoundException('Paciente não encontrado');
      const servico = (await tx.clinicsService.findFirst({
        where: { id: input.serviceId },
        select: { archivedAt: true },
      })) as unknown as { archivedAt: Date | null } | null;
      if (!servico) throw new NotFoundException('Serviço não encontrado');
      if (servico.archivedAt) {
        throw new ConflictException('Serviço arquivado não aceita retorno novo');
      }
      const unidade = await unidadeDoRetorno(tx, input.unitId);
      if (input.assigneeMembershipId) await conferirResponsavel(tx, input.assigneeMembershipId);
      const criado = (await tx.clinicsReturn.create({
        data: {
          workspaceId,
          patientId: input.patientId,
          serviceId: input.serviceId,
          unitId: unidade,
          dueDate: paraData(input.dueDate),
          assigneeMembershipId: input.assigneeMembershipId ?? null,
          createdByMembershipId: auth.membershipId as string,
        },
      } as never)) as unknown as ReturnRow;
      await this.audit.record(tx, workspaceId, 'clinics.return.created', {
        entityType: 'clinicsReturn',
        entityId: criado.id,
        actor: this.audit.actorFrom(auth),
        after: trilha(criado),
      });
      return criado.id;
    });
    return this.get(auth, id);
  }

  /**
   * Vincula (ou troca) o agendamento que vai cumprir o retorno. Ainda não
   * atendido: o retorno continua pendente, qualquer que seja o início (a regra
   * temporal é sobre o REGISTRO do atendimento, não sobre o horário). Já
   * atendido, COM um registro posterior à criação: conclui na mesma transação.
   * Trava os agendamentos envolvidos (o novo e o anterior) em ordem de id e,
   * DEPOIS, o retorno, que relê: se outra escrita o mudou, responde antes de
   * olhar o candidato. Escreve condicionado ao vínculo relido.
   */
  async link(
    auth: AuthContext,
    id: string,
    input: LinkClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    await this.exigirAcao(auth);
    const workspaceId = auth.workspaceId as string;
    try {
      await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        const visto = await lerRetorno(tx, id);
        if (visto.status !== 'pending') {
          // o mesmo pedido sobre o retorno que este agendamento cumpriu
          if (visto.status === 'done' && visto.appointmentId === input.appointmentId) return;
          throw new ConflictException(ENCERRADO);
        }
        if (visto.appointmentId === input.appointmentId) return;
        await travarAgendamentos(tx, [input.appointmentId, visto.appointmentId]);
        // e o RETORNO, depois dos agendamentos (a ordem de sempre), relido. Se
        // outra escrita o mudou desde a leitura, a resposta sai AQUI, antes do
        // estado e da prova do candidato: senão, uma prova positiva daria
        // "mudou" e uma negativa, a recusa neutra — uma sonda sem conclusão
        await travarRetornoPendente(tx, id);
        const atual = await lerRetorno(tx, id);
        if (atual.appointmentId === input.appointmentId) return; // o mesmo pedido, concorrente
        if (atual.status !== 'pending') throw new ConflictException(ENCERRADO);
        if (atual.appointmentId !== visto.appointmentId) throw new ConflictException(MUDOU);
        const agendamento = (await tx.clinicsAppointment.findFirst({
          where: { id: input.appointmentId },
          select: { patientId: true, serviceId: true, unitId: true, status: true },
        })) as unknown as {
          patientId: string;
          serviceId: string;
          unitId: string;
          status: ClinicsAppointmentStatus;
        } | null;
        if (!agendamento) throw new NotFoundException('Agendamento não encontrado');
        // fatos visíveis na agenda: a recusa diz o motivo
        if (agendamento.patientId !== visto.patientId) {
          throw new BadRequestException('O agendamento é de outro paciente');
        }
        if (agendamento.serviceId !== visto.serviceId) {
          throw new BadRequestException('O agendamento é de outro serviço');
        }
        if (agendamento.unitId !== visto.unitId) {
          throw new BadRequestException('O agendamento é de outra unidade');
        }
        // já cumpre (ou vai cumprir) OUTRO retorno: um fato visível na lista,
        // respondido ANTES do estado e da prova. Sem isso, a prova de um
        // agendamento já usado seria conferida, e a resposta (esta ou a neutra)
        // diria se o registro dele é anterior à criação deste retorno, sem
        // mudar nada: uma sonda (ajustes da F3.2). Todo vínculo novo trava o
        // agendamento antes, então não há corrida; o índice único fica de rede
        const deOutro = await tx.clinicsReturn.findFirst({
          where: { appointmentId: input.appointmentId, id: { not: id } },
          select: { id: true },
        });
        if (deOutro) throw new ConflictException(JA_VINCULADO);
        // o estado: a MESMA recusa neutra da prova abaixo. O início NÃO conta:
        // variar o horário não sonda a criação, que não é projetada a quem só
        // tem a agenda (ajustes da F3.2). O banco confere de novo
        if (!VINCULAVEIS.includes(agendamento.status)) {
          throw new ConflictException(NAO_PODE_CUMPRIR);
        }
        // já atendido: a PROVA é o registro de atendimento deste agendamento,
        // registrado DEPOIS da criação do retorno (os dois instantes são do
        // relógio do banco) e nunca o que o gerou. O banco confere de novo
        const prova =
          agendamento.status === 'attended'
            ? ((await tx.clinicsAttendance.findFirst({
                where: { appointmentId: input.appointmentId },
                select: { id: true, recordedAt: true },
              })) as unknown as { id: string; recordedAt: Date } | null)
            : null;
        if (
          agendamento.status === 'attended' &&
          (!prova ||
            prova.id === visto.originAttendanceId ||
            prova.recordedAt.getTime() <= visto.createdAt.getTime())
        ) {
          throw new ConflictException(NAO_PODE_CUMPRIR);
        }
        const { count } = await tx.clinicsReturn.updateMany({
          where: { id, status: 'pending', appointmentId: visto.appointmentId },
          data: prova
            ? {
                appointmentId: input.appointmentId,
                status: 'done',
                fulfilledByAttendanceId: prova.id,
                closedByMembershipId: auth.membershipId as string,
              }
            : { appointmentId: input.appointmentId },
        } as never);
        // a linha está travada desde a releitura: não acontece
        if (count === 0) throw new ConflictException(MUDOU);
        const depois = await lerRetorno(tx, id);
        await this.audit.record(tx, workspaceId, 'clinics.return.linked', {
          entityType: 'clinicsReturn',
          entityId: id,
          actor: this.audit.actorFrom(auth),
          before: { appointmentId: visto.appointmentId },
          after: { appointmentId: depois.appointmentId },
        });
        if (prova) {
          await this.audit.record(tx, workspaceId, 'clinics.return.completed', {
            entityType: 'clinicsReturn',
            entityId: id,
            actor: this.audit.actorFrom(auth),
            after: trilha(depois),
          });
        }
      });
    } catch (error) {
      throw traduzirVinculo(error);
    }
    return this.get(auth, id);
  }

  /** Desfaz o vínculo de um retorno pendente, sem substituir. */
  async unlink(auth: AuthContext, id: string): Promise<ClinicsReturnDto> {
    await this.exigirAcao(auth);
    const workspaceId = auth.workspaceId as string;
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      const visto = await lerRetorno(tx, id);
      if (visto.status !== 'pending') throw new ConflictException(ENCERRADO);
      if (visto.appointmentId === null) return;
      await travarAgendamentos(tx, [visto.appointmentId]);
      const { count } = await tx.clinicsReturn.updateMany({
        where: { id, status: 'pending', appointmentId: visto.appointmentId },
        data: { appointmentId: null },
      } as never);
      if (count === 0) throw new ConflictException(MUDOU);
      await this.audit.record(tx, workspaceId, 'clinics.return.linked', {
        entityType: 'clinicsReturn',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { appointmentId: visto.appointmentId },
        after: { appointmentId: null },
      });
    });
    return this.get(auth, id);
  }

  /**
   * Encerra sem atendimento. A permissão do MOTIVO é conferida antes de
   * qualquer leitura: a condição de origem (`created_in_error` só no manual)
   * fica escondida de quem não pode usar esse motivo.
   *
   * A REPETIÇÃO é idempotente quando é o mesmo pedido: o mesmo motivo, por
   * quem encerrou, com a permissão do motivo ainda válida (conferida acima, na
   * repetição também). Para qualquer outro pedido sobre um retorno encerrado, o
   * 409 é neutro e igual: sem isso, quem só tem a agenda descobriria, pelo 200,
   * o motivo de um encerramento de outra pessoa, que a projeção esconde dele.
   *
   * TRAVA antes de ler: a decisão e a trilha usam a versão que esta escrita
   * substitui, e não uma leitura que outra transação já trocou (o vínculo).
   */
  async cancel(
    auth: AuthContext,
    id: string,
    input: CancelClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    await this.exigirMotivo(auth, input.reason);
    const workspaceId = auth.workspaceId as string;
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      // a corrida com o registro de atendimento: quem trava a linha primeiro
      // decide; o outro espera aqui e lê o estado que ficou
      await travarRetornoPendente(tx, id);
      const visto = await lerRetorno(tx, id);
      if (mesmoPedido(visto, input.reason, auth)) return;
      if (visto.status !== 'pending') throw new ConflictException(ENCERRADO);
      if (input.reason === 'created_in_error' && visto.originAttendanceId !== null) {
        throw new ConflictException('Este motivo não se aplica a este retorno');
      }
      const { count } = await tx.clinicsReturn.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'canceled',
          cancelReason: input.reason,
          appointmentId: null,
          closedByMembershipId: auth.membershipId as string,
        },
      } as never);
      // a linha está travada desde a leitura: não acontece
      if (count === 0) throw new ConflictException(MUDOU);
      await this.audit.record(tx, workspaceId, 'clinics.return.canceled', {
        entityType: 'clinicsReturn',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { appointmentId: visto.appointmentId },
        after: trilha(await lerRetorno(tx, id)),
      });
    });
    return this.get(auth, id);
  }

  /**
   * Atribui, troca ou tira o responsável de um retorno pendente. O responsável
   * é conferido na membership VIVA: ativo, vê a lista e pode agir. Ser
   * responsável não concede nada. Trava antes de ler, como o cancelamento: a
   * trilha registra o responsável que esta escrita substitui.
   */
  async assign(
    auth: AuthContext,
    id: string,
    input: AssignClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    await this.exigirAcao(auth);
    const workspaceId = auth.workspaceId as string;
    await (this.prisma.db as unknown as TxRunner).$transaction(async (tx) => {
      await travarRetornoPendente(tx, id);
      const visto = await lerRetorno(tx, id);
      if (visto.status !== 'pending') throw new ConflictException(ENCERRADO);
      if (visto.assigneeMembershipId === input.membershipId) return;
      if (input.membershipId) await conferirResponsavel(tx, input.membershipId);
      const { count } = await tx.clinicsReturn.updateMany({
        where: { id, status: 'pending' },
        data: { assigneeMembershipId: input.membershipId },
      } as never);
      // a linha está travada desde a leitura: não acontece
      if (count === 0) throw new ConflictException(MUDOU);
      await this.audit.record(tx, workspaceId, 'clinics.return.assigned', {
        entityType: 'clinicsReturn',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { assigneeMembershipId: visto.assigneeMembershipId },
        after: { assigneeMembershipId: input.membershipId },
      });
    });
    return this.get(auth, id);
  }

  // ── auxiliares ──────────────────────────────────────────────────────────

  /** Agir sobre o retorno: a recepção (`schedule:write`) ou o profissional (`care:write`). */
  private async exigirAcao(auth: AuthContext): Promise<void> {
    if (
      (await this.permissions.has(auth, AGENDA_ESCREVER)) ||
      (await this.permissions.has(auth, ATENDIMENTO_ESCREVER))
    ) {
      return;
    }
    throw new ForbiddenException('Agir sobre retornos exige a escrita da agenda ou do atendimento');
  }

  private async exigirMotivo(auth: AuthContext, motivo: ClinicsReturnCancelReason): Promise<void> {
    if (MOTIVO_OPERACIONAL.has(motivo)) return this.exigirAcao(auth);
    if (await this.permissions.has(auth, ATENDIMENTO_ESCREVER)) return;
    throw new ForbiddenException('Este motivo é decisão clínica: exige a escrita do atendimento');
  }

  private async projetar(
    auth: AuthContext,
    rows: ReturnComNomes[],
    hojeDaOperacao?: Map<string, string>,
  ): Promise<ClinicsReturnDto[]> {
    if (rows.length === 0) return [];
    const lerAtendimento = await this.permissions.has(auth, ATENDIMENTO_LER);
    const responsaveis = await this.responsaveis(
      rows.map((r) => r.assigneeMembershipId).filter((m): m is string => m !== null),
    );
    const hoje = hojeDaOperacao ?? (await this.hojePorUnidade());
    return rows.map((r) => {
      const dueDate = paraDia(r.dueDate);
      const responsavel = r.assigneeMembershipId
        ? responsaveis.get(r.assigneeMembershipId)
        : undefined;
      const dto: ClinicsReturnDto = {
        id: r.id,
        patientId: r.patientId,
        patientName: r.patient.contact.name,
        serviceId: r.serviceId,
        serviceName: r.service.name,
        unitId: r.unitId,
        dueDate,
        status: r.status,
        overdue: r.status === 'pending' && dueDate < (hoje.get(r.unitId) ?? dueDate),
        assignee: r.assigneeMembershipId
          ? {
              membershipId: r.assigneeMembershipId,
              name: responsavel?.name ?? '',
              hasAccess: responsavel?.hasAccess ?? false,
            }
          : null,
        appointment: r.appointment
          ? {
              id: r.appointment.id,
              startsAt: r.appointment.startsAt.toISOString(),
              status: r.appointment.status,
            }
          : null,
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
      };
      // autorização de CAMPO: origem, motivo e criação só com care:read
      if (lerAtendimento) {
        dto.origin = r.originAttendanceId ? 'automatic' : 'manual';
        dto.originAttendanceId = r.originAttendanceId;
        dto.cancelReason = r.cancelReason;
        dto.createdAt = r.createdAt.toISOString();
      }
      return dto;
    });
  }

  /** Nome e acesso de cada responsável, pelo mesmo critério da atribuição. */
  private async responsaveis(
    ids: string[],
  ): Promise<Map<string, { name: string; hasAccess: boolean }>> {
    if (ids.length === 0) return new Map();
    const memberships = (await this.prisma.db.membership.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, userId: true, roleId: true, status: true },
    })) as unknown as { id: string; userId: string; roleId: string; status: string }[];
    const aptos = await papeisAptos(
      this.prisma.db,
      memberships.map((m) => m.roleId),
    );
    const nomes = await this.nomes(memberships);
    return new Map(
      memberships.map((m) => [
        m.id,
        {
          name: nomes.get(m.userId) ?? '',
          hasAccess: m.status === 'active' && aptos.has(m.roleId),
        },
      ]),
    );
  }

  private async nomes(memberships: { userId: string }[]): Promise<Map<string, string>> {
    if (memberships.length === 0) return new Map();
    // raw justificado: nome (User global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: [...new Set(memberships.map((m) => m.userId))] } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /**
   * "Hoje", na data local de cada unidade, a partir de UM instante do relógio
   * do BANCO (ADR-048 adendo 7, ajustes da F3.2): um desvio do Node não muda o
   * "vencido". Uma chamada por operação; quem filtra passa o mesmo mapa à
   * projeção.
   */
  private async hojePorUnidade(): Promise<Map<string, string>> {
    const agora = await agoraDoBanco(this.prisma);
    const unidades = (await this.prisma.db.clinicsUnit.findMany({
      select: { id: true, timezone: true },
    })) as unknown as { id: string; timezone: string }[];
    return new Map(unidades.map((u) => [u.id, horaLocal(agora, u.timezone).data]));
  }
}

// ── chamados pelo registro de atendimento, NA TRANSAÇÃO DELE ───────────────
// (a ordem: agendamento → pacote → retorno)

/**
 * O retorno PENDENTE vinculado a este agendamento é cumprido por este registro
 * de atendimento: a prova é o próprio registro (FK do mesmo agendamento).
 */
export async function cumprirRetornoDoAgendamento(
  tx: Db,
  audit: AuditService,
  auth: AuthContext,
  agendamento: string,
  registro: string,
): Promise<void> {
  const workspaceId = auth.workspaceId as string;
  let count: number;
  try {
    ({ count } = await tx.clinicsReturn.updateMany({
      where: { appointmentId: agendamento, status: 'pending' },
      data: {
        status: 'done',
        fulfilledByAttendanceId: registro,
        closedByMembershipId: auth.membershipId as string,
      },
    } as never));
  } catch (error) {
    // pela ordem das travas, a prova deste caminho é sempre posterior à
    // criação do retorno; a recusa do gatilho só viria com o relógio do banco
    // recuando. O registro inteiro volta (falha fechada), com 409 e log
    if (postgresErrorCode(error) === '23514') {
      LOG.error(`Retorno vinculado ao agendamento ${agendamento} recusou a prova ${registro}`);
      throw new ConflictException(
        'O atendimento não foi registrado: o retorno vinculado recusou a conclusão. Tente de novo',
      );
    }
    throw error;
  }
  if (count === 0) return;
  const cumprido = (await tx.clinicsReturn.findFirst({
    where: { appointmentId: agendamento },
  })) as unknown as ReturnRow;
  await audit.record(tx, workspaceId, 'clinics.return.completed', {
    entityType: 'clinicsReturn',
    entityId: cumprido.id,
    actor: audit.actorFrom(auth),
    after: trilha(cumprido),
  });
}

/**
 * O retorno AUTOMÁTICO, se o serviço tem intervalo: nasce pendente, sem
 * responsável e sem agendamento, vencendo na data local do registro de
 * atendimento mais o intervalo. Um por registro (único no banco).
 */
export async function criarRetornoAutomatico(
  tx: Db,
  audit: AuditService,
  auth: AuthContext,
  registro: { id: string; recordedAt: Date },
  agendamento: { patientId: string; serviceId: string; unitId: string },
): Promise<void> {
  const workspaceId = auth.workspaceId as string;
  const servico = (await tx.clinicsService.findFirst({
    where: { id: agendamento.serviceId },
    select: { returnIntervalDays: true },
  })) as unknown as { returnIntervalDays: number | null };
  if (!servico.returnIntervalDays) return;
  const unidade = (await tx.clinicsUnit.findFirst({
    where: { id: agendamento.unitId },
    select: { timezone: true },
  })) as unknown as { timezone: string };
  // a data local do REGISTRO pelo relógio do banco (o `recordedAt`), o mesmo
  // relógio do "hoje" que o compara (ADR-049; ajustes da F3.2)
  const vencimento = somarDias(
    horaLocal(registro.recordedAt, unidade.timezone).data,
    servico.returnIntervalDays,
  );
  const criado = (await tx.clinicsReturn.create({
    data: {
      workspaceId,
      patientId: agendamento.patientId,
      serviceId: agendamento.serviceId,
      unitId: agendamento.unitId,
      originAttendanceId: registro.id,
      dueDate: paraData(vencimento),
      createdByMembershipId: auth.membershipId as string,
    },
  } as never)) as unknown as ReturnRow;
  await audit.record(tx, workspaceId, 'clinics.return.created', {
    entityType: 'clinicsReturn',
    entityId: criado.id,
    actor: audit.actorFrom(auth),
    after: trilha(criado),
  });
}

// ── funções do módulo ──────────────────────────────────────────────────────

async function lerRetorno(db: Db, id: string): Promise<ReturnRow> {
  const row = (await db.clinicsReturn.findFirst({ where: { id } })) as unknown as ReturnRow | null;
  if (!row) throw new NotFoundException('Retorno não encontrado');
  return row;
}

async function lerComNomes(db: Db, id: string): Promise<ReturnComNomes> {
  const row = (await db.clinicsReturn.findFirst({
    where: { id },
    include: COM_NOMES,
  } as never)) as unknown as ReturnComNomes | null;
  if (!row) throw new NotFoundException('Retorno não encontrado');
  return row;
}

/**
 * Trava a linha do retorno PENDENTE, sem mudar nada, antes de ler: quem lê
 * depois vê a versão que a sua escrita vai substituir. O encerrado não é
 * travado (a condição não o pega), e não muda mais: a leitura já é a final.
 *
 * Depende de READ COMMITTED (o padrão): depois da espera, a condição é
 * reavaliada na versão nova e a leitura seguinte usa um snapshot novo. Em
 * REPEATABLE READ, a própria trava falharia com erro de serialização (40001)
 * se a linha mudou: falha fechada, não uma leitura velha.
 */
async function travarRetornoPendente(tx: Db, id: string): Promise<void> {
  await tx.clinicsReturn.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'pending' },
  } as never);
}

/** Trava as linhas dos agendamentos em ordem de id: duas trocas cruzadas não se travam. */
async function travarAgendamentos(tx: Db, ids: (string | null)[]): Promise<void> {
  const ordenados = [...new Set(ids.filter((id): id is string => id !== null))].sort();
  for (const id of ordenados) {
    const { count } = await tx.clinicsAppointment.updateMany({
      where: { id },
      data: { updatedAt: new Date() },
    } as never);
    if (count === 0) throw new NotFoundException('Agendamento não encontrado');
  }
}

/** Papéis que podem ser responsáveis: veem a lista e agem sobre o retorno. */
async function papeisAptos(db: Db, roleIds: string[]): Promise<Set<string>> {
  if (roleIds.length === 0) return new Set();
  const linhas = (await db.rolePermission.findMany({
    where: {
      roleId: { in: [...new Set(roleIds)] },
      permissionKey: { in: [AGENDA_LER, AGENDA_ESCREVER, ATENDIMENTO_ESCREVER] },
    },
    select: { roleId: true, permissionKey: true },
  })) as unknown as { roleId: string; permissionKey: string }[];
  const porPapel = new Map<string, Set<string>>();
  for (const l of linhas)
    porPapel.set(l.roleId, (porPapel.get(l.roleId) ?? new Set()).add(l.permissionKey));
  return new Set(
    [...porPapel]
      .filter(
        ([, k]) => k.has(AGENDA_LER) && (k.has(AGENDA_ESCREVER) || k.has(ATENDIMENTO_ESCREVER)),
      )
      .map(([roleId]) => roleId),
  );
}

/** O responsável: membro deste workspace, ativo, que vê a lista e pode agir. */
async function conferirResponsavel(tx: Db, membershipId: string): Promise<void> {
  const membro = (await tx.membership.findFirst({
    where: { id: membershipId },
    select: { status: true, roleId: true },
  })) as unknown as { status: string; roleId: string } | null;
  if (!membro) throw new NotFoundException('Membro não encontrado');
  if (membro.status !== 'active' || !(await papeisAptos(tx, [membro.roleId])).has(membro.roleId)) {
    // uma mensagem só: não diz qual condição faltou
    throw new BadRequestException('Este membro não pode ser responsável por retornos');
  }
}

async function unidadeDoRetorno(tx: Db, unitId?: string): Promise<string> {
  if (unitId) {
    const unidade = await tx.clinicsUnit.findFirst({
      where: { id: unitId, archivedAt: null },
      select: { id: true },
    });
    if (!unidade) throw new NotFoundException('Unidade não encontrada');
    return unitId;
  }
  const ativas = (await tx.clinicsUnit.findMany({
    where: { archivedAt: null },
    select: { id: true },
    take: 2,
  })) as unknown as { id: string }[];
  if (ativas.length !== 1) throw new BadRequestException('Informe a unidade');
  return ativas[0].id;
}

/** O cancelamento repetido: o mesmo motivo, por quem encerrou. */
function mesmoPedido(
  row: ReturnRow,
  motivo: ClinicsReturnCancelReason,
  auth: AuthContext,
): boolean {
  return (
    row.status === 'canceled' &&
    row.cancelReason === motivo &&
    row.closedByMembershipId === auth.membershipId
  );
}

/** O que o banco recusou no vínculo vira a recusa da API, sem citar o que não é projetado. */
function traduzirVinculo(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return new ConflictException(JA_VINCULADO);
  }
  // o gatilho (estado, prova) ou a FK do vínculo: a mesma recusa neutra
  if (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
    ['23514', '23503'].includes(postgresErrorCode(error) ?? '')
  ) {
    return new ConflictException(NAO_PODE_CUMPRIR);
  }
  return error;
}

/** A trilha do retorno: ids, vencimento, estado, origem e motivo. */
export function trilha(row: ReturnRow): Record<string, unknown> {
  return {
    patientId: row.patientId,
    serviceId: row.serviceId,
    unitId: row.unitId,
    dueDate: paraDia(row.dueDate),
    status: row.status,
    origin: row.originAttendanceId ? 'automatic' : 'manual',
    appointmentId: row.appointmentId,
    fulfilledByAttendanceId: row.fulfilledByAttendanceId,
    assigneeMembershipId: row.assigneeMembershipId,
    cancelReason: row.cancelReason,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** O ISO que o servidor escreve, com ano de 4 dígitos (o ano 0000 é recusado abaixo). */
const INSTANTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** O cursor dos candidatos: opaco, com o início e o id do último da página. */
function escreverCursor(a: { id: string; startsAt: Date }): string {
  return Buffer.from(JSON.stringify([a.startsAt.toISOString(), a.id])).toString('base64url');
}

function lerCursor(cursor: string): { startsAt: Date; id: string } {
  try {
    const [inicio, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const startsAt = new Date(String(inicio));
    // estrito: um UUID de verdade e um instante que volta IGUAL ao que o
    // servidor escreveu, de 0001 a 9999 (o Postgres não tem ano zero). Um
    // cursor forjado é 400, nunca um erro do banco
    if (
      typeof inicio === 'string' &&
      typeof id === 'string' &&
      INSTANTE_ISO.test(inicio) &&
      UUID.test(id) &&
      !Number.isNaN(startsAt.getTime()) &&
      startsAt.getUTCFullYear() >= 1 &&
      startsAt.toISOString() === inicio
    ) {
      return { startsAt, id };
    }
  } catch {
    // cai na recusa abaixo
  }
  throw new BadRequestException('Cursor inválido');
}

/** `AAAA-MM-DD` → a coluna `date` (meia-noite UTC, sem fuso). */
function paraData(dia: string): Date {
  return new Date(`${dia}T00:00:00.000Z`);
}

function paraDia(data: Date): string {
  return data.toISOString().slice(0, 10);
}

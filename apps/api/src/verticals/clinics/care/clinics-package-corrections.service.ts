import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import type {
  ClinicsPackageCorrectionDto,
  ClinicsPackageCorrectionReason,
  ClinicsPackageSessionsDto,
  ClinicsPackageStatus,
  ClinicsPermissionKey,
  CorrectClinicsPackageConsumptionInput,
} from '@veyra/contracts/verticals/clinics';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import {
  MudancasDeRestricao,
  type ExecutorDeTransacao,
} from '../../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import {
  AlcanceClinicoService,
  DE_OUTRO_PROFISSIONAL,
  alcanca,
  exigirAlcance,
  type AlcanceClinico,
} from './clinics-care-scope';
import { trilha, type PackageRow } from './clinics-packages.service';

/** O client protegido, com o nível de isolamento da leitura das sessões. */
type Leitor = {
  $transaction<T>(
    fn: (tx: Db) => Promise<T>,
    options: { isolationLevel: Prisma.TransactionIsolationLevel },
  ): Promise<T>;
};

type CorrectionRow = {
  id: string;
  attendanceId: string;
  appointmentId: string;
  fromPackageId: string | null;
  toPackageId: string | null;
  revision: number;
  reason: ClinicsPackageCorrectionReason;
  correctedByMembershipId: string;
  createdAt: Date;
};

type ConsumoAtual = {
  id: string;
  professionalId: string;
  currentPackageId: string | null;
  consumptionRevision: number;
  /** o instante do registro, pelo relógio do banco */
  recordedAt: Date;
};

/** A mesma resposta para toda corrida perdida e todo "esperado" velho. */
const CONSUMO_MUDOU =
  'O consumo deste atendimento mudou desde que você o abriu; recarregue e confira antes de corrigir';

/**
 * Correção do consumo de um atendimento registrado (ADR-059, F5.2a).
 *
 * A correção é um lançamento próprio, só de acréscimo: a escolha original do
 * registro fica, e o consumo vigente e a revisão dele avançam pelo gatilho da
 * inserção da correção, que confere que ela parte deles. O banco confere no
 * COMMIT que as consumidas de cada pacote tocado batem com os atendimentos que
 * o consomem. A devolução, o novo consumo, os estados, a correção e a auditoria
 * confirmam ou desfazem juntos.
 *
 * A ordem das travas é a do registro de atendimento: o agendamento, depois os
 * pacotes em ordem de id. O gatilho trava a linha do atendimento depois disso
 * (`FOR NO KEY UPDATE`, o modo do UPDATE seguinte), e nenhum outro caminho
 * trava atendimento antes de pacote: o registro só cria o atendimento novo, e
 * o vínculo do retorno pede no atendimento só a trava da FK, sob a trava do
 * agendamento. A transação é a interativa do registro: espera de trava e
 * prazo limitados, e o prazo vencido é 409, sem efeito.
 *
 * A repetição é da `Idempotency-Key` (obrigatória na rota); aqui, a identidade
 * do pedido é a revisão esperada: uma chave nova com a revisão velha é 409.
 */
@Injectable()
export class ClinicsPackageCorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly transacao: MudancasDeRestricao,
    private readonly alcanceClinico: AlcanceClinicoService,
  ) {}

  async correct(
    auth: AuthContext,
    appointmentId: string,
    input: CorrectClinicsPackageConsumptionInput,
  ): Promise<ClinicsPackageCorrectionDto> {
    const workspaceId = auth.workspaceId as string;
    // a correção revela pacote e saldo: quem corrige precisa poder lê-los. A
    // regra mora AQUI, e não só na rota, para valer a qualquer chamador futuro
    const careRead = 'clinics:care:read' satisfies ClinicsPermissionKey;
    if (!(await this.permissions.has(auth, careRead as PermissionKey))) {
      throw new ForbiddenException('Corrigir o consumo exige a leitura do atendimento');
    }
    // D8 (ADR-061): só o atendimento no alcance; sem vínculo válido, nenhum
    const alcance = await this.alcanceClinico.de(auth);
    exigirAlcance(alcance);
    // em minúsculas, como o banco devolve os ids
    const novo = input.packageId === null ? null : input.packageId.toLowerCase();
    if (input.reason === 'package_registered_late' && novo === null) {
      throw new BadRequestException(
        '"Pacote cadastrado depois do atendimento" só vale de avulso para um pacote',
      );
    }
    try {
      const row = await this.transacao.naTransacaoInterativa(
        this.prisma.db as unknown as ExecutorDeTransacao,
        async (tx) => {
          // 1. o agendamento: serializa as correções do mesmo atendimento, na
          // ordem de travas do registro
          const agendamento = await travarAgendamento(tx, appointmentId);
          const atual = (await tx.clinicsAttendance.findFirst({
            where: { appointmentId },
            select: {
              id: true,
              professionalId: true,
              currentPackageId: true,
              consumptionRevision: true,
              recordedAt: true,
            },
          })) as unknown as ConsumoAtual | null;
          if (!atual) throw new NotFoundException('Atendimento não registrado');
          // o dono é o do REGISTRO, imutável: o alheio é recusado antes de
          // qualquer leitura de consumo ou pacote
          if (!alcanca(alcance, atual.professionalId)) {
            throw new ForbiddenException(DE_OUTRO_PROFISSIONAL);
          }
          if (atual.consumptionRevision !== input.expectedRevision) {
            throw new ConflictException(CONSUMO_MUDOU);
          }
          const de = atual.currentPackageId;
          if (de === novo) {
            throw new BadRequestException('O consumo escolhido já é o deste atendimento');
          }
          if (input.reason === 'package_registered_late' && de !== null) {
            throw new BadRequestException(
              '"Pacote cadastrado depois do atendimento" só vale de avulso para um pacote',
            );
          }
          // 2. os pacotes, em ordem de id: a devolução e o novo consumo
          const tocados = [de, novo].filter((x): x is string => x !== null).sort();
          for (const id of tocados) {
            if (id === de) await devolver(tx, id);
            else await consumir(tx, id, agendamento, atual, input.reason);
          }
          // 3. a correção: o gatilho confere a revisão e o vigente e os avança
          const correcao = (await tx.clinicsPackageCorrection.create({
            data: {
              workspaceId,
              attendanceId: atual.id,
              appointmentId,
              patientId: agendamento.patientId,
              serviceId: agendamento.serviceId,
              unitId: agendamento.unitId,
              fromPackageId: de,
              toPackageId: novo,
              revision: atual.consumptionRevision + 1,
              reason: input.reason,
              correctedByMembershipId: auth.membershipId as string,
            },
          } as never)) as unknown as CorrectionRow;
          // 4. a auditoria, na mesma transação: ids, contagens e estados. O
          // "depois" é lido sob as travas; o "antes" sai dele (`antesDe`)
          const depois = await lerPacotes(tx, tocados);
          const devolvido = de ? depois.get(de) : undefined;
          const consumido = novo ? depois.get(novo) : undefined;
          await this.audit.record(tx, workspaceId, 'clinics.package.consumption_corrected', {
            entityType: 'clinicsPackageCorrection',
            entityId: correcao.id,
            actor: this.audit.actorFrom(auth),
            before: {
              fromPackage: devolvido ? antesDe(devolvido, +1) : null,
              toPackage: consumido ? antesDe(consumido, -1) : null,
            },
            after: {
              attendanceId: correcao.attendanceId,
              fromPackageId: correcao.fromPackageId,
              toPackageId: correcao.toPackageId,
              reason: correcao.reason,
              revision: correcao.revision,
              fromPackage: devolvido ? resumo(devolvido) : null,
              toPackage: consumido ? resumo(consumido) : null,
            },
          });
          // a correção que leva o pacote novo ao total o conclui, como o registro
          if (consumido?.status === 'completed') {
            await this.audit.record(tx, workspaceId, 'clinics.package.completed', {
              entityType: 'clinicsPackage',
              entityId: consumido.id,
              actor: this.audit.actorFrom(auth),
              after: trilha(consumido),
            });
          }
          return correcao;
        },
      );
      return toCorrectionDto(row);
    } catch (error) {
      // a revisão é única por atendimento: a corrida que a trava não pegou
      // falha fechada, sem efeito
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(CONSUMO_MUDOU);
      }
      throw error;
    }
  }

  /**
   * As sessões que consomem o pacote agora e as correções que o tocaram, lidas
   * do MESMO instante (REPEATABLE READ). As correções vêm das 100 mais
   * recentes; as sessões não passam do total do pacote (até 100).
   */
  async sessions(auth: AuthContext, packageId: string): Promise<ClinicsPackageSessionsDto> {
    // D8 (ADR-061): o alheio nem é lido (o filtro está na consulta)
    const alcance = await this.alcanceClinico.de(auth);
    exigirAlcance(alcance);
    return (this.prisma.db as unknown as Leitor).$transaction(
      (tx) => lerSessoes(tx, packageId, alcance),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Uma correção deste workspace, para a guarda do replay, e se o atendimento
   * dela está no alcance de quem repete AGORA (D8, ADR-061).
   */
  async noReplay(auth: AuthContext, id: string): Promise<'ausente' | 'fora' | 'ok'> {
    const row = (await this.prisma.db.clinicsPackageCorrection.findFirst({
      where: { id },
      select: { attendance: { select: { professionalId: true } } },
    } as never)) as unknown as { attendance: { professionalId: string } } | null;
    if (!row) return 'ausente';
    const alcance = await this.alcanceClinico.de(auth);
    return alcanca(alcance, row.attendance.professionalId) ? 'ok' : 'fora';
  }
}

async function lerSessoes(
  db: Db,
  packageId: string,
  alcance: AlcanceClinico,
): Promise<ClinicsPackageSessionsDto> {
  // só os do profissional vinculado, quando o alcance é "próprios": os alheios
  // não são lidos, nem como linha nem como id (o saldo do pacote os reflete)
  const proprio = alcance.tipo === 'proprios' ? { professionalId: alcance.professionalId } : {};
  const pacote = await db.clinicsPackage.findFirst({
    where: { id: packageId },
    select: { id: true },
  });
  if (!pacote) throw new NotFoundException('Pacote não encontrado');
  const sessoes = (await db.clinicsAttendance.findMany({
    where: { currentPackageId: packageId, ...proprio },
    select: {
      id: true,
      appointmentId: true,
      professionalId: true,
      completedAt: true,
      consumptionRevision: true,
    },
    orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
  } as never)) as unknown as {
    id: string;
    appointmentId: string;
    professionalId: string;
    completedAt: Date;
    consumptionRevision: number;
  }[];
  const correcoes = (await db.clinicsPackageCorrection.findMany({
    where: {
      OR: [{ fromPackageId: packageId }, { toPackageId: packageId }],
      ...(alcance.tipo === 'proprios' ? { attendance: proprio } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }, { id: 'asc' }],
    take: 100,
  } as never)) as unknown as CorrectionRow[];
  return {
    packageId: pacote.id,
    sessions: sessoes.map((s) => ({
      attendanceId: s.id,
      appointmentId: s.appointmentId,
      professionalId: s.professionalId,
      completedAt: s.completedAt.toISOString(),
      consumptionRevision: s.consumptionRevision,
    })),
    corrections: correcoes.map(toCorrectionDto),
  };
}

/**
 * Trava a linha do agendamento (a mesma técnica dos retornos: um `updateMany`
 * que segura a linha até o fim da transação) e devolve o que a correção precisa
 * dele. Depende de READ COMMITTED: depois da espera, a leitura seguinte vê o
 * que a outra transação confirmou.
 */
async function travarAgendamento(
  tx: Db,
  id: string,
): Promise<{ patientId: string; serviceId: string; unitId: string }> {
  const { count } = await tx.clinicsAppointment.updateMany({
    where: { id },
    data: { updatedAt: new Date() },
  } as never);
  if (count === 0) throw new NotFoundException('Agendamento não encontrado');
  return (await tx.clinicsAppointment.findFirst({
    where: { id },
    select: { patientId: true, serviceId: true, unitId: true },
  })) as unknown as { patientId: string; serviceId: string; unitId: string };
}

/**
 * A DEVOLUÇÃO: as consumidas descem uma. O pacote ativo continua ativo; o
 * concluído volta a ativo; o cancelado continua cancelado — quem decide é o
 * guarda do banco.
 */
async function devolver(tx: Db, id: string): Promise<void> {
  const { count } = await tx.clinicsPackage.updateMany({
    where: { id },
    data: { consumedSessions: { decrement: 1 } },
  } as never);
  if (count !== 1) throw new NotFoundException('Pacote não encontrado');
}

/**
 * O NOVO CONSUMO, com as condições do registro: o pacote do mesmo paciente e
 * serviço do agendamento, ativo e com saldo, num `UPDATE` condicional (a trava
 * de linha serializa com o registro e o cancelamento). Zero linhas: o motivo é
 * lido e a transação inteira volta, inclusive a devolução.
 */
async function consumir(
  tx: Db,
  id: string,
  agendamento: { patientId: string; serviceId: string },
  atendimento: ConsumoAtual,
  motivo: ClinicsPackageCorrectionReason,
): Promise<void> {
  // paciente, serviço e criação são imutáveis: lê-los antes da trava basta
  const pacote = (await tx.clinicsPackage.findFirst({
    where: { id },
    select: { patientId: true, serviceId: true, createdAt: true },
  })) as unknown as { patientId: string; serviceId: string; createdAt: Date } | null;
  if (!pacote) throw new NotFoundException('Pacote não encontrado');
  if (pacote.patientId !== agendamento.patientId || pacote.serviceId !== agendamento.serviceId) {
    throw new BadRequestException('O pacote é de outro paciente ou de outro serviço');
  }
  // os dois instantes são do relógio do BANCO: a criação do pacote, carimbada
  // por gatilho, e o registro do atendimento (ADR-049). O gatilho da correção
  // confere de novo
  if (motivo === 'package_registered_late' && pacote.createdAt <= atendimento.recordedAt) {
    throw new BadRequestException(
      'O pacote já existia quando o atendimento foi registrado: o motivo é "escolha errada"',
    );
  }
  const { count } = await tx.clinicsPackage.updateMany({
    where: {
      id,
      status: 'active',
      patientId: agendamento.patientId,
      serviceId: agendamento.serviceId,
    },
    data: { consumedSessions: { increment: 1 } },
  } as never);
  if (count === 1) return;
  const agora = (await tx.clinicsPackage.findFirst({
    where: { id },
    select: { status: true },
  })) as unknown as { status: ClinicsPackageStatus };
  throw new ConflictException(
    agora.status === 'completed'
      ? 'Pacote concluído: não há sessões a consumir; nada foi corrigido'
      : 'Pacote cancelado: nada foi corrigido',
  );
}

function resumo(p: PackageRow): { consumedSessions: number; status: ClinicsPackageStatus } {
  return { consumedSessions: p.consumedSessions, status: p.status };
}

/**
 * O pacote ANTES da correção, a partir do lido DEPOIS dela, sob a trava. É
 * exato porque o CHECK do pacote amarra o estado à contagem: ativo sempre tem
 * saldo, e concluído está sempre no total. `delta` é o que se soma ao depois:
 * +1 na devolução, −1 no novo consumo (que só acontece com o pacote ativo).
 */
function antesDe(
  depois: PackageRow,
  delta: 1 | -1,
): { consumedSessions: number; status: ClinicsPackageStatus } {
  const consumedSessions = depois.consumedSessions + delta;
  if (delta === -1) return { consumedSessions, status: 'active' };
  if (depois.status === 'canceled') return { consumedSessions, status: 'canceled' };
  return {
    consumedSessions,
    status: consumedSessions === depois.totalSessions ? 'completed' : 'active',
  };
}

async function lerPacotes(tx: Db, ids: string[]): Promise<Map<string, PackageRow>> {
  const rows = (await tx.clinicsPackage.findMany({
    where: { id: { in: ids } },
  })) as unknown as PackageRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

function toCorrectionDto(row: CorrectionRow): ClinicsPackageCorrectionDto {
  return {
    id: row.id,
    attendanceId: row.attendanceId,
    appointmentId: row.appointmentId,
    fromPackageId: row.fromPackageId,
    toPackageId: row.toPackageId,
    revision: row.revision,
    reason: row.reason,
    correctedByMembershipId: row.correctedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}

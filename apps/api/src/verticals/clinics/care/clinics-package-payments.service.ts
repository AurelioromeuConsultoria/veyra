import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import {
  horaLocal,
  type ClinicsPackageBalanceDto,
  type ClinicsPackagePaymentDto,
  type ClinicsPackagePaymentsDto,
  type ClinicsPackageStatus,
  type ClinicsPaymentActorDto,
  type ClinicsPaymentMethod,
  type ClinicsPaymentVoidReason,
  type ClinicsPermissionKey,
  type RecordClinicsPackagePaymentInput,
  type VoidClinicsPackagePaymentInput,
} from '@veyra/contracts/verticals/clinics';
import { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../audit/audit.service';
import { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import { postgresErrorCode } from '../../../common/prisma-exception.filter';
import {
  MudancasDeRestricao,
  type ExecutorDeTransacao,
} from '../../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../../prisma/prisma.service';
import { agoraDoBanco } from '../../../prisma/relogio-do-banco';

type PacoteFinanceiro = {
  id: string;
  patientId: string;
  serviceId: string;
  status: ClinicsPackageStatus;
  totalPriceCents: number | null;
  currency: string;
  createdAt: Date;
  service: { name: string };
};

type PagamentoRow = {
  id: string;
  packageId: string;
  amountCents: number;
  currency: string;
  receivedOn: Date;
  method: ClinicsPaymentMethod;
  createdByMembershipId: string;
  createdAt: Date;
  void: {
    reason: ClinicsPaymentVoidReason;
    voidedByMembershipId: string;
    createdAt: Date;
  } | null;
};

const SELECAO_DO_PACOTE = {
  id: true,
  patientId: true,
  serviceId: true,
  status: true,
  totalPriceCents: true,
  currency: true,
  createdAt: true,
  service: { select: { name: true } },
} as const;

const SELECAO_DO_PAGAMENTO = {
  id: true,
  packageId: true,
  amountCents: true,
  currency: true,
  receivedOn: true,
  method: true,
  createdByMembershipId: true,
  createdAt: true,
  void: { select: { reason: true, voidedByMembershipId: true, createdAt: true } },
} as const;

/** a recusa do registro acima do saldo: a mesma no pré-teste e na corrida */
const ACIMA_DO_SALDO =
  'O valor passa do saldo do pacote (o preço registrado menos o já recebido); nada foi registrado';
const CANCELADO = 'Pacote cancelado não recebe pagamento novo; nada foi registrado';
const JA_ANULADO = 'Este pagamento já foi anulado';

/**
 * Pagamentos de pacotes (ADR-063, F6.1a; fecha a D1 do ADR-048). Classe S.
 *
 * O pagamento é um LANÇAMENTO que não muda: valor em centavos (> 0, na moeda do
 * pacote), data LOCAL do recebimento, forma de lista fechada, autoria e
 * instante do banco. Corrigir é anular (um registro próprio, no máximo um por
 * pagamento) e registrar o certo. Nada aqui toca as sessões: o pagamento não
 * libera nem bloqueia consumo.
 *
 * A trava é do BANCO: o gatilho da inserção do pagamento e o da anulação travam
 * a linha do pacote (`FOR NO KEY UPDATE`), e o do pagamento confere ali o
 * estado e a soma dos não anulados contra o preço. Assim dois registros
 * simultâneos não passam do preço, quem quer que insira. O serviço só
 * pré-confere o pacote cancelado, para responder com a mensagem certa; o saldo
 * e a moeda ficam com o gatilho, e a recusa dele (inclusive a corrida perdida)
 * vira o 409 com a mensagem escolhida pelo estado de agora. A transação é a interativa,
 * com espera de trava e prazo limitados: o prazo vencido é 409, sem efeito.
 */
@Injectable()
export class ClinicsPackagePaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly transacao: MudancasDeRestricao,
  ) {}

  /** Os pacotes do paciente, com a visão financeira; sem sessões nem atendimentos. */
  async balances(patientId: string): Promise<ClinicsPackageBalanceDto[]> {
    const paciente = await this.prisma.db.clinicsPatient.findFirst({
      where: { id: patientId },
      select: { id: true },
    });
    if (!paciente) throw new NotFoundException('Paciente não encontrado');
    const pacotes = (await this.prisma.db.clinicsPackage.findMany({
      where: { patientId },
      select: SELECAO_DO_PACOTE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    } as never)) as unknown as PacoteFinanceiro[];
    const recebido = await recebidoPor(
      this.prisma.db,
      pacotes.map((p) => p.id),
    );
    return pacotes.map((p) => toBalanceDto(p, recebido.get(p.id) ?? 0));
  }

  /** O pacote, o saldo e o histórico inteiro dos pagamentos, com as anulações. */
  async detail(packageId: string): Promise<ClinicsPackagePaymentsDto> {
    const pacote = (await this.prisma.db.clinicsPackage.findFirst({
      where: { id: packageId },
      select: SELECAO_DO_PACOTE,
    } as never)) as unknown as PacoteFinanceiro | null;
    if (!pacote) throw new NotFoundException('Pacote não encontrado');
    const pagamentos = (await this.prisma.db.clinicsPackagePayment.findMany({
      where: { packageId },
      select: SELECAO_DO_PAGAMENTO,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    } as never)) as unknown as PagamentoRow[];
    const recebido = pagamentos
      .filter((p) => p.void === null)
      .reduce((soma, p) => soma + p.amountCents, 0);
    const nomes = await this.nomes(
      pagamentos.flatMap((p) => [
        p.createdByMembershipId,
        ...(p.void ? [p.void.voidedByMembershipId] : []),
      ]),
    );
    const unidade = await this.hojeNaUnidade();
    return {
      package: toBalanceDto(pacote, recebido),
      payments: pagamentos.map((p) => toPaymentDto(p, nomes)),
      today: unidade?.hoje ?? null,
      timezone: unidade?.fuso ?? null,
    };
  }

  /**
   * Registrar um pagamento recebido. A data não pode ser futura no fuso da
   * unidade (o relógio é o do banco, ADR-049); o pacote cancelado recusa; com
   * preço, o valor não passa do saldo. Concluído e sem preço aceitam.
   */
  async record(
    auth: AuthContext,
    packageId: string,
    input: RecordClinicsPackagePaymentInput,
  ): Promise<ClinicsPackagePaymentDto> {
    const workspaceId = auth.workspaceId as string;
    // a resposta revela o pacote e o pagamento: quem registra precisa poder
    // lê-los. A regra mora AQUI, e não só na rota, para valer a qualquer chamador
    await this.exigir(auth, 'clinics:payments:read');
    const hoje = (await this.hojeNaUnidade())?.hoje ?? null;
    if (hoje === null) {
      throw new BadRequestException(
        'A data do recebimento segue o fuso da unidade, e a clínica não tem exatamente uma unidade ativa',
      );
    }
    if (input.receivedOn > hoje) {
      throw new BadRequestException('A data do recebimento não pode ser futura');
    }
    let row: PagamentoRow;
    try {
      row = await this.transacao.naTransacaoInterativa(
        this.prisma.db as unknown as ExecutorDeTransacao,
        async (tx) => {
          const pacote = (await tx.clinicsPackage.findFirst({
            where: { id: packageId },
            select: { status: true, currency: true, totalPriceCents: true },
          })) as unknown as {
            status: ClinicsPackageStatus;
            currency: string;
            totalPriceCents: number | null;
          } | null;
          if (!pacote) throw new NotFoundException('Pacote não encontrado');
          // o pré-teste dá a mensagem; a garantia é do gatilho, sob a trava
          if (pacote.status === 'canceled') throw new ConflictException(CANCELADO);
          const criado = (await tx.clinicsPackagePayment.create({
            data: {
              workspaceId,
              packageId,
              amountCents: input.amountCents,
              currency: pacote.currency,
              receivedOn: diaParaData(input.receivedOn),
              method: input.method,
              createdByMembershipId: auth.membershipId as string,
            },
            select: SELECAO_DO_PAGAMENTO,
          } as never)) as unknown as PagamentoRow;
          await this.audit.record(tx, workspaceId, 'clinics.package.payment_recorded', {
            entityType: 'clinicsPackagePayment',
            entityId: criado.id,
            actor: this.audit.actorFrom(auth),
            after: {
              packageId,
              amountCents: criado.amountCents,
              currency: criado.currency,
              receivedOn: dataParaDia(criado.receivedOn),
              method: criado.method,
            },
          });
          return criado;
        },
      );
    } catch (error) {
      // a recusa do gatilho (a corrida que a trava pegou): o estado de AGORA
      // escolhe a mensagem — o cancelado, ou o saldo que acabou
      if (postgresErrorCode(error) === '23514') {
        const agora = await this.prisma.db.clinicsPackage.findFirst({
          where: { id: packageId },
          select: { status: true },
        });
        throw new ConflictException(
          (agora as { status?: string } | null)?.status === 'canceled' ? CANCELADO : ACIMA_DO_SALDO,
        );
      }
      throw error;
    }
    return toPaymentDto(row, await this.nomes([row.createdByMembershipId]));
  }

  /**
   * Anular um pagamento: um registro próprio, no máximo um por pagamento (a
   * única do banco); o original fica, marcado como anulado. O pacote cancelado
   * aceita. Anular não é devolver ao paciente.
   */
  async void(
    auth: AuthContext,
    paymentId: string,
    input: VoidClinicsPackagePaymentInput,
  ): Promise<ClinicsPackagePaymentDto> {
    const workspaceId = auth.workspaceId as string;
    await this.exigir(auth, 'clinics:payments:read');
    let row: PagamentoRow;
    try {
      row = await this.transacao.naTransacaoInterativa(
        this.prisma.db as unknown as ExecutorDeTransacao,
        async (tx) => {
          const pagamento = (await tx.clinicsPackagePayment.findFirst({
            where: { id: paymentId },
            select: { packageId: true, void: { select: { reason: true } } },
          } as never)) as unknown as { packageId: string; void: unknown } | null;
          if (!pagamento) throw new NotFoundException('Pagamento não encontrado');
          if (pagamento.void) throw new ConflictException(JA_ANULADO);
          // o gatilho trava o pacote; a segunda anulação concorrente esbarra na única
          const anulacao = (await tx.clinicsPackagePaymentVoid.create({
            data: {
              workspaceId,
              paymentId,
              reason: input.reason,
              voidedByMembershipId: auth.membershipId as string,
            },
            select: { id: true },
          } as never)) as unknown as { id: string };
          await this.audit.record(tx, workspaceId, 'clinics.package.payment_voided', {
            entityType: 'clinicsPackagePaymentVoid',
            entityId: anulacao.id,
            actor: this.audit.actorFrom(auth),
            after: { paymentId, packageId: pagamento.packageId, reason: input.reason },
          });
          return (await tx.clinicsPackagePayment.findFirst({
            where: { id: paymentId },
            select: SELECAO_DO_PAGAMENTO,
          } as never)) as unknown as PagamentoRow;
        },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(JA_ANULADO);
      }
      throw error;
    }
    return toPaymentDto(
      row,
      await this.nomes([
        row.createdByMembershipId,
        ...(row.void ? [row.void.voidedByMembershipId] : []),
      ]),
    );
  }

  /** Para a guarda do replay: o pagamento ainda é deste workspace? */
  async existe(paymentId: string): Promise<boolean> {
    return (
      (await this.prisma.db.clinicsPackagePayment.findFirst({
        where: { id: paymentId },
        select: { id: true },
      })) !== null
    );
  }

  private async exigir(auth: AuthContext, chave: ClinicsPermissionKey): Promise<void> {
    if (!(await this.permissions.has(auth, chave as PermissionKey))) {
      throw new ForbiddenException('Permissão insuficiente');
    }
  }

  /**
   * A data local de hoje na unidade, pelo relógio do BANCO (ADR-049), e o fuso
   * dela: a única unidade ativa, como a agenda sem `unitId` (o pacote não guarda
   * unidade; limitação registrada no ADR-063). Sem exatamente uma, `null`.
   */
  private async hojeNaUnidade(): Promise<{ hoje: string; fuso: string } | null> {
    const ativas = (await this.prisma.db.clinicsUnit.findMany({
      where: { archivedAt: null },
      select: { timezone: true },
      take: 2,
    })) as unknown as { timezone: string }[];
    if (ativas.length !== 1) return null;
    const fuso = ativas[0].timezone;
    return { hoje: horaLocal(await agoraDoBanco(this.prisma), fuso).data, fuso };
  }

  /** O nome de exibição de cada membership deste workspace (vazio se não há). */
  private async nomes(membershipIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return new Map();
    const memberships = (await this.prisma.db.membership.findMany({
      where: { id: { in: ids } },
      select: { id: true, userId: true },
    })) as unknown as { id: string; userId: string }[];
    // raw justificado: o nome (User global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: [...new Set(memberships.map((m) => m.userId))] } },
      select: { id: true, name: true },
    });
    const nomeDoUser = new Map(users.map((u) => [u.id, u.name]));
    return new Map(memberships.map((m) => [m.id, nomeDoUser.get(m.userId) ?? '']));
  }
}

/** A soma dos pagamentos NÃO anulados de cada pacote. */
async function recebidoPor(db: Db, packageIds: string[]): Promise<Map<string, number>> {
  if (packageIds.length === 0) return new Map();
  const pagamentos = (await db.clinicsPackagePayment.findMany({
    where: { packageId: { in: packageIds }, void: { is: null } },
    select: { packageId: true, amountCents: true },
  } as never)) as unknown as { packageId: string; amountCents: number }[];
  const soma = new Map<string, number>();
  for (const p of pagamentos) soma.set(p.packageId, (soma.get(p.packageId) ?? 0) + p.amountCents);
  return soma;
}

function toBalanceDto(p: PacoteFinanceiro, recebido: number): ClinicsPackageBalanceDto {
  return {
    packageId: p.id,
    patientId: p.patientId,
    serviceId: p.serviceId,
    serviceName: p.service.name,
    status: p.status,
    totalPriceCents: p.totalPriceCents,
    currency: p.currency,
    receivedCents: recebido,
    balanceCents: p.totalPriceCents === null ? null : p.totalPriceCents - recebido,
    createdAt: p.createdAt.toISOString(),
  };
}

function ator(membershipId: string, nomes: Map<string, string>): ClinicsPaymentActorDto {
  return { membershipId, name: nomes.get(membershipId) ?? '' };
}

function toPaymentDto(p: PagamentoRow, nomes: Map<string, string>): ClinicsPackagePaymentDto {
  return {
    id: p.id,
    packageId: p.packageId,
    amountCents: p.amountCents,
    currency: p.currency,
    receivedOn: dataParaDia(p.receivedOn),
    method: p.method,
    createdBy: ator(p.createdByMembershipId, nomes),
    createdAt: p.createdAt.toISOString(),
    void: p.void
      ? {
          reason: p.void.reason,
          voidedBy: ator(p.void.voidedByMembershipId, nomes),
          createdAt: p.void.createdAt.toISOString(),
        }
      : null,
  };
}

/** `AAAA-MM-DD` → a coluna `date` (meia-noite UTC, sem fuso). */
function diaParaData(dia: string): Date {
  return new Date(`${dia}T00:00:00.000Z`);
}

function dataParaDia(data: Date): string {
  return data.toISOString().slice(0, 10);
}

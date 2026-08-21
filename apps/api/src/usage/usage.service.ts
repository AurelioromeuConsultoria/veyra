import { Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { USAGE_METRICS, periodEnd, periodKeyFor, type MetricKey } from './metrics';
import { QuotaExceededException } from './quota.exception';

type AnyClient = Db | Prisma.TransactionClient;

/** Reserva de IA expira se o processo morrer entre reservar e liquidar. */
const RESERVATION_TTL_MS = 10 * 60_000;

export interface UsageSnapshot {
  metric: string;
  label: string;
  kind: 'counter' | 'gauge';
  unit: 'count' | 'bytes' | 'usd_cents';
  used: number;
  limit: number | null;
  enforced: boolean;
  resetsAt: string | null;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Incremento ATÔMICO com verificação de limite, DENTRO da transação de quem
   * chama (ADR-032). O `ON CONFLICT DO UPDATE … RETURNING` devolve o valor já
   * somado; se ele passar do teto, a exceção derruba a transação e o contador
   * volta pelo rollback — sem compensação manual e sem janela de corrida.
   *
   * `delta` negativo (arquivar, excluir) nunca é barrado por limite.
   */
  async consume(
    tx: AnyClient,
    workspaceId: string,
    metric: MetricKey,
    delta: number,
  ): Promise<void> {
    const definition = USAGE_METRICS[metric];
    const period = periodKeyFor(definition.kind);
    const limit = definition.enforced ? await this.limitFor(workspaceId, metric) : null;
    await this.ensureRow(metric);
    const value = await this.applyDelta(tx, metric, period, delta);

    if (limit !== null && delta > 0 && value > limit) {
      // `value` já inclui o que está reservado: a reserva vive no próprio
      // contador, e não numa soma paralela que poderia divergir
      throw new QuotaExceededException(
        metric,
        limit,
        value,
        definition.kind === 'counter' ? periodEnd() : null,
      );
    }
  }

  /**
   * Incremento ATÔMICO sem SQL cru: `increment` do Prisma vira
   * `SET value = value + n` no banco, então duas transações concorrentes
   * somam — a segunda espera o lock da linha, não lê valor velho. A leitura
   * seguinte, dentro da MESMA transação, enxerga o valor pós-update e nenhuma
   * outra transação consegue alterá-lo antes do nosso commit.
   *
   * (O client protegido bloqueia SQL cru por desenho — SECURITY.md §2 — e essa
   * barreira pegou a primeira versão deste método.)
   */
  private async applyDelta(
    tx: AnyClient,
    metric: string,
    period: string,
    delta: number,
    /** explícito nos caminhos sem CLS (ingestão de canal externo) */
    workspaceId?: string,
  ): Promise<number> {
    const client = tx as Db;
    const where = workspaceId ? { workspaceId, metric, period } : { metric, period };
    const { count } = await client.usageCounter.updateMany({
      where,
      data: { value: { increment: delta } },
    });
    if (count === 0) {
      // a linha deveria existir: `ensureRow` roda ANTES da transação de
      // domínio justamente porque uma colisão de unique aqui dentro abortaria
      // a transação inteira no Postgres (25P02), sem chance de retry
      throw new Error(`Linha de uso ausente para ${metric}/${period}`);
    }
    const row = (await client.usageCounter.findFirst({
      where,
      select: { value: true },
    })) as unknown as { value: bigint } | null;
    const value = Number(row?.value ?? 0);
    // gauge nunca fica negativo (exclusão dupla, backfill defasado)
    if (value < 0) {
      await client.usageCounter.updateMany({ where, data: { value: 0 } });
      return 0;
    }
    return value;
  }

  /**
   * Consome SEM barrar no limite, para caminhos em que recusar causa dano maior
   * que estourar o teto — hoje só a ingestão de canal externo (ADR-040):
   * perder a mensagem de um paciente por limite de plano é irrecuperável para
   * ele, enquanto ultrapassar o teto é um problema de cobrança, visível no
   * medidor e resolvido com uma conversa.
   */
  async consumeOverLimit(
    tx: AnyClient,
    workspaceId: string,
    metric: MetricKey,
    delta: number,
  ): Promise<void> {
    const period = periodKeyFor(USAGE_METRICS[metric].kind);
    // a linha precisa existir ANTES: quem chama de dentro de uma transação sem
    // CLS garante isso com `ensureCounterRow`
    await this.applyDelta(tx, metric, period, delta, workspaceId);
  }

  /**
   * RESERVA durável do teto do run antes de chamar o provedor (ADR-033).
   * Incrementar só depois da resposta não protege nada: N chamadas simultâneas
   * passam todas na checagem e o teto é furado N vezes — e o dinheiro já foi
   * gasto quando a conta chega.
   */
  async reserve(
    workspaceId: string,
    metric: MetricKey,
    amount: number,
  ): Promise<{ reservationId: string } | 'quota_exceeded'> {
    const definition = USAGE_METRICS[metric];
    const period = periodKeyFor(definition.kind);
    const limit = await this.limitFor(workspaceId, metric);
    await this.ensureRow(metric);
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };

    try {
      return await db.$transaction(async (tx) => {
        // a RESERVA é o próprio incremento do contador: ler-depois-inserir
        // teria exatamente o defeito que a reserva existe para corrigir (seis
        // chamadas simultâneas leriam zero reservado e passariam todas). Como
        // increment serializa no lock da linha, o teto vale de verdade.
        const value = await this.applyDelta(tx, metric, period, amount);
        if (limit !== null && value > limit) {
          throw new QuotaExceededException(
            metric,
            limit,
            value,
            definition.kind === 'counter' ? periodEnd() : null,
          );
        }
        const created = await tx.usageReservation.create({
          data: {
            metric,
            period,
            amount,
            expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
          },
        } as never);
        return { reservationId: (created as unknown as { id: string }).id };
      });
    } catch (error) {
      // o rollback já desfez o incremento — nada a compensar
      if (error instanceof QuotaExceededException) return 'quota_exceeded';
      throw error;
    }
  }

  /**
   * Liquida pelo custo REAL: o contador já carrega o valor reservado, então a
   * diferença (real − reservado) é o ajuste — negativo devolve o que sobrou.
   */
  async settle(
    workspaceId: string,
    reservationId: string,
    metric: MetricKey,
    actualAmount: number,
  ): Promise<void> {
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    await db.$transaction(async (tx) => {
      const reservation = (await tx.usageReservation.findFirst({
        where: { id: reservationId },
        select: { amount: true, metric: true, period: true },
      })) as unknown as { amount: number; metric: string; period: string } | null;
      // já varrida por expiração: o valor reservado voltou ao orçamento e
      // cobrar agora seria cobrar duas vezes
      if (!reservation) return;
      await tx.usageReservation.deleteMany({ where: { id: reservationId } });
      const difference = actualAmount - reservation.amount;
      if (difference !== 0) {
        await this.applyDelta(tx, reservation.metric, reservation.period, difference);
      }
    });
  }

  /** Libera a reserva inteira (chamada falhou, nada foi gasto). */
  async release(reservationId: string): Promise<void> {
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    await db.$transaction(async (tx) => {
      const reservation = (await tx.usageReservation.findFirst({
        where: { id: reservationId },
        select: { amount: true, metric: true, period: true },
      })) as unknown as { amount: number; metric: string; period: string } | null;
      if (!reservation) return;
      await tx.usageReservation.deleteMany({ where: { id: reservationId } });
      await this.applyDelta(tx, reservation.metric, reservation.period, -reservation.amount);
    });
  }

  /**
   * Varre reservas órfãs (processo morto entre reservar e liquidar) devolvendo
   * o valor ao contador. Sem isso, orçamento ficaria preso para sempre.
   */
  async purgeExpiredReservations(): Promise<number> {
    // raw justificado: rotina cross-workspace (SECURITY.md §2), com workspaceId
    // explícito em cada ajuste
    const expired = await this.prisma.raw.usageReservation.findMany({
      where: { expiresAt: { lt: new Date() } },
    });
    for (const reservation of expired) {
      await this.prisma.raw.$transaction(async (tx) => {
        const { count } = await tx.usageReservation.deleteMany({ where: { id: reservation.id } });
        if (count === 0) return; // outra instância varreu antes
        await tx.usageCounter.updateMany({
          where: {
            workspaceId: reservation.workspaceId,
            metric: reservation.metric,
            period: reservation.period,
          },
          data: { value: { decrement: reservation.amount } },
        });
      });
    }
    if (expired.length > 0) {
      this.logger.warn(
        `${expired.length} reserva(s) de uso expiradas foram devolvidas ao orçamento`,
      );
    }
    return expired.length;
  }

  async snapshot(workspaceId: string): Promise<UsageSnapshot[]> {
    const limits = await this.limitsFor(workspaceId);
    const counters = (await this.prisma.db.usageCounter.findMany({})) as unknown as {
      metric: string;
      period: string;
      value: bigint;
    }[];
    return Object.values(USAGE_METRICS).map((definition) => {
      const period = periodKeyFor(definition.kind);
      const row = counters.find((c) => c.metric === definition.key && c.period === period);
      const limit = limits.get(definition.key);
      return {
        metric: definition.key,
        label: definition.label,
        kind: definition.kind,
        unit: definition.unit,
        used: Number(row?.value ?? 0),
        limit: limit ?? null,
        enforced: definition.enforced,
        resetsAt: definition.kind === 'counter' ? periodEnd().toISOString() : null,
      };
    });
  }

  /**
   * Garante a linha do contador FORA da transação de domínio. Criar lá dentro
   * exporia a corrida da primeira escrita a um `P2002`, e no Postgres um erro
   * dentro da transação a aborta por inteiro — não há retry possível ali.
   * Criar a linha zerada é inofensivo mesmo se a transação de domínio abortar.
   */
  /** Caminho com CLS: o workspace vem do contexto da request. */
  private async ensureRow(metric: MetricKey): Promise<void> {
    await this.ensureCounterRow(this.cls.get<string>('workspaceId'), metric);
  }

  /**
   * Garante a linha do contador com `workspaceId` EXPLÍCITO, para caminhos sem
   * CLS — a ingestão de canal externo não tem sessão (ADR-037). Precisa rodar
   * FORA da transação de domínio: criar lá dentro exporia a corrida da primeira
   * escrita a um `P2002`, e no Postgres um erro dentro da transação a aborta por
   * inteiro.
   *
   * `raw` justificado: workspaceId explícito, caminho sem contexto (§2).
   */
  async ensureCounterRow(workspaceId: string, metric: MetricKey): Promise<void> {
    const period = periodKeyFor(USAGE_METRICS[metric].kind);
    const existing = await this.prisma.raw.usageCounter.findFirst({
      where: { workspaceId, metric, period },
      select: { id: true },
    });
    if (existing) return;
    try {
      await this.prisma.raw.usageCounter.create({
        data: { workspaceId, metric, period, value: 0 },
      });
    } catch (error) {
      // outra requisição criou primeiro: exatamente o que queremos
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  /** Teto do plano vigente; `null` = métrica sem limite declarado. */
  async limitFor(workspaceId: string, metric: MetricKey): Promise<number | null> {
    return (await this.limitsFor(workspaceId)).get(metric) ?? null;
  }

  private async limitsFor(workspaceId: string): Promise<Map<string, number>> {
    // raw justificado: Subscription é do workspace, mas Plan/PlanLimit são
    // catálogo GLOBAL (ADR-034) e ficam fora do client filtrado
    const subscription = await this.prisma.raw.subscription.findFirst({
      where: { workspaceId, status: 'active' },
      select: { planKey: true },
    });
    if (!subscription) return new Map();
    const limits = await this.prisma.raw.planLimit.findMany({
      where: { planKey: subscription.planKey },
    });
    return new Map(limits.map((limit) => [limit.metric, Number(limit.value)]));
  }

  /** Liquidação: soma o custo REAL, sem barrar — o gasto já aconteceu. */
  private async consumeWithoutLimit(tx: AnyClient, metric: string, delta: number): Promise<void> {
    await this.applyDelta(tx, metric, periodKeyFor(USAGE_METRICS[metric].kind), delta);
  }
}

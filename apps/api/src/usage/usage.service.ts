import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { USAGE_METRICS, catalogGapAlert, periodEnd, periodKeyFor, type MetricKey } from './metrics';
import { QuotaExceededException } from './quota.exception';
import type { AppliedPlanDto } from '@veyra/contracts';

type AnyClient = Db | Prisma.TransactionClient;

/** Teto com PROCEDÊNCIA: de onde ele veio muda o que a tela precisa dizer. */
interface ResolvedLimit {
  value: number;
  source: 'plan' | 'default_plan' | 'code_floor';
}

/** Métricas que nunca ficam sem teto — citadas no alerta para não ser genérico. */
const NEVER_UNLIMITED = Object.values(USAGE_METRICS)
  .filter((definition) => definition.neverUnlimited)
  .map((definition) => definition.key);

/** Um alerta por workspace por hora: o caminho é quente (todo envio passa). */
const ALERT_THROTTLE_MS = 60 * 60_000;

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
  limitSource: 'plan' | 'default_plan' | 'code_floor' | null;
  resetsAt: string | null;
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  /** Último alerta por chave (assinatura ausente, lacuna de catálogo, piso). */
  private readonly alertsSent = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

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
    /**
     * Teto já resolvido por quem chama, FORA da transação. Resolver aqui pedia
     * uma segunda conexão do pool com a transação aberta — o mesmo defeito que
     * já corrigimos em `ensureCounterRow`: com N transações concorrentes e pool
     * de N, ninguém progride até o timeout e todas falham em bloco.
     */
    knownLimit?: number | null,
  ): Promise<void> {
    const definition = USAGE_METRICS[metric];
    const period = periodKeyFor(definition.kind);
    /**
     * O piso do ADR-041 mora em `limitsFor`, então um chamador que passasse
     * `knownLimit: null` para métrica de custo de terceiro furava a regra sem
     * tocar em nada marcado como sensível. Aqui isso é impossível: `null` para
     * essas métricas é ignorado e o teto é resolvido de verdade.
     */
    const declarado = definition.neverUnlimited && knownLimit === null ? undefined : knownLimit;
    const limit = definition.enforced
      ? declarado !== undefined
        ? declarado
        : await this.limitFor(workspaceId, metric)
      : null;
    // a linha do contador é garantida ANTES da transação, por quem chama
    // (`ensureCounterRow`). Fazer isso aqui abriria uma conexão NOVA dentro da
    // transação de domínio — sob concorrência, isso esgota o pool e as
    // requisições passam a falhar em bloco (a suíte pegou exatamente isso).
    const value = await this.applyDelta(tx, metric, period, delta, workspaceId);

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
    // aqui é seguro: estamos FORA da transação (ela abre abaixo)
    await this.ensureCounterRow(workspaceId, metric);
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
  ): Promise<boolean> {
    const db = this.prisma.db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    };
    return db.$transaction(async (tx) => {
      const reservation = (await tx.usageReservation.findFirst({
        where: { id: reservationId },
        select: { amount: true, metric: true, period: true },
      })) as unknown as { amount: number; metric: string; period: string } | null;
      /**
       * Já varrida por expiração: o valor reservado voltou ao orçamento. Devolve
       * `false` para que quem teve um efeito EXTERNO bem-sucedido possa cobrar o
       * valor real — antes isto era um `return` silencioso, e o envio saía sem
       * consumir quota nenhuma.
       */
      if (!reservation) return false;
      /**
       * A POSSE é o delete, não a leitura: dois liquidantes concorrentes (worker
       * e varredura de expiradas) leriam a mesma linha e aplicariam o ajuste
       * duas vezes. Só quem apagou de fato ajusta o contador.
       */
      const { count } = await tx.usageReservation.deleteMany({ where: { id: reservationId } });
      if (count === 0) return false;
      const difference = actualAmount - reservation.amount;
      if (difference !== 0) {
        await this.applyDelta(tx, reservation.metric, reservation.period, difference);
      }
      return true;
    });
  }

  /**
   * A reserva ainda existe e está viva? Necessário porque o TTL (10 min) é mais
   * curto que o backoff do outbox (até 25 min): um `reservationId` gravado no
   * dispatch pode apontar para uma reserva já expurgada, e confiar nele deixaria
   * o efeito externo acontecer sem vaga no teto.
   */
  async isReservationAlive(reservationId: string): Promise<boolean> {
    const row = await this.prisma.db.usageReservation.findFirst({
      where: { id: reservationId, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * A cota desta métrica já está no teto? Consulta de LEITURA, para a interface
   * poder dizer o motivo antes de o usuário tentar — usa o mesmo teto que a
   * reserva usaria, então tela e enforcement não divergem.
   */
  async isExhausted(workspaceId: string, metric: MetricKey): Promise<boolean> {
    const limit = await this.limitFor(workspaceId, metric);
    if (limit === null) return false;
    const row = await this.prisma.db.usageCounter.findFirst({
      where: { metric, period: periodKeyFor(USAGE_METRICS[metric].kind) },
      select: { value: true },
    });
    return Number(row?.value ?? 0) >= limit;
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
      // mesma regra do settle: quem apagou é quem devolve o valor
      const { count } = await tx.usageReservation.deleteMany({ where: { id: reservationId } });
      if (count === 0) return;
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

  /**
   * Exceção 402 estruturada para uma métrica (ADR-033). Existe para que quem
   * recusa um envio por quota devolva o MESMO contrato de erro do resto do
   * sistema, em vez de um 400 genérico.
   */
  async quotaExceeded(workspaceId: string, metric: MetricKey): Promise<QuotaExceededException> {
    const definition = USAGE_METRICS[metric];
    const period = periodKeyFor(definition.kind);
    const limit = (await this.limitFor(workspaceId, metric)) ?? 0;
    const row = await // raw justificado: usado também fora do CLS (worker de envio), com
    // workspaceId explícito no where — §3.3
    this.prisma.raw.usageCounter.findFirst({
      where: { workspaceId, metric, period },
      select: { value: true },
    });
    return new QuotaExceededException(
      metric,
      limit,
      Number(row?.value ?? 0),
      definition.kind === 'counter' ? periodEnd() : null,
    );
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
        limit: limit?.value ?? null,
        limitSource: limit?.source ?? null,
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
  /**
   * Prepara o consumo FORA da transação: garante a linha do contador e resolve o
   * teto do plano numa só passada. Quem consome DENTRO de uma transação deve
   * chamar isto antes e repassar o limite — resolver o teto lá dentro pedia uma
   * segunda conexão do pool, e sob concorrência isso derruba as requisições em
   * bloco (o mesmo defeito já corrigido em `ensureCounterRow`).
   */
  async prepareConsume(workspaceId: string, metric: MetricKey): Promise<number | null> {
    await this.ensureCounterRow(workspaceId, metric);
    return this.limitFor(workspaceId, metric);
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
    return (await this.limitsFor(workspaceId)).get(metric)?.value ?? null;
  }

  /**
   * Plano EFETIVAMENTE aplicado, que pode não ser o contratado: assinatura
   * cancelada mantém o registro e passa a valer o teto do padrão (ADR-041).
   * Mostrar o contratado nesse caso mente para quem tenta entender o 402.
   */
  async appliedPlan(workspaceId: string): Promise<AppliedPlanDto> {
    // raw justificado: `Plan` é catálogo GLOBAL (ADR-034), fora do client
    // filtrado; a `Subscription` leva `workspaceId` explícito no where
    const subscription = await this.prisma.raw.subscription.findFirst({
      where: { workspaceId, status: 'active' },
      include: { plan: true },
    });
    if (subscription) {
      return {
        key: subscription.plan.key,
        name: subscription.plan.name,
        source: 'subscription',
      };
    }
    const padrao = await this.prisma.raw.plan.findFirst({ where: { isDefault: true } });
    return padrao
      ? { key: padrao.key, name: padrao.name, source: 'default_plan' }
      : { key: '—', name: 'nenhum plano padrão', source: 'none' };
  }

  private async limitsFor(workspaceId: string): Promise<Map<string, ResolvedLimit>> {
    // raw justificado: Subscription é do workspace, mas Plan/PlanLimit são
    // catálogo GLOBAL (ADR-034) e ficam fora do client filtrado
    const subscription = await this.prisma.raw.subscription.findFirst({
      where: { workspaceId, status: 'active' },
      select: { planKey: true },
    });
    const mapa = new Map<string, ResolvedLimit>();
    if (subscription) {
      const limits = await this.prisma.raw.planLimit.findMany({
        where: { planKey: subscription.planKey },
      });
      for (const limit of limits) {
        mapa.set(limit.metric, { value: Number(limit.value), source: 'plan' });
      }
    } else {
      /**
       * Sem assinatura ativa (`past_due`, `canceled`, ou provisionamento que
       * falhou), mapa vazio significava "sem limite" — o controle de plano
       * deixava de existir exatamente no inadimplente (ADR-041). O piso abaixo
       * fecha isso; aqui só o alerta, porque a causa é comercial.
       *
       * O recorte é deliberado: métrica interna (contatos, armazenamento)
       * continua sem teto neste caso, porque barrá-la puniria quem não pode
       * resolver a questão comercial; métrica que gasta dinheiro de terceiro, não.
       */
      this.alertMissingSubscription(workspaceId);
    }
    return this.enforceFloors(mapa, subscription?.planKey ?? null);
  }

  /**
   * PISO das métricas que nunca podem ficar sem teto (ADR-041), aplicado nos
   * DOIS ramos — com e sem assinatura ativa.
   *
   * Restringir isto ao ramo "sem assinatura" protegia só o caso excepcional e
   * deixava o comum aberto: bastava um plano novo (um `enterprise`, um plano de
   * piloto) sem a linha da métrica para aquele cliente gastar sem teto na NOSSA
   * conta do provedor — e sem alerta, porque o alerta vivia só no outro ramo.
   *
   * Para essas métricas, a ausência da linha é sempre lacuna de configuração,
   * nunca "ilimitado por escolha": ilimitado não é uma opção.
   */
  private async enforceFloors(
    mapa: Map<string, ResolvedLimit>,
    /** plano ASSINADO, ou null quando não há assinatura ativa */
    planoAssinado: string | null,
  ): Promise<Map<string, ResolvedLimit>> {
    const faltando = Object.values(USAGE_METRICS).filter(
      (definition) => definition.neverUnlimited && !mapa.has(definition.key),
    );
    if (faltando.length === 0) return mapa;

    /**
     * `raw` justificado: `Plan`/`PlanLimit` são catálogo GLOBAL (ADR-034), fora
     * do client filtrado por definição. `isDefault` é marca TRUE/NULL com unique,
     * então "o plano padrão" é único por garantia do banco.
     */
    const plano = await this.prisma.raw.plan.findFirst({ where: { isDefault: true } });
    const padrao = plano
      ? await this.prisma.raw.planLimit.findMany({ where: { planKey: plano.key } })
      : [];
    for (const definition of faltando) {
      const linha = padrao.find((limit) => limit.metric === definition.key);
      if (linha) {
        mapa.set(definition.key, { value: Number(linha.value), source: 'default_plan' });
        const aviso = catalogGapAlert(
          planoAssinado,
          definition.key,
          Number(linha.value),
          plano?.key ?? '—',
        );
        if (aviso) this.alertOnce(`catalogo:${planoAssinado}:${definition.key}`, aviso);
        continue;
      }
      /**
       * O catálogo não resolveu. Cai no piso do CÓDIGO — nunca em "sem limite" —
       * e o alerta é OUTRO: isto é incidente de configuração, não condição
       * comercial, e confundir os dois manda o operador procurar no lugar errado.
       */
      mapa.set(definition.key, { value: definition.safetyFloor ?? 0, source: 'code_floor' });
      this.alertOnce(
        `piso:${definition.key}`,
        `Catálogo de planos sem limite para "${definition.key}"` +
          `${plano ? ` no plano padrão "${plano.key}"` : ' (nenhum plano padrão)'}: ` +
          `piso de segurança ${definition.safetyFloor ?? 0} aplicado. Corrigir o catálogo.`,
      );
    }
    return mapa;
  }

  /**
   * ALERTA OPERACIONAL: workspace sem assinatura ativa é falha de
   * provisionamento ou condição comercial a tratar, não estado normal.
   */
  private alertMissingSubscription(workspaceId: string): void {
    this.alertOnce(
      `sem-assinatura:${workspaceId}`,
      `Workspace ${workspaceId} sem assinatura ATIVA: métricas de custo de terceiro ` +
        `(${NEVER_UNLIMITED.join(', ')}) herdam teto do catálogo de planos — nunca ` +
        `ilimitado. Verificar provisionamento ou situação comercial.`,
    );
  }

  /**
   * Alerta ESTRANGULADO por chave: o caminho é quente (um envio chama `limitsFor`
   * mais de uma vez), e alertar a cada passagem esconderia o próprio alerta —
   * catálogo quebrado geraria dezenas de linhas por mensagem. Primeira ocorrência
   * sai na hora; as repetições esperam a janela.
   *
   * É POR INSTÂNCIA: com N réplicas são N alertas por janela, aceitável para um
   * alerta e não vale estado compartilhado.
   */
  private alertOnce(chave: string, mensagem: string): void {
    const ultimo = this.alertsSent.get(chave) ?? 0;
    if (Date.now() - ultimo < ALERT_THROTTLE_MS) return;
    this.alertsSent.set(chave, Date.now());
    // poda: sem isto o mapa só cresce, uma entrada por chave, para sempre
    if (this.alertsSent.size > 500) {
      const corte = Date.now() - 2 * ALERT_THROTTLE_MS;
      for (const [k, quando] of this.alertsSent) {
        if (quando < corte) this.alertsSent.delete(k);
      }
    }
    this.logger.error(mensagem);
  }

  /** Liquidação: soma o custo REAL, sem barrar — o gasto já aconteceu. */
  private async consumeWithoutLimit(tx: AnyClient, metric: string, delta: number): Promise<void> {
    await this.applyDelta(tx, metric, periodKeyFor(USAGE_METRICS[metric].kind), delta);
  }
}

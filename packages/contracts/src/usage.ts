export interface UsageMetricDto {
  metric: string;
  label: string;
  kind: 'counter' | 'gauge';
  /** `usd_cents` deixa explícito que dinheiro aqui é CENTAVO DE DÓLAR (ADR-034) */
  unit: 'count' | 'bytes' | 'usd_cents';
  /**
   * `null` = valor MONETÁRIO omitido porque quem pede não tem `billing:manage`.
   * Dólar é dado comercial: quem trabalha no CRM precisa saber que existe teto e
   * se está perto dele, não quanto a conta gastou (ADR-041).
   */
  used: number | null;
  /** null = métrica sem limite no plano vigente, ou valor monetário omitido */
  limit: number | null;
  /**
   * Uso sobre o teto, de 0 a 1 — não monetário, então acompanha a métrica mesmo
   * quando os valores são omitidos. É o que permite dizer "próximo do limite"
   * sem revelar centavos. `null` quando não há teto.
   */
  usedRatio: number | null;
  /** true = há teto e valores, mas eles foram omitidos por falta de permissão */
  monetaryRedacted?: boolean;
  /**
   * DE ONDE veio o teto. Sem isto, um cliente limitado por lacuna de catálogo vê
   * só um 402 inexplicável — o "mistério de suporte" que o ADR-041 quer evitar.
   * `plan` = do plano vigente; `default_plan` = herdado do plano padrão;
   * `code_floor` = piso do código, porque o catálogo não resolveu; `null` = sem
   * teto (métrica interna sem assinatura ativa).
   */
  limitSource: 'plan' | 'default_plan' | 'code_floor' | null;
  /** false = declarada no catálogo, ainda não cobrada */
  enforced: boolean;
  /** virada do período (counters); null para gauges */
  resetsAt: string | null;
}

export interface PlanDto {
  key: string;
  name: string;
  /** centavos de DÓLAR */
  priceCents: number;
}

export interface SubscriptionDto {
  plan: PlanDto;
  status: 'active' | 'past_due' | 'canceled';
  currentPeriodEnd: string;
}

/**
 * Plano EFETIVAMENTE aplicado, que pode não ser o contratado: assinatura
 * cancelada mantém o registro de `Pro` e passa a valer o teto do plano padrão
 * (ADR-041). Mostrar o contratado nesse caso é mentir para quem está tentando
 * entender por que esbarrou no limite.
 */
export interface AppliedPlanDto {
  key: string;
  name: string;
  source: 'subscription' | 'default_plan' | 'none';
}

export interface UsageOverviewDto {
  /**
   * O que está CONTRATADO — pode estar cancelado ou vencido. `null` também
   * quando quem pede NÃO tem `billing:manage`: situação comercial (status,
   * preço, fim do período) é informação de negócio, e o medidor é de trabalho.
   * O servidor não envia, em vez de a tela esconder (revisão da 9.1.c).
   */
  subscription: SubscriptionDto | null;
  /** o que está VALENDO agora */
  appliedPlan: AppliedPlanDto;
  metrics: UsageMetricDto[];
}

/** Corpo do 402 quando uma quota é atingida (ADR-033). */
export interface QuotaExceededDto {
  code: 'quota_exceeded';
  message: string;
  metric: string;
  /** null = métrica monetária: teto e gasto não saem no corpo do erro (ADR-041) */
  limit: number | null;
  current: number | null;
  resetsAt: string | null;
}

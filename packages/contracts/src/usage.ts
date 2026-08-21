export interface UsageMetricDto {
  metric: string;
  label: string;
  kind: 'counter' | 'gauge';
  /** `usd_cents` deixa explícito que dinheiro aqui é CENTAVO DE DÓLAR (ADR-034) */
  unit: 'count' | 'bytes' | 'usd_cents';
  used: number;
  /** null = métrica sem limite no plano vigente */
  limit: number | null;
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
  /** o que está CONTRATADO — pode estar cancelado ou vencido */
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
  limit: number;
  current: number;
  resetsAt: string | null;
}

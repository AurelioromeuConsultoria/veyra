export interface UsageMetricDto {
  metric: string;
  label: string;
  kind: 'counter' | 'gauge';
  /** `usd_cents` deixa explícito que dinheiro aqui é CENTAVO DE DÓLAR (ADR-034) */
  unit: 'count' | 'bytes' | 'usd_cents';
  used: number;
  /** null = métrica sem limite no plano vigente */
  limit: number | null;
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

export interface UsageOverviewDto {
  subscription: SubscriptionDto | null;
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

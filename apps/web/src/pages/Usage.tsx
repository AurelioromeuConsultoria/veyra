import { useQuery } from '@tanstack/react-query';
import type { UsageMetricDto, UsageOverviewDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { Gauge } from 'lucide-react';
import { api } from '../lib/api';

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });

/** Cada unidade tem sua leitura: bytes em MiB/GiB, dinheiro em dólar. */
function formatValue(value: number, unit: UsageMetricDto['unit']): string {
  if (unit === 'usd_cents') return `US$ ${(value / 100).toFixed(2)}`;
  if (unit === 'bytes') {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    if (value >= 1024) return `${(value / 1024).toFixed(0)} KiB`;
    return `${value} B`;
  }
  return new Intl.NumberFormat('pt-BR').format(value);
}

export function UsagePage() {
  const overview = useQuery({
    queryKey: ['usage'],
    queryFn: () => api.get<UsageOverviewDto>('/api/usage'),
  });

  const metrics = overview.data?.metrics ?? [];
  const subscription = overview.data?.subscription;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <Gauge size={15} className="text-muted-fg" />
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">Uso e plano</h1>
          <p className="text-xs text-muted-fg">
            {subscription
              ? `Plano ${subscription.plan.name} · renova em ${dateFormat.format(new Date(subscription.currentPeriodEnd))}`
              : 'Sem assinatura ativa'}
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-5">
        <ul className="max-w-2xl space-y-3">
          {metrics.map((metric) => {
            const ratio = metric.limit ? Math.min(1, metric.used / metric.limit) : 0;
            const near = ratio >= 0.8;
            return (
              <li key={metric.metric} className="rounded-md border border-border p-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{metric.label}</span>
                  {!metric.enforced ? (
                    <span className="rounded border border-border px-1 text-[10px] uppercase tracking-wider text-muted-fg">
                      não cobrada
                    </span>
                  ) : null}
                  <span className="ml-auto font-mono text-xs tabular-nums">
                    <span data-testid={`usage-${metric.metric}-used`}>
                      {formatValue(metric.used, metric.unit)}
                    </span>
                    {metric.limit !== null ? (
                      <span className="text-muted-fg">
                        {' '}
                        / {formatValue(metric.limit, metric.unit)}
                      </span>
                    ) : null}
                  </span>
                </div>
                {metric.limit !== null ? (
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={clsx('h-full', near ? 'bg-warning' : 'bg-accent')}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                ) : null}
                <p className="mt-1.5 text-[11px] text-muted-fg">
                  {metric.kind === 'gauge'
                    ? 'Nível atual — cai ao arquivar ou excluir'
                    : metric.resetsAt
                      ? `Acumulado do período — zera em ${dateFormat.format(new Date(metric.resetsAt))}`
                      : 'Acumulado do período'}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

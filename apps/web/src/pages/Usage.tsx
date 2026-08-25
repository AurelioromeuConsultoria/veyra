import { useQuery } from '@tanstack/react-query';
import type { UsageMetricDto, UsageOverviewDto } from '@veyra/contracts';
import { clsx } from 'clsx';
import { PageBody, PageHeader, Panel, PanelHeader } from '../components/ui/page';
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
  const applied = overview.data?.appliedPlan;
  /**
   * O plano APLICADO pode não ser o contratado: assinatura cancelada mantém o
   * registro de `Pro` e passa a valer o teto do padrão (ADR-041). Mostrar o
   * contratado nesse caso mente para quem está tentando entender o limite.
   */
  const herdado = applied?.source === 'default_plan';
  /**
   * A anomalia COMERCIAL aparece porque o SERVIDOR mandou a assinatura — ele só
   * a envia a quem tem `billing:manage`. A tela não decide isso: esconder
   * visualmente deixava a API entregando status, preço e período a qualquer
   * portador do medidor.
   */

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Configuração"
        title="Uso e plano"
        meta={
          <>
            <p data-testid="usage-applied-plan">
              {overview.isPending
                ? 'Carregando plano…'
                : overview.isError
                  ? 'Não foi possível ler o plano vigente'
                  : herdado
                    ? /* `subscription` nula é ambígua: pode não existir OU quem
                         olha não tem direito de ver. Só afirmamos o motivo
                         comercial para quem recebeu a assinatura — os demais leem
                         a procedência do TETO, que é o que lhes diz respeito */
                      subscription
                      ? `Plano ${applied?.name} aplicado por ausência de assinatura ativa`
                      : `Plano ${applied?.name} aplicado — teto do plano padrão`
                    : applied?.source === 'subscription'
                      ? /* o nome vem do plano APLICADO; a data de renovação só
                           existe para quem gere billing, porque o servidor não
                           manda a assinatura para os demais */
                        `Plano ${applied.name}${
                          subscription
                            ? ` · renova em ${dateFormat.format(new Date(subscription.currentPeriodEnd))}`
                            : ''
                        }`
                      : /* só afirmamos incidente com resposta na mão: enquanto
                           carregava, esta frase piscava em toda visita */
                        'Nenhum plano padrão configurado — limites no piso de segurança'}
            </p>
            {herdado && subscription ? (
              <p className="mt-0.5 text-data-sm text-warning">
                Assinatura registrada: {subscription.plan.name} ({subscription.status}). Verificar
                provisionamento ou situação comercial.
              </p>
            ) : null}
          </>
        }
      />

      <PageBody>
        <Panel className="max-w-3xl">
          <PanelHeader title="Consumo do período" />
          <ul>
            {metrics.map((metric) => {
              // a razão vem do servidor: com valor monetário omitido, é a única
              // fonte da barra — e ela não revela centavos
              const ratio = metric.usedRatio ?? 0;
              const near = ratio >= 0.8;
              return (
                <li
                  key={metric.metric}
                  className="border-b border-border/70 px-4 py-3 last:border-b-0"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-body-sm font-medium">{metric.label}</span>
                    {!metric.enforced ? (
                      <span className="eyebrow rounded-sm border border-border px-1 py-px text-muted-fg">
                        não cobrada
                      </span>
                    ) : null}
                    <span className="num ml-auto text-data text-foreground">
                      {metric.used === null ? (
                        /* valor monetário omitido pelo servidor: mostramos
                           DISPONIBILIDADE, não dinheiro — quem trabalha precisa
                           saber que está perto do teto, não quanto a conta gastou */
                        <span data-testid={`usage-${metric.metric}-used`} className="text-muted-fg">
                          {metric.usedRatio === null
                            ? 'sem teto definido'
                            : `${Math.round(metric.usedRatio * 100)}% do limite`}
                        </span>
                      ) : (
                        <>
                          <span data-testid={`usage-${metric.metric}-used`}>
                            {formatValue(metric.used, metric.unit)}
                          </span>
                          {metric.limit !== null ? (
                            <span className="text-muted-fg">
                              {' '}
                              / {formatValue(metric.limit, metric.unit)}
                            </span>
                          ) : null}
                        </>
                      )}
                    </span>
                  </div>
                  {metric.usedRatio !== null ? (
                    <div className="mt-2.5 h-0.5 w-full overflow-hidden rounded-full bg-border">
                      <div
                        className={clsx(
                          'h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out)]',
                          near ? 'bg-warning' : 'bg-accent',
                        )}
                        /* 0% ainda mostra um traço: "vazio" e "sem dado" não
                           podem ter a mesma aparência */
                        style={{ width: `${Math.max(Math.min(ratio, 1) * 100, 1)}%` }}
                      />
                    </div>
                  ) : null}
                  {metric.limitSource === 'default_plan' || metric.limitSource === 'code_floor' ? (
                    /* de onde veio o teto: sem isto, cliente limitado por lacuna
                       de catálogo vê só um 402 inexplicável */
                    <p className="mt-2 text-data-sm text-warning">
                      {metric.limitSource === 'default_plan'
                        ? 'Teto herdado do plano padrão — o plano vigente não define esta métrica'
                        : 'Teto no piso de segurança — o catálogo de planos não define esta métrica'}
                    </p>
                  ) : null}
                  {metric.monetaryRedacted && near ? (
                    <p className="mt-1 text-data-sm text-warning">
                      Uso de IA próximo do limite — peça a quem gere o plano para ver o valor
                    </p>
                  ) : null}
                  <p className="mt-1.5 text-data-sm text-muted-fg">
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
        </Panel>
      </PageBody>
    </div>
  );
}

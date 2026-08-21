/**
 * Catálogo de métricas (ADR-032). A NATUREZA é declarada aqui e decide como o
 * limite é lido: `counter` acumula no período e zera na virada; `gauge` é nível
 * atual, sobe ao criar e desce ao arquivar/excluir.
 */
export type MetricKind = 'counter' | 'gauge';

export interface MetricDefinition {
  key: string;
  kind: MetricKind;
  label: string;
  /** unidade para exibição — evita "5000" sem contexto na tela */
  unit: 'count' | 'bytes' | 'usd_cents';
  /**
   * Métrica declarada mas AINDA sem enforcement. `messages_sent` fica aqui
   * porque não existe envio externo: cobrar por mensagem enquanto o canal é
   * interno e manual seria cobrar por digitar (decisão da revisão da 8).
   */
  enforced: boolean;
}

export const USAGE_METRICS: Record<string, MetricDefinition> = {
  contacts: {
    key: 'contacts',
    kind: 'gauge',
    label: 'Contatos ativos',
    unit: 'count',
    enforced: true,
  },
  storage_bytes: {
    key: 'storage_bytes',
    kind: 'gauge',
    label: 'Armazenamento',
    unit: 'bytes',
    enforced: true,
  },
  ai_runs: {
    key: 'ai_runs',
    kind: 'counter',
    label: 'Execuções de IA',
    unit: 'count',
    enforced: true,
  },
  ai_cost_cents: {
    key: 'ai_cost_cents',
    kind: 'counter',
    label: 'Custo de IA',
    unit: 'usd_cents',
    enforced: true,
  },
  messages_sent: {
    key: 'messages_sent',
    kind: 'counter',
    label: 'Mensagens enviadas',
    unit: 'count',
    // COBRADA a partir da 9.1.b: existe envio externo de verdade, com custo do
    // outro lado. Reservada antes da chamada e liquidada pelo resultado.
    enforced: true,
  },
};

export type MetricKey = keyof typeof USAGE_METRICS;

/** Chave do período: mês corrente para counters, vazia para gauges. */
export function periodKeyFor(kind: MetricKind, at = new Date()): string {
  if (kind === 'gauge') return '';
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Virada do período — o `resetsAt` que o erro 402 devolve. */
export function periodEnd(at = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

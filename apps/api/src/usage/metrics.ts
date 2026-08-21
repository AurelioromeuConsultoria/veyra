/**
 * Catálogo de métricas (ADR-032). A NATUREZA é declarada aqui e decide como o
 * limite é lido: `counter` acumula no período e zera na virada; `gauge` é nível
 * atual, sobe ao criar e desce ao arquivar/excluir.
 */
export type MetricKind = 'counter' | 'gauge';

/**
 * Métrica cujo consumo gasta dinheiro de TERCEIRO: o par
 * `neverUnlimited`+`safetyFloor` é inseparável no tipo, para o compilador
 * impedir o descuido de marcar "nunca ilimitado" sem piso — que resultaria em
 * teto zero, bloqueando tudo, a alternativa que o ADR-041 descarta.
 */
type ExternalCostGuard =
  | { neverUnlimited?: undefined; safetyFloor?: undefined }
  | { neverUnlimited: true; safetyFloor: number };

export interface MetricDefinition {
  key: string;
  kind: MetricKind;
  label: string;
  /** unidade para exibição — evita "5000" sem contexto na tela */
  unit: 'count' | 'bytes' | 'usd_cents';
  /**
   * Métrica declarada mas AINDA sem enforcement. Hoje todas são cobradas:
   * `messages_sent` deixou de ser exceção na 9.1.b, quando passou a existir
   * envio externo de verdade — antes, cobrar por mensagem em canal interno e
   * manual seria cobrar por digitar.
   */
  enforced: boolean;
}

/**
 * `neverUnlimited`: métrica que NUNCA fica sem teto, porque gasta dinheiro de
 * terceiro. Sem assinatura ativa — ou com plano sem a linha — o limite é herdado
 * do plano padrão em vez de virar ilimitado (ADR-041). Métrica interna segue sem
 * teto nesse caso, porque o dano de barrar é maior que o de contar depois.
 *
 * `safetyFloor`: piso usado SÓ quando o catálogo não resolve (sem plano padrão,
 * ou plano padrão sem a linha). Existe para que "nunca ilimitado" não dependa de
 * dado que pode faltar; conservador de propósito, e o alerta diz que ele entrou.
 */
export type MetricDefinitionWithGuard = MetricDefinition & ExternalCostGuard;

export const USAGE_METRICS: Record<string, MetricDefinitionWithGuard> = {
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
    // cada execução chama a Anthropic: dinheiro de terceiro, logo nunca sem teto
    neverUnlimited: true,
    safetyFloor: 50,
  },
  ai_cost_cents: {
    key: 'ai_cost_cents',
    kind: 'counter',
    label: 'Custo de IA',
    unit: 'usd_cents',
    enforced: true,
    /**
     * A métrica é denominada em centavos DE GASTO REAL: deixá-la sem teto quando
     * a assinatura não está ativa seria o furo que o ADR-041 fecha, na única
     * métrica cuja unidade é literalmente dinheiro.
     */
    neverUnlimited: true,
    safetyFloor: 100,
  },
  messages_sent: {
    key: 'messages_sent',
    kind: 'counter',
    label: 'Mensagens enviadas',
    unit: 'count',
    // COBRADA a partir da 9.1.b: existe envio externo de verdade, com custo do
    // outro lado. Reservada antes da chamada e liquidada pelo resultado.
    enforced: true,
    // e nunca ilimitada: cada mensagem custa dinheiro no provedor (ADR-041)
    neverUnlimited: true,
    safetyFloor: 50,
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

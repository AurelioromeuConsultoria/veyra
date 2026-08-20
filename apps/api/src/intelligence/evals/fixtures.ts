/**
 * Fixtures de eval: saídas GRAVADAS do modelo, boas e ruins. Rodam no CI sem
 * tocar o provedor — a suíte comum nunca chama LLM real (ADR-029). A suíte
 * contra o provedor de verdade fica para quando `promptVersion` subir.
 */
export interface EvalCase {
  name: string;
  /** texto cru como o modelo devolveria */
  output: string;
  /** deve passar na validação estrutural da capacidade? */
  valid: boolean;
  /** o que precisa ser verdade quando válido */
  expect?: Record<string, unknown>;
}

export const SUMMARY_CASES: EvalCase[] = [
  {
    name: 'resumo bem formado',
    output: JSON.stringify({
      subject: 'Renovação de contrato',
      summary: 'Cliente quer renovar com desconto. Aguarda proposta.',
      pendencies: ['Enviar proposta revisada'],
      sentiment: 'neutro',
      injectionAttempt: false,
    }),
    valid: true,
    expect: { pendencyCount: 1, sentiment: 'neutro' },
  },
  {
    name: 'resumo embrulhado em cerca de código',
    output:
      '```json\n' +
      JSON.stringify({
        subject: 'Suporte',
        summary: 'Problema resolvido.',
        pendencies: [],
        sentiment: 'positivo',
        injectionAttempt: false,
      }) +
      '\n```',
    valid: true,
    expect: { pendencyCount: 0, sentiment: 'positivo' },
  },
  {
    name: 'tentativa de injection sinalizada pelo modelo',
    output: JSON.stringify({
      subject: 'Pedido suspeito',
      summary: 'O contato tentou dar instruções ao assistente.',
      pendencies: [],
      sentiment: 'negativo',
      injectionAttempt: true,
    }),
    valid: true,
    expect: { injectionAttempt: true },
  },
  {
    name: 'sentimento fora do catálogo',
    output: JSON.stringify({
      subject: 'x',
      summary: 'y',
      pendencies: [],
      sentiment: 'ótimo',
      injectionAttempt: false,
    }),
    valid: false,
  },
  {
    name: 'campo extra inventado pelo modelo',
    output: JSON.stringify({
      subject: 'x',
      summary: 'y',
      pendencies: [],
      sentiment: 'neutro',
      injectionAttempt: false,
      acao: 'criar_tarefa',
    }),
    valid: false,
  },
  { name: 'texto livre em vez de JSON', output: 'Claro! Aqui vai o resumo…', valid: false },
];

export const NEXT_ACTION_CASES: EvalCase[] = [
  {
    name: 'ação bem formada',
    output: JSON.stringify({
      title: 'Ligar para confirmar a renovação',
      rationale: 'Oportunidade aberta e conversa recente.',
      dueInDays: 2,
    }),
    valid: true,
    expect: { dueInDays: 2 },
  },
  {
    name: 'prazo fora da faixa',
    output: JSON.stringify({ title: 'Ligar', rationale: 'motivo', dueInDays: 900 }),
    valid: false,
  },
  {
    name: 'título vazio',
    output: JSON.stringify({ title: '', rationale: 'motivo', dueInDays: 1 }),
    valid: false,
  },
  {
    name: 'modelo tentando executar em vez de propor',
    output: JSON.stringify({ execute: true, action: 'create_task', title: 'Ligar' }),
    valid: false,
  },
];

/** Cenários de score: sinais → faixa esperada, sem LLM nenhum. */
export const SCORE_SCENARIOS = [
  {
    name: 'lead quente: conversa recente e oportunidade relevante',
    signals: {
      daysSinceLastActivity: 2,
      openDealsValueCents: 50_000_00,
      wonDealsCount: 1,
      messagesLast30Days: 12,
      hasEmail: true,
      hasPhone: true,
    },
    min: 80,
    max: 100,
    mustHaveFactors: ['recency', 'engagement', 'pipeline', 'history'],
  },
  {
    name: 'lead morno: atividade no mês, sem oportunidade',
    signals: {
      daysSinceLastActivity: 20,
      openDealsValueCents: 0,
      wonDealsCount: 0,
      messagesLast30Days: 4,
      hasEmail: true,
      hasPhone: false,
    },
    min: 25,
    max: 45,
    mustHaveFactors: ['recency', 'engagement'],
  },
  {
    name: 'lead frio: nada há meses',
    signals: {
      daysSinceLastActivity: 300,
      openDealsValueCents: 0,
      wonDealsCount: 0,
      messagesLast30Days: 0,
      hasEmail: false,
      hasPhone: false,
    },
    min: 0,
    max: 5,
    mustHaveFactors: ['recency'],
  },
] as const;

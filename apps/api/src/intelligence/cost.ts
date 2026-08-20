/**
 * Preço por milhão de tokens, em CENTAVOS de dólar (dinheiro é Int, §3.11).
 * Tabela versionada em código e revisável; como o `AiRun` guarda `model` e as
 * contagens CRUAS, um erro aqui é recalculável — se guardássemos só o valor
 * derivado, viraria histórico irrecuperável.
 */
interface ModelPrice {
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-5': { inputCentsPerMillion: 300, outputCentsPerMillion: 1500 },
  'claude-haiku-4-5-20251001': { inputCentsPerMillion: 100, outputCentsPerMillion: 500 },
  'claude-opus-5': { inputCentsPerMillion: 1500, outputCentsPerMillion: 7500 },
};

/** Modelo desconhecido custa 0 e é sinalizado — nunca inventa preço. */
export function estimateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[model];
  if (!price) return 0;
  const cents =
    (inputTokens * price.inputCentsPerMillion + outputTokens * price.outputCentsPerMillion) /
    1_000_000;
  // arredonda para cima: nunca subestimar custo em quota
  return Math.ceil(cents);
}

export function isPricedModel(model: string): boolean {
  return model in PRICES;
}

/**
 * TETO do custo de um run, para a RESERVA anterior à chamada (ADR-033). A
 * entrada ainda não foi tokenizada, então usa-se uma estimativa grosseira por
 * caracteres; a saída usa o `maxOutputTokens` pedido, que é um teto de verdade.
 * Depois da resposta, a liquidação corrige pelo custo real.
 */
export function estimateMaxCostCents(
  model: string,
  promptChars: number,
  maxOutputTokens: number,
): number {
  // ~4 caracteres por token é a regra de bolso; arredondar para cima nunca
  // subestima a reserva
  const estimatedInputTokens = Math.ceil(promptChars / 3);
  return Math.max(1, estimateCostCents(model, estimatedInputTokens, maxOutputTokens));
}

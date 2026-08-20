/**
 * Porta do provedor (ADR-029). Produção usa `@anthropic-ai/sdk`; os testes
 * injetam um cliente falso — a suíte NUNCA fala com provedor real.
 *
 * A v1 não tem loop agêntico nem ferramenta: é uma chamada estruturada, com o
 * conteúdo não confiável marcado como tal e a saída validada por Zod.
 */
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export interface LlmRequest {
  /** instrução do sistema — nossa, versionada */
  system: string;
  /** contexto confiável montado pelo servidor */
  context: string;
  /** conteúdo NÃO CONFIÁVEL (escrito por terceiros), delimitado e rotulado */
  untrusted?: string;
  maxOutputTokens: number;
}

export interface LlmResponse {
  /** texto cru da resposta; o chamador valida com Zod antes de usar */
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * O resultado distingue três situações que têm consequências DIFERENTES para a
 * quota de custo:
 *
 * - `ok`: houve resposta e o custo real é conhecido.
 * - `no_provider`: **nenhuma chamada saiu** (sem API key). Nada foi gasto, então
 *   a reserva é liberada por inteiro.
 * - `unknown_after_dispatch`: a requisição já havia sido despachada quando algo
 *   falhou (timeout, conexão caída, erro do provedor). Pode ter havido consumo
 *   de tokens do lado de lá, e devolver o orçamento como se nada tivesse
 *   acontecido é devolver dinheiro já gasto — a reserva é liquidada pelo TETO.
 */
export type LlmOutcome =
  ({ kind: 'ok' } & LlmResponse) | { kind: 'no_provider' } | { kind: 'unknown_after_dispatch' };

export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmOutcome>;
}

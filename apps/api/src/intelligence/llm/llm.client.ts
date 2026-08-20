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

export interface LlmClient {
  readonly model: string;
  /** `null` = provedor indisponível/sem chave: o chamador degrada com clareza */
  complete(request: LlmRequest): Promise<LlmResponse | null>;
}

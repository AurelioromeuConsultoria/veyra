/**
 * CLASSIFICAÇÃO de falha de envio, isolada de propósito (ADR-039): é a parte que
 * só se valida de verdade contra a API real, então corrigi-la depois deve ser
 * mudar esta tabela — não caçar `if`s espalhados.
 *
 * - `retryable`: comprovadamente ANTES do envio e transitória. Libera a quota e
 *   o outbox tenta de novo; a nova tentativa reserva quota outra vez.
 * - `permanent`: antes do envio e definitiva. Libera a quota, marca falha e
 *   ENCERRA — retentar seria repetir o mesmo erro seis vezes.
 * - `ambiguous`: pode ter sido despachada. Liquida a quota, NÃO reenvia e fica
 *   para resolução humana.
 */
export type FailureClass = 'retryable' | 'permanent' | 'ambiguous';

export interface TransportFailure {
  /** status HTTP, quando houve resposta */
  status?: number;
  /** código de erro da Meta, quando veio no corpo */
  metaCode?: number;
  /** true quando a requisição caiu sem resposta (timeout, socket) */
  networkFailure?: boolean;
}

/**
 * Códigos da Meta que são TRANSITÓRIOS apesar de vierem com HTTP 400: limites de
 * taxa. Consultados ANTES do catch-all de 4xx — descartar mensagem que uma
 * retentativa entregaria seria perda evitável.
 */
const RETRYABLE_META_CODES = new Set([
  130_429, // rate limit da conta
  131_048, // limite de spam
  131_056, // limite por par (remetente/destinatário)
  133_016, // reautenticação temporária em andamento
]);

/** Códigos da Meta que sabemos serem definitivos (configuração/credencial). */
const PERMANENT_META_CODES = new Set([
  131_026, // mensagem não entregável ao destinatário
  132_000, // template: número de parâmetros não casa
  132_001, // template inexistente ou não aprovado
  132_005, // template pausado/reprovado
  190, // token inválido/expirado
]);

export function classifyFailure(failure: TransportFailure): FailureClass {
  // sem resposta: não há como saber se chegou. Conservador por decisão.
  if (failure.networkFailure) return 'ambiguous';
  const status = failure.status ?? 0;

  /**
   * 2xx que chegou aqui significa "a Meta ACEITOU mas não devolveu o id da
   * mensagem". Isso é ambíguo, não retentável: reenviar duplicaria uma
   * mensagem provavelmente entregue. Antes desta linha, o catch-all devolvia
   * `retryable` — o pior desfecho possível.
   */
  if (status >= 200 && status < 400) return 'ambiguous';
  // timeout do lado do servidor: mais próximo de incerto que de definitivo
  if (status === 408) return 'ambiguous';

  // 5xx pode ter processado antes de falhar: tratado como incerto, mesmo sabendo
  // que muitas vezes não processou — duplicar mensagem para um paciente é pior
  if (status >= 500) return 'ambiguous';

  if (status === 429) return 'retryable'; // rate limit: espera e tenta de novo
  // limites de taxa que a Meta manda com 400: transitórios, apesar do status
  if (failure.metaCode && RETRYABLE_META_CODES.has(failure.metaCode)) return 'retryable';
  if (status === 401 || status === 403) return 'permanent'; // credencial/permissão
  if (failure.metaCode && PERMANENT_META_CODES.has(failure.metaCode)) return 'permanent';
  if (status >= 400) return 'permanent'; // validação: retentar repete o erro
  /**
   * Desconhecido = AMBÍGUO, nunca retentável: um código que não sabemos
   * classificar pode ter deixado a mensagem sair. Repetir arriscaria mandar
   * duas vezes para o paciente; encerrar como incerto pede olho humano.
   */
  return 'ambiguous';
}

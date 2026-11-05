/**
 * Os sujeitos da E6 sem repetição, na ordem: o contato atual da conversa
 * costuma ser também o do recebimento das mensagens (ADR-061, adendo 9), e a
 * porta recebe cada um uma vez — o mesmo conjunto de antes da soma, quando não
 * há outro. Num módulo próprio para o serviço e as guardas de repetição usarem
 * sem ciclo de importação.
 */
export function semRepetidos(ids: readonly (string | null)[]): (string | null)[] {
  return [...new Set(ids)];
}

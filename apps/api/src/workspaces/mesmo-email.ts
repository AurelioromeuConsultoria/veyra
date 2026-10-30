/**
 * O critério ÚNICO de "mesmo e-mail" da gestão de equipe (ADR-054 item 13): a
 * criação do convite, a detecção de membro, o aceite e a revogação pela remoção
 * usam este e só este. É a igualdade sem diferenciar maiúsculas — `Maria@` e
 * `maria@` são o mesmo endereço — e nada além: sem pontos, aliases ou regras de
 * provedor. A normalização definitiva dos dados é entrega própria, antes do
 * piloto.
 *
 * A consulta usa `mode: 'insensitive'` só como PRÉ-filtro: no Postgres ele vira
 * `ILIKE`, que trata `_` e `%` como curinga e pode trazer linhas a mais
 * (`a_b@` casaria `axb@`). A igualdade de fato é decidida aqui, sobre o que
 * voltou.
 */
export function mesmoEmail(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** O pré-filtro da consulta; o resultado SEMPRE passa por `mesmoEmail`. */
export function preFiltroDoEmail(email: string) {
  return { equals: email, mode: 'insensitive' as const };
}

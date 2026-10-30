import { sessionScopeKey, type AuthUserDto } from '@veyra/contracts';

/**
 * De qual sessão é o cache da aba (ADR-050). Escopo = identidade + workspace +
 * experiência (ADR-055 adendo 1):
 * `undefined` = ainda não conhecido (a aba acabou de abrir), `null` = sem
 * sessão. A ÉPOCA sobe a cada troca de sessão: toda requisição anota a sua, e a
 * resposta de outra época nunca chega a quem pediu (ver `lib/api.ts`).
 *
 * A troca em si — um cache novo, a árvore remontada — é do `SessionQueryProvider`,
 * que ouve `trocarSessao`. Este módulo não conhece o TanStack.
 */
type Escopo = string | null | undefined;

let escopo: Escopo = undefined;
let epoca = 0;
const emVoo = new Set<AbortController>();
type Ouvinte = (semente: AuthUserDto | null | undefined) => void;
const ouvintes = new Set<Ouvinte>();

/** A resposta era de uma sessão que já não é a da aba: descartada, sem dado. */
export class SessaoEncerradaError extends Error {
  constructor() {
    super('A sessão mudou; a resposta foi descartada.');
    this.name = 'SessaoEncerradaError';
  }
}

export function escopoDe(user: AuthUserDto): string {
  // a experiência entra no escopo (ADR-055 adendo 1): mudá-la no mesmo workspace
  // é troca de sessão para a tela
  return sessionScopeKey(user.id, user.activeMembership?.membershipId, user.experience?.key);
}

export function epocaAtual(): number {
  return epoca;
}

export function escopoAtual(): Escopo {
  return escopo;
}

/**
 * Troca de sessão: sobe a época, aborta o que está em voo e avisa o provider,
 * que descarta o cache e monta outro. `user` semeia a sessão nova; `undefined`
 * = identidade desconhecida (a aba relê `/auth/me`).
 */
export function trocarSessao(user: AuthUserDto | null | undefined): void {
  escopo = user === undefined ? undefined : user === null ? null : escopoDe(user);
  epoca += 1;
  for (const controle of emVoo) controle.abort();
  emVoo.clear();
  for (const ouvinte of ouvintes) ouvinte(user);
}

/**
 * O que `/auth/me` ou o refresh disseram sobre a sessão. Na primeira vez, só
 * adota; depois, outra identidade, outro workspace ou outra experiência é troca
 * de sessão.
 */
export function adotarSessao(user: AuthUserDto | null): void {
  const novo = user ? escopoDe(user) : null;
  if (escopo === undefined) {
    escopo = novo;
    return;
  }
  if (novo !== escopo) trocarSessao(user);
}

/** O refresh foi recusado (401): a sessão acabou, mesmo sem logout. */
export function sessaoPerdida(): void {
  if (typeof escopo === 'string') trocarSessao(null);
  else escopo = null;
}

/**
 * O escopo que o servidor diz (cabeçalho `x-veyra-scope`) é o da aba? Se não
 * for — login ou troca de workspace em OUTRA aba, que muda o cookie de todas —,
 * a aba recomeça e a resposta não é usada.
 */
export function respostaDaSessao(doServidor: string | null): boolean {
  if (!doServidor || typeof escopo !== 'string' || doServidor === escopo) return true;
  trocarSessao(undefined);
  return false;
}

/** Registra uma requisição em voo; a troca de sessão a aborta. */
export function acompanhar(): { signal: AbortSignal; soltar: () => void } {
  const controle = new AbortController();
  emVoo.add(controle);
  return { signal: controle.signal, soltar: () => emVoo.delete(controle) };
}

export function ouvirTrocaDeSessao(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

/** Só para testes: cada teste começa com a aba recém-aberta. */
export function reiniciarSessaoParaTestes(): void {
  // fora dos testes, desligaria a troca de sessão em silêncio
  const modo = (import.meta as { env?: { MODE?: string } }).env?.MODE;
  if (modo !== 'test') throw new Error('Só para testes.');
  escopo = undefined;
  // a época só cresce: um refresh de um teste anterior nunca casa com a do próximo
  epoca += 1;
  for (const controle of emVoo) controle.abort();
  emVoo.clear();
  ouvintes.clear();
}

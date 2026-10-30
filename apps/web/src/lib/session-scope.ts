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
/**
 * O ESTADO da experiência da sessão (`ready`, `unavailable`...), guardado junto
 * do escopo (ADR-055, adendo 2, item 7): ele muda sem mudar a chave — o Clinics
 * desativado no mesmo workspace —, e o servidor não o põe no escopo. Mudou com
 * o mesmo escopo, é troca de sessão para a tela: cache novo, nada da anterior.
 */
let estado: string | null = null;
let epoca = 0;
const emVoo = new Set<AbortController>();
type Ouvinte = (semente: AuthUserDto | null | undefined) => void;
const ouvintes = new Set<Ouvinte>();

/**
 * A divergência de escopo da última recusa (adendo 2, item 8): a mesma, de novo
 * logo depois de readotar a sessão, é incompatibilidade — o web carregado não
 * fala o protocolo do servidor. A aba para de recomeçar.
 */
let divergencia: { aba: string; servidor: string } | null = null;
let incompativel = false;
const ouvintesDeIncompatibilidade = new Set<() => void>();

/** a releitura do `/auth/me` depois de 403/404: no máximo uma por janela */
const JANELA_DA_RELEITURA_MS = 30_000;
let ultimaReleitura = Number.NEGATIVE_INFINITY;
let releituraAdiada: ReturnType<typeof setTimeout> | null = null;
const ouvintesDeReleitura = new Set<() => void>();

/** A resposta era de uma sessão que já não é a da aba: descartada, sem dado. */
export class SessaoEncerradaError extends Error {
  constructor() {
    super('A sessão mudou; a resposta foi descartada.');
    this.name = 'SessaoEncerradaError';
  }
}

/** Toda requisição de uma aba incompatível falha assim, sem ir à rede. */
export class SessaoIncompativelError extends Error {
  constructor() {
    super('Esta página precisa ser atualizada para continuar.');
    this.name = 'SessaoIncompativelError';
  }
}

function estadoDe(user: AuthUserDto | null | undefined): string | null {
  return user?.experience?.status ?? null;
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
  estado = estadoDe(user);
  // uma sessão CONHECIDA (login, troca, logout) recomeça a contagem; a
  // desconhecida (`undefined`, a recusa por escopo) a guarda
  if (user !== undefined) divergencia = null;
  // a sessão nova chega com o estado atual: a releitura pedida pela anterior
  // não tem mais o que ver (a janela continua valendo)
  cancelarReleituraAdiada();
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
    estado = estadoDe(user);
    return;
  }
  // outro escopo, OU o mesmo com outro estado da experiência (ADR-055, adendo 2)
  if (novo !== escopo || estadoDe(user) !== estado) trocarSessao(user);
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
  if (incompativel) return false;
  if (!doServidor || typeof escopo !== 'string') return true;
  if (doServidor === escopo) {
    divergencia = null;
    return true;
  }
  // a MESMA divergência de novo, depois de a aba ter recomeçado por ela: não há
  // o que recomeçar — o web carregado e o servidor não se entendem. A aba para,
  // sem recarga, sem nova tentativa e sem reenvio de escrita (adendo 2, item 8)
  if (divergencia && divergencia.aba === escopo && divergencia.servidor === doServidor) {
    incompativel = true;
    for (const controle of emVoo) controle.abort();
    emVoo.clear();
    for (const ouvinte of ouvintesDeIncompatibilidade) ouvinte();
    return false;
  }
  divergencia = { aba: escopo, servidor: doServidor };
  trocarSessao(undefined);
  return false;
}

/** A aba parou por incompatibilidade de sessão? */
export function sessaoIncompativel(): boolean {
  return incompativel;
}

export function ouvirIncompatibilidade(ouvinte: () => void): () => void {
  ouvintesDeIncompatibilidade.add(ouvinte);
  return () => ouvintesDeIncompatibilidade.delete(ouvinte);
}

/**
 * Um 403 ou 404 pode ser a experiência que ficou indisponível — ou só falta de
 * permissão, ou recurso inexistente. Por isso a releitura do `/auth/me` é
 * LIMITADA: no máximo uma por janela de 30 s, sem recarga e sem repetir a
 * requisição (adendo 2, item 7). O pedido de dentro da janela não se perde: vira
 * UMA releitura no fim dela — um 403 comum logo antes não esconde a desativação
 * que vem depois. O relógio é o monotônico: o do sistema voltando no tempo não
 * suspende a releitura.
 */
export function pedirReleituraLimitada(agora = performance.now()): void {
  const espera = ultimaReleitura + JANELA_DA_RELEITURA_MS - agora;
  if (espera > 0) {
    releituraAdiada ??= setTimeout(() => {
      releituraAdiada = null;
      reler(performance.now());
    }, espera);
    return;
  }
  reler(agora);
}

function reler(agora: number): void {
  cancelarReleituraAdiada();
  ultimaReleitura = agora;
  for (const ouvinte of ouvintesDeReleitura) ouvinte();
}

function cancelarReleituraAdiada(): void {
  if (releituraAdiada !== null) clearTimeout(releituraAdiada);
  releituraAdiada = null;
}

export function ouvirReleitura(ouvinte: () => void): () => void {
  ouvintesDeReleitura.add(ouvinte);
  return () => ouvintesDeReleitura.delete(ouvinte);
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
  estado = null;
  divergencia = null;
  incompativel = false;
  ultimaReleitura = Number.NEGATIVE_INFINITY;
  cancelarReleituraAdiada();
  ouvintesDeIncompatibilidade.clear();
  ouvintesDeReleitura.clear();
  // a época só cresce: um refresh de um teste anterior nunca casa com a do próximo
  epoca += 1;
  for (const controle of emVoo) controle.abort();
  emVoo.clear();
  ouvintes.clear();
}

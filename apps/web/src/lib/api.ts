import {
  SESSION_EXPECTED_SCOPE_HEADER,
  SESSION_ISSUED_HEADER,
  SESSION_SCOPE_HEADER,
  type AuthUserDto,
} from '@veyra/contracts';
import {
  SessaoEncerradaError,
  SessaoIncompativelError,
  acompanhar,
  adotarSessao,
  epocaAtual,
  escopoAtual,
  pedirReleituraLimitada,
  respostaDaSessao,
  sessaoIncompativel,
  sessaoPerdida,
  trocarSessao,
} from './session-scope';

/**
 * ÚNICO lugar com fetch (ARCHITECTURE §10). Sessão por cookies httpOnly:
 * - credentials: include em tudo;
 * - mutações levam x-csrf-token lido do cookie legível veyra_csrf;
 * - 401 dispara um refresh compartilhado (deduplicado) por sessão e repete a request;
 * - nada de token em localStorage, nunca.
 *
 * Resposta de outra sessão nunca chega a quem pediu (ADR-050): cada request
 * anota a época da sessão; na troca, o que está em voo é abortado, e o que
 * chegar mesmo assim — sucesso, erro ou a repetição depois do refresh — vira
 * `SessaoEncerradaError`. A resposta autenticada traz o escopo dela, e um
 * escopo que não é o da aba (login em OUTRA aba) também é descartado. E a
 * requisição declara o escopo que a aba espera: o servidor recusa (409) a da
 * aba desatualizada ANTES de executar — sem isso, a mutação dela sairia com a
 * identidade do cookie novo.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: { path: string; message: string }[],
    /**
     * O código de máquina, quando o servidor manda. `idempotency_retry`: o 409
     * que pede a MESMA requisição de novo (em processamento) — resultado
     * indefinido, e a tela mantém a chave (ADR-048 adendo 12).
     */
    public readonly code?: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  return /(?:^|; )veyra_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

/**
 * Um refresh apresenta o token de refresh do cookie, e o servidor derruba a
 * família inteira de tokens (logout em todo dispositivo) quando o MESMO token é
 * apresentado duas vezes. Então nunca há dois refreshes ao mesmo tempo:
 * - na aba: o refresh é compartilhado dentro da sessão (época); um refresh de
 *   outra época ainda em voo é ESPERADO antes de outro sair — a troca de
 *   workspace, por exemplo, não rotaciona o token;
 * - entre abas da mesma origem: `navigator.locks` faz um de cada vez (a aba que
 *   volta a ficar visível relê a sessão, e duas janelas podem voltar juntas).
 */
let refreshing: { epoca: number; promessa: Promise<boolean>; terminou: boolean } | null = null;

/**
 * Prazos do refresh, só de ESPERA: a de quem chama (a requisição falha e a
 * sessão fica, como numa falha de rede) e a pela trava entre abas. O pedido de
 * refresh em si NUNCA é abortado: abortar no navegador não cancela a rotação no
 * servidor, o `Set-Cookie` se perderia, e o próximo refresh reapresentaria o
 * token velho — reuso, que derruba a família inteira. Ele segue segurando a
 * trava até terminar, e — quando o navegador oferece a trava (contexto seguro)
 * — nunca se pede o refresh sem ela.
 */
export const PRAZOS_DO_REFRESH = { esperaMs: 15_000, travaMs: 30_000 };

function pedirRefresh(): Promise<Response> {
  const pedir = () =>
    fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-csrf-token': csrfToken() },
    });
  // `navigator.locks` exige contexto seguro: staging e produção são HTTPS (ADR-046),
  // e `localhost` também é seguro. Sem a trava (HTTP fora de localhost, ou navegador
  // sem Web Locks), o refresh sai sem a coordenação entre abas
  const travas = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!travas) return pedir();
  // Safari 15.4–15.6 tem a trava sem `AbortSignal.timeout`: lá a espera pela trava
  // fica sem prazo (a de quem chama continua limitada por `esperaMs`)
  const sinal =
    typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(PRAZOS_DO_REFRESH.travaMs)
      : undefined;
  // o tipo do LockManager não desembrulha a promessa do callback; o runtime sim
  return travas.request('veyra-refresh', sinal ? { signal: sinal } : {}, pedir).then((res) => res);
}

/** O corpo que diz qual é a sessão tem cara de sessão? Se não, a aba relê `/auth/me`. */
function eSessao(dados: unknown): dados is AuthUserDto {
  const d = dados as Partial<AuthUserDto> | null;
  return typeof d?.id === 'string' && Array.isArray(d?.permissions);
}

/** Espera o refresh com prazo; estourou, quem chama segue sem ele (o refresh continua). */
function esperar(promessa: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PRAZOS_DO_REFRESH.esperaMs);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/**
 * 401 do refresh = a sessão acabou (expirou, foi revogada), mesmo sem logout:
 * a aba troca de sessão e vai para o login sem dado. Rede, 429 ou 5xx não
 * derrubam a sessão — só a requisição falha (ressalva: para `/auth/me`, um 401
 * que o refresh não resolveu leva ao login de qualquer forma, e a aba troca —
 * falha fechada, ver `useSession`). Refresh bem-sucedido em OUTRA identidade ou
 * workspace (inclusive sem workspace: membership desativada) também é troca de
 * sessão. Um refresh que voava quando a sessão trocou não tem efeito nenhum.
 */
async function tryRefresh(): Promise<boolean> {
  const epoca = epocaAtual();
  if (refreshing && refreshing.epoca !== epoca) {
    // o de outra época ainda voa: espera ele (sem usar o resultado) e confere.
    // Se ele não terminar no prazo, desiste SEM pedir outro: seria o mesmo token
    const anterior = refreshing;
    await esperar(anterior.promessa.catch(() => false));
    if (epocaAtual() !== epoca || !anterior.terminou) return false;
  }
  if (refreshing?.epoca !== epoca) {
    const atual: NonNullable<typeof refreshing> = {
      epoca,
      terminou: false,
      promessa: pedirRefresh()
        .then(async (res) => {
          if (epocaAtual() !== epoca) return false;
          if (res.ok) {
            const user: unknown = await res.json().catch(() => null);
            if (epocaAtual() === epoca) {
              if (eSessao(user)) adotarSessao(user);
              else trocarSessao(undefined);
            }
            return true;
          }
          if (res.status === 401) sessaoPerdida();
          return false;
        })
        .catch(() => false)
        .finally(() => {
          atual.terminou = true;
          setTimeout(() => {
            if (refreshing === atual) refreshing = null;
          }, 0);
        }),
    };
    refreshing = atual;
  }
  return esperar(refreshing.promessa);
}

/** O escopo que a aba espera, quando conhecido: o servidor recusa outro. */
function escopoEsperado(): Record<string, string> {
  const escopo = escopoAtual();
  return typeof escopo === 'string' ? { [SESSION_EXPECTED_SCOPE_HEADER]: escopo } : {};
}

/**
 * A resposta é da sessão que pediu? Se não, ninguém a recebe. A ÉPOCA vem
 * primeiro: uma resposta atrasada de uma sessão já encerrada traz o escopo
 * antigo, e lê-lo como "o cookie mudou" derrubaria a sessão nova.
 */
function conferirSessao(epoca: number, res?: Response): void {
  if (epocaAtual() !== epoca) throw new SessaoEncerradaError();
  if (res && !respostaDaSessao(res.headers.get(SESSION_SCOPE_HEADER))) {
    throw new SessaoEncerradaError();
  }
}

/** `chave`: o `Idempotency-Key` das rotas que a exigem (o lote do envio do negócio). */
type Corpo = { json: unknown; chave?: string } | { form: FormData } | undefined;

/**
 * O protocolo de sessão, num lugar só para JSON e upload: época, abort, escopo
 * esperado na ida, escopo e época conferidos na volta (antes de ler o corpo,
 * depois do refresh, depois de ler o erro e depois de ler o sucesso).
 */
async function enviar<T>(
  method: string,
  path: string,
  corpo: Corpo,
  epoca = epocaAtual(),
  retried = false,
): Promise<T> {
  // o login não pertence a sessão nenhuma: a resposta dele É a sessão nova
  const isLogin = method === 'POST' && path === '/api/auth/login';
  // a aba parou por incompatibilidade de sessão: nada sai, nem leitura nem
  // escrita, até a pessoa atualizar a página (ADR-055, adendo 2, item 8)
  if (sessaoIncompativel()) throw new SessaoIncompativelError();
  // o logout não é abortado pela troca (a época ainda é conferida): abortado
  // depois de o servidor revogar, o cookie de limpeza se perderia e o próximo
  // refresh apresentaria um token revogado — reuso, que derruba tudo
  const abortavel = !isLogin && !(method === 'POST' && path === '/api/auth/logout');
  const voo = abortavel ? acompanhar() : null;
  const conferir = (res?: Response) => {
    if (!isLogin) conferirSessao(epoca, res);
  };
  try {
    const res = await fetch(path, {
      method,
      credentials: 'include',
      headers: {
        // upload: o browser monta o boundary do multipart, sem Content-Type nosso
        ...(corpo && 'json' in corpo ? { 'Content-Type': 'application/json' } : {}),
        ...(corpo && 'json' in corpo && corpo.chave ? { 'Idempotency-Key': corpo.chave } : {}),
        ...(method !== 'GET' ? { 'x-csrf-token': csrfToken() } : {}),
        ...(isLogin ? {} : escopoEsperado()),
      },
      body:
        corpo === undefined ? undefined : 'json' in corpo ? JSON.stringify(corpo.json) : corpo.form,
      signal: voo?.signal,
    });
    conferir(res);

    if (res.status === 401 && !retried && !isLogin) {
      if (await tryRefresh()) {
        conferir();
        return await enviar<T>(method, path, corpo, epoca, true);
      }
    }
    if (!res.ok) {
      // pode ser a experiência que ficou indisponível: a sessão é relida, com
      // limite — nunca a requisição repetida (ADR-055, adendo 2, item 7)
      if ((res.status === 403 || res.status === 404) && path !== '/api/auth/me') {
        pedirReleituraLimitada();
      }
      const payload = (await res.json().catch(() => null)) as {
        message?: string | string[];
        issues?: { path: string; message: string }[];
        code?: unknown;
      } | null;
      conferir();
      const message = Array.isArray(payload?.message)
        ? payload.message.join('; ')
        : (payload?.message ?? `Erro ${res.status}`);
      // quota estourada (402) traz metric/limit: a mensagem do servidor já é a
      // explicação, e a UI só precisa não engolir o motivo
      throw new ApiError(
        res.status,
        message,
        payload?.issues,
        typeof payload?.code === 'string' ? payload.code : undefined,
      );
    }
    const dados = (await res.json()) as T;
    conferir();
    // resposta que EMITE sessão (login, troca de workspace, aceite de convite):
    // é troca de sessão, aqui, pela marca do servidor — nenhuma tela precisa
    // lembrar disso, e uma rota nova que emita sessão já vem coberta
    if (res.headers.get(SESSION_ISSUED_HEADER)) trocarSessao(eSessao(dados) ? dados : undefined);
    return dados;
  } catch (error) {
    if (voo?.signal.aborted) throw new SessaoEncerradaError();
    throw error;
  } finally {
    voo?.soltar();
  }
}

const json = (body: unknown): Corpo => (body === undefined ? undefined : { json: body });

/** Upload é o único caminho que NÃO manda JSON. */
function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return enviar<T>('POST', path, { form });
}

export const api = {
  get: <T>(path: string) => enviar<T>('GET', path, undefined),
  upload: <T>(path: string, file: File) => upload<T>(path, file),
  post: <T>(path: string, body?: unknown) => enviar<T>('POST', path, json(body)),
  /**
   * POST com `Idempotency-Key`: a MESMA chave na repetição (a rede caiu, o
   * botão de novo) devolve a resposta guardada, sem segundo efeito.
   */
  postIdempotente: <T>(path: string, body: unknown, chave: string) =>
    enviar<T>('POST', path, { json: body, chave }),
  patch: <T>(path: string, body?: unknown) => enviar<T>('PATCH', path, json(body)),
  put: <T>(path: string, body?: unknown) => enviar<T>('PUT', path, json(body)),
  delete: <T>(path: string) => enviar<T>('DELETE', path, undefined),
};

export function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

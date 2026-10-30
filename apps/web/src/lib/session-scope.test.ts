import type { AuthUserDto } from '@veyra/contracts';
import { vi } from 'vitest';
import { api, ApiError, PRAZOS_DO_REFRESH } from './api';
import {
  SessaoEncerradaError,
  adotarSessao,
  escopoAtual,
  ouvirTrocaDeSessao,
  trocarSessao,
} from './session-scope';

const usuario = (id: string, membershipId: string): AuthUserDto =>
  ({
    id,
    name: `Pessoa ${id}`,
    email: `${id}@teste.test`,
    activeMembership: { membershipId, workspaceId: `w-${id}` },
    permissions: [],
    memberships: [],
    // a experiência entra no escopo (ADR-055 adendo 1)
    experience: { key: 'crm', status: 'ready' },
  }) as unknown as AuthUserDto;
const A = usuario('u-a', 'm-a');
const B = usuario('u-b', 'm-b');
const A2 = usuario('u-a', 'm-a2');
const ESCOPO_A = 'u-a:m-a:crm';
const ESCOPO_B = 'u-b:m-b:crm';

const json = (body: unknown, status = 200, escopo?: string, emiteSessao = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(escopo ? { 'x-veyra-scope': escopo } : {}),
      ...(emiteSessao ? { 'x-veyra-new-session': '1' } : {}),
    },
  });

function adiada() {
  let soltar!: (r: Response) => void;
  const promessa = new Promise<Response>((resolve) => (soltar = resolve));
  return { promessa, soltar };
}

type Rota = (init?: RequestInit) => Response | Promise<Response>;
function servidor(rotas: Record<string, Rota>) {
  const chamadas: { chave: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const chave = `${init?.method ?? 'GET'} ${String(input)}`;
      chamadas.push({ chave, init });
      const rota = rotas[chave];
      if (!rota) return json({ message: `sem rota: ${chave}` }, 404);
      return rota(init);
    }),
  );
  return chamadas;
}

/** Quem ouve as trocas de sessão (o provider, na aplicação). */
function trocas() {
  const vistas: (AuthUserDto | null | undefined)[] = [];
  ouvirTrocaDeSessao((semente) => vistas.push(semente));
  return vistas;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // o refresh é deduplicado e solto num setTimeout(0): sem esperar, o próximo
  // teste herdaria o resultado do refresh deste
  await new Promise((r) => setTimeout(r, 0));
});

describe('escopo da sessão (ADR-050)', () => {
  it('a primeira identidade é adotada sem troca; outra identidade ou outro workspace é troca', () => {
    const vistas = trocas();
    adotarSessao(A);
    expect(escopoAtual()).toBe(ESCOPO_A);
    expect(vistas).toEqual([]);
    adotarSessao(A);
    expect(vistas).toEqual([]);
    adotarSessao(usuario('u-a', 'outro-workspace'));
    expect(vistas).toHaveLength(1);
    expect(escopoAtual()).toBe('u-a:outro-workspace:crm');
  });

  it('a MESMA pessoa no MESMO workspace com OUTRA experiência é troca (ADR-055 adendo 1)', () => {
    const vistas = trocas();
    adotarSessao(A);
    const naClinica = {
      ...A,
      experience: { key: 'clinics', status: 'ready' },
    } as unknown as AuthUserDto;
    adotarSessao(naClinica);
    expect(vistas).toEqual([naClinica]);
    expect(escopoAtual()).toBe('u-a:m-a:clinics');
  });
});

describe('api: resposta de outra sessão nunca chega a quem pediu (ADR-050)', () => {
  it('resposta em voo que chega DEPOIS da troca é descartada, mesmo sem abort', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({ 'GET /api/contacts': () => atraso.promessa }); // ignora o abort
    const pedido = api.get('/api/contacts');
    trocarSessao(B);
    atraso.soltar(json({ items: ['de A'] }, 200, ESCOPO_A));
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
  });

  it('o ERRO de uma requisição antiga também é descartado', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({ 'GET /api/contacts': () => atraso.promessa });
    const pedido = api.get('/api/contacts');
    trocarSessao(null);
    atraso.soltar(json({ message: 'Contato Fulano de A não encontrado' }, 404, ESCOPO_A));
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
  });

  it('a troca ABORTA o que está em voo', async () => {
    adotarSessao(A);
    const chamadas = servidor({
      'GET /api/contacts': (init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    });
    const pedido = api.get('/api/contacts');
    trocarSessao(null);
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(chamadas[0].init?.signal?.aborted).toBe(true);
  });

  it('resposta com o escopo de OUTRA sessão (login em outra aba): descartada, e a aba recomeça sem identidade', async () => {
    adotarSessao(A);
    const vistas = trocas();
    servidor({ 'GET /api/contacts': () => json({ items: ['de B'] }, 200, ESCOPO_B) });
    await expect(api.get('/api/contacts')).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([undefined]);
    expect(escopoAtual()).toBeUndefined();
  });

  it('a experiência mudou no servidor (mesmo workspace, mesma pessoa): a resposta é descartada e a aba recomeça', async () => {
    adotarSessao(A);
    const vistas = trocas();
    servidor({ 'GET /api/contacts': () => json({ items: ['do CRM'] }, 200, 'u-a:m-a:clinics') });
    await expect(api.get('/api/contacts')).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([undefined]);
    expect(escopoAtual()).toBeUndefined();
  });

  it('resposta ATRASADA de uma sessão encerrada, com o escopo antigo: descartada sem derrubar a sessão nova', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({ 'GET /api/contacts': () => atraso.promessa });
    const pedido = api.get('/api/contacts');
    trocarSessao(B);
    const vistas = trocas();
    atraso.soltar(json({ items: ['de A'] }, 200, ESCOPO_A));
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([]);
    expect(escopoAtual()).toBe(ESCOPO_B);
  });

  it('o mesmo escopo, ou resposta sem escopo (rota pública), passa', async () => {
    adotarSessao(A);
    servidor({
      'GET /api/contacts': () => json({ items: ['de A'] }, 200, ESCOPO_A),
      'GET /api/health': () => json({ ok: true }),
    });
    await expect(api.get('/api/contacts')).resolves.toEqual({ items: ['de A'] });
    await expect(api.get('/api/health')).resolves.toEqual({ ok: true });
  });

  it('refresh recusado (401) é sessão perdida: troca para "sem sessão", e a resposta não chega', async () => {
    adotarSessao(A);
    const vistas = trocas();
    servidor({
      'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
      'POST /api/auth/refresh': () => json({ message: 'Sessão expirada' }, 401),
    });
    await expect(api.get('/api/contacts')).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([null]);
    expect(escopoAtual()).toBeNull();
  });

  it.each([
    ['falha de rede', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['503', () => json({ message: 'indisponível' }, 503)],
    ['429', () => json({ message: 'muitas tentativas' }, 429)],
  ] as [string, Rota][])(
    'refresh com %s NÃO derruba a sessão: só a requisição falha',
    async (_c, refresh) => {
      adotarSessao(A);
      const vistas = trocas();
      servidor({
        'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
        'POST /api/auth/refresh': refresh,
      });
      const erro = await api.get('/api/contacts').catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
      expect((erro as ApiError).status).toBe(401);
      expect(vistas).toEqual([]);
      expect(escopoAtual()).toBe(ESCOPO_A);
    },
  );

  it('refresh que volta em OUTRA identidade: troca de sessão, e a repetição nem é feita', async () => {
    adotarSessao(A);
    const vistas = trocas();
    const chamadas = servidor({
      'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
      'POST /api/auth/refresh': () => json(B),
    });
    await expect(api.get('/api/contacts')).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([B]);
    expect(chamadas.filter((c) => c.chave === 'GET /api/contacts')).toHaveLength(1);
  });

  it('refresh na MESMA identidade: repete e entrega', async () => {
    adotarSessao(A);
    let vez = 0;
    servidor({
      'GET /api/contacts': () =>
        vez++ === 0 ? json({ message: 'expirado' }, 401) : json({ items: ['de A'] }, 200, ESCOPO_A),
      'POST /api/auth/refresh': () => json(A),
    });
    await expect(api.get('/api/contacts')).resolves.toEqual({ items: ['de A'] });
  });

  it('a requisição declara o escopo que a aba espera — só quando o conhece, e nunca no login', async () => {
    const chamadas = servidor({
      'GET /api/contacts': () => json({ items: [] }, 200, ESCOPO_A),
      'POST /api/auth/login': () => json(A, 201),
    });
    const esperado = (i: number) =>
      (chamadas[i].init?.headers as Record<string, string>)['x-veyra-expected-scope'];
    await api.get('/api/contacts'); // aba recém-aberta: escopo desconhecido
    expect(esperado(0)).toBeUndefined();
    adotarSessao(A);
    await api.get('/api/contacts');
    expect(esperado(1)).toBe(ESCOPO_A);
    await api.post('/api/auth/login', { email: 'a@teste.test', password: 'x' });
    expect(esperado(2)).toBeUndefined();
  });

  it('409 da aba desatualizada (o servidor já está em outra sessão): nada chega, e a aba recomeça', async () => {
    adotarSessao(A);
    const vistas = trocas();
    servidor({
      'POST /api/contacts': () =>
        json({ message: 'A sessão deste navegador mudou em outra aba.' }, 409, ESCOPO_B),
    });
    await expect(api.post('/api/contacts', { name: 'x' })).rejects.toBeInstanceOf(
      SessaoEncerradaError,
    );
    expect(vistas).toEqual([undefined]);
  });

  it('refresh SEM workspace (membership desativada): troca a sessão para "sem workspace"', async () => {
    adotarSessao(A);
    const vistas = trocas();
    const semWorkspace = {
      ...A,
      activeMembership: null,
      experience: null,
    } as unknown as AuthUserDto;
    servidor({
      'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
      'POST /api/auth/refresh': () => json(semWorkspace),
    });
    await expect(api.get('/api/contacts')).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([semWorkspace]);
    expect(escopoAtual()).toBe('u-a:-:-');
  });

  it('um refresh que voava quando a sessão trocou não tem efeito nenhum', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({
      'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
      'POST /api/auth/refresh': () => atraso.promessa,
    });
    const pedido = api.get('/api/contacts');
    await new Promise((r) => setTimeout(r, 0)); // o refresh saiu
    trocarSessao(B); // outra sessão começa (ex.: login) enquanto ele voa
    const vistas = trocas();
    atraso.soltar(json({ message: 'Sessão expirada' }, 401)); // o 401 era da sessão de A
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([]);
    expect(escopoAtual()).toBe(ESCOPO_B);
  });

  it('resposta que EMITE sessão (troca de workspace) é troca de sessão, pela marca do servidor', async () => {
    adotarSessao(A);
    const vistas = trocas();
    const outroWorkspace = usuario('u-a', 'm-a2');
    servidor({
      'POST /api/auth/switch-workspace': () => json(outroWorkspace, 201, ESCOPO_A, true),
    });
    await expect(api.post('/api/auth/switch-workspace', { membershipId: 'm-a2' })).resolves.toEqual(
      outroWorkspace,
    );
    expect(vistas).toEqual([outroWorkspace]);
    expect(escopoAtual()).toBe('u-a:m-a2:crm');
  });

  it.each([
    ['login', 'POST /api/auth/login', '/api/auth/login'],
    ['aceite de convite', 'POST /api/invites/accept', '/api/invites/accept'],
  ])(
    '%s: a marca de sessão emitida troca a sessão; sem a marca, nada troca',
    async (_c, rota, caminho) => {
      adotarSessao(null);
      const vistas = trocas();
      servidor({ [rota]: () => json(B, 201, undefined, true), 'POST /api/x': () => json(B, 201) });
      await expect(api.post(caminho, {})).resolves.toEqual(B);
      expect(vistas).toEqual([B]);
      expect(escopoAtual()).toBe(ESCOPO_B);
      await api.post('/api/x', {});
      expect(vistas).toEqual([B]);
    },
  );

  it('refresh de OUTRA época ainda em voo: o novo espera ele terminar — o mesmo token nunca sai duas vezes', async () => {
    adotarSessao(A);
    const primeiro = adiada();
    let refreshes = 0;
    servidor({
      'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
      'POST /api/auth/refresh': () => {
        refreshes += 1;
        return refreshes === 1 ? primeiro.promessa : json(A2);
      },
    });
    const antigo = api.get('/api/contacts');
    await new Promise((r) => setTimeout(r, 0)); // R1 saiu
    trocarSessao(A2); // ex.: troca de workspace, que NÃO rotaciona o token
    const novo = api.get('/api/contacts');
    await new Promise((r) => setTimeout(r, 10));
    expect(refreshes).toBe(1); // R2 espera R1
    primeiro.soltar(json(A));
    await expect(antigo).rejects.toBeInstanceOf(SessaoEncerradaError);
    await novo.catch(() => undefined);
    expect(refreshes).toBe(2);
  });

  it('entre abas, o refresh passa pela trava da origem (`navigator.locks`)', async () => {
    adotarSessao(A);
    const travas: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: (nome: string, _opcoes: unknown, fn: () => Promise<Response>) => {
          travas.push(nome);
          return fn();
        },
      },
    });
    let vez = 0;
    servidor({
      'GET /api/contacts': () =>
        vez++ === 0 ? json({ message: 'expirado' }, 401) : json({ items: [] }, 200, ESCOPO_A),
      'POST /api/auth/refresh': () => json(A),
    });
    await api.get('/api/contacts');
    expect(travas).toEqual(['veyra-refresh']);
  });

  it('trava entre abas presa (outra aba pendurada): a espera tem prazo; a requisição falha, a sessão fica, e o refresh NUNCA sai sem a trava', async () => {
    adotarSessao(A);
    const vistas = trocas();
    const original = { ...PRAZOS_DO_REFRESH };
    PRAZOS_DO_REFRESH.travaMs = 20;
    try {
      vi.stubGlobal('navigator', {
        ...navigator,
        locks: {
          // a trava nunca é concedida: só a desistência por prazo encerra a espera
          // (sem prazo, a espera seria eterna e o teste estouraria o tempo)
          request: (_nome: string, opcoes?: { signal?: AbortSignal }) =>
            new Promise((_, rejeitar) =>
              opcoes?.signal?.addEventListener('abort', () => rejeitar(opcoes.signal!.reason)),
            ),
        },
      });
      const chamadas = servidor({
        'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
        'POST /api/auth/refresh': () => json(A),
      });
      const erro = await api.get('/api/contacts').catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ApiError);
      expect((erro as ApiError).status).toBe(401);
      expect(chamadas.some((c) => c.chave === 'POST /api/auth/refresh')).toBe(false);
      expect(vistas).toEqual([]);
      expect(escopoAtual()).toBe(ESCOPO_A);
    } finally {
      Object.assign(PRAZOS_DO_REFRESH, original);
    }
  });

  it('refresh PENDURADO (servidor lento): quem chama desiste no prazo e a sessão fica; o refresh não é abortado nem repetido com o mesmo token', async () => {
    adotarSessao(A);
    const vistas = trocas();
    const original = { ...PRAZOS_DO_REFRESH };
    PRAZOS_DO_REFRESH.esperaMs = 20;
    try {
      const lento = adiada();
      const chamadas = servidor({
        'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
        'POST /api/auth/refresh': () => lento.promessa,
      });
      const refreshes = () => chamadas.filter((c) => c.chave === 'POST /api/auth/refresh');
      for (let i = 0; i < 2; i++) {
        const erro = await api.get('/api/contacts').catch((e: unknown) => e);
        expect((erro as ApiError).status).toBe(401);
      }
      expect(refreshes()).toHaveLength(1); // o segundo pedido não reapresentou o token
      expect(refreshes()[0].init?.signal).toBeUndefined(); // e o refresh não tem abort
      expect(vistas).toEqual([]);
      expect(escopoAtual()).toBe(ESCOPO_A);
      lento.soltar(json(A));
    } finally {
      Object.assign(PRAZOS_DO_REFRESH, original);
    }
  });

  it('refresh de OUTRA época pendurado além do prazo: quem chama desiste SEM pedir outro (seria o mesmo token)', async () => {
    adotarSessao(A);
    const original = { ...PRAZOS_DO_REFRESH };
    PRAZOS_DO_REFRESH.esperaMs = 20;
    try {
      const pendurado = adiada();
      const chamadas = servidor({
        'GET /api/contacts': () => json({ message: 'Sessão expirada' }, 401),
        'POST /api/auth/refresh': () => pendurado.promessa,
      });
      await api.get('/api/contacts').catch(() => undefined); // R1 sai e fica pendurado
      trocarSessao(A2); // troca de workspace: o token NÃO rotaciona
      const erro = await api.get('/api/contacts').catch((e: unknown) => e);
      expect((erro as ApiError).status).toBe(401);
      expect(chamadas.filter((c) => c.chave === 'POST /api/auth/refresh')).toHaveLength(1);
      pendurado.soltar(json({ message: 'Sessão expirada' }, 401));
    } finally {
      Object.assign(PRAZOS_DO_REFRESH, original);
    }
  });

  it('o logout em voo não é abortado pela troca de sessão (o cookie de limpeza não se perde)', async () => {
    adotarSessao(A);
    const chamadas = servidor({ 'POST /api/auth/logout': () => json({ ok: true }, 201, ESCOPO_A) });
    await api.post('/api/auth/logout');
    expect(chamadas[0].init?.signal).toBeUndefined();
  });

  it('a resposta do logout que chega DEPOIS de uma troca é descartada: não leva a sessão nova a "sem sessão"', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({ 'POST /api/auth/logout': () => atraso.promessa });
    const pedido = api.post('/api/auth/logout');
    trocarSessao(B);
    const vistas = trocas();
    atraso.soltar(json({ ok: true }, 201, ESCOPO_A));
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
    expect(vistas).toEqual([]);
    expect(escopoAtual()).toBe(ESCOPO_B);
  });

  it('marca de sessão com corpo que não é sessão: a aba relê `/auth/me` em vez de adotar lixo', async () => {
    adotarSessao(A);
    const vistas = trocas();
    servidor({ 'POST /api/auth/login': () => json({ ok: true }, 201, undefined, true) });
    await api.post('/api/auth/login', {});
    expect(vistas).toEqual([undefined]);
    expect(escopoAtual()).toBeUndefined();
  });

  it('a isenção do login é EXATA: outra rota que comece igual segue a regra da sessão', async () => {
    adotarSessao(A);
    const chamadas = servidor({ 'GET /api/auth/login-history': () => json([], 200, ESCOPO_A) });
    await api.get('/api/auth/login-history');
    expect(chamadas[0].init?.signal).toBeDefined();
  });

  it('o LOGIN não é abortado nem descartado: a resposta dele é a sessão nova', async () => {
    adotarSessao(null);
    const atraso = adiada();
    const chamadas = servidor({ 'POST /api/auth/login': () => atraso.promessa });
    const pedido = api.post('/api/auth/login', { email: 'b@teste.test', password: 'x' });
    trocarSessao(null);
    atraso.soltar(json(B, 201));
    await expect(pedido).resolves.toEqual(B);
    expect(chamadas[0].init?.signal).toBeUndefined();
  });

  it('upload segue a mesma regra', async () => {
    adotarSessao(A);
    const atraso = adiada();
    servidor({ 'POST /api/files': () => atraso.promessa });
    const pedido = api.upload('/api/files', new File(['x'], 'x.txt'));
    trocarSessao(B);
    atraso.soltar(json({ id: 'f' }, 201, ESCOPO_A));
    await expect(pedido).rejects.toBeInstanceOf(SessaoEncerradaError);
  });
});

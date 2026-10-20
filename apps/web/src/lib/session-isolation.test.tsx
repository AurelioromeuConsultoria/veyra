import type { QueryClient } from '@tanstack/react-query';
import type { AuthUserDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';
import { criarQueryClient, SessionQueryProvider } from './session-query';
import { escopoAtual } from './session-scope';

/**
 * Duas sessões na MESMA aba, com o App inteiro e em StrictMode, como no
 * `main.tsx` (ADR-050). Um servidor falso responde pela identidade do "cookie"
 * do momento, com o cabeçalho de escopo e o 409 do escopo esperado, como o
 * real. Dados fictícios.
 */
const PERMISSOES = ['clinics:schedule:read', 'clinics:catalog:read', 'contacts:read'];
const pessoa = (id: string, workspace: string) =>
  ({
    id: `u-${id}`,
    name: `Pessoa ${id.toUpperCase()}`,
    email: `${id}@teste.test`,
    activeMembership: {
      membershipId: `m-${id}`,
      workspaceId: `w-${id}`,
      workspaceName: workspace,
      workspaceSlug: workspace.toLowerCase().replace(/\s/g, '-'),
      roleName: 'Member',
      status: 'active',
    },
    permissions: PERMISSOES,
    memberships: [],
  }) as unknown as AuthUserDto;
const A = pessoa('a', 'Clínica A');
const B = pessoa('b', 'Clínica B');
const PACIENTES: Record<string, string> = { 'u-a': 'Paciente de A', 'u-b': 'Paciente de B' };
const CONTATOS: Record<string, string> = { 'u-a': 'Ana de A', 'u-b': 'Ana de B' };

interface Servidor {
  /** quem o cookie da origem diz que é (null = sem cookie) */
  cookie: AuthUserDto | null;
  expirou: boolean;
  /** o logout responde 503 (rede ou servidor com problema) */
  logoutQuebrado?: boolean;
  /** segura a PRÓXIMA resposta deste caminho; ela é calculada na hora do pedido */
  segurar: string | null;
  seguradas: (() => void)[];
}

const json = (body: unknown, status: number, escopo?: string, emiteSessao = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(escopo ? { 'x-veyra-scope': escopo } : {}),
      // como o `setSessionCookies` real: a resposta que emite sessão é marcada
      ...(emiteSessao ? { 'x-veyra-new-session': '1' } : {}),
    },
  });

function subirServidor(): Servidor {
  const s: Servidor = { cookie: null, expirou: false, segurar: null, seguradas: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const metodo = init?.method ?? 'GET';
      if (metodo === 'POST' && url === '/api/auth/login') {
        const { email } = JSON.parse(String(init!.body)) as { email: string };
        s.cookie = email.startsWith('a') ? A : B;
        s.expirou = false;
        return json(s.cookie, 201, undefined, true);
      }
      const viva = s.cookie && !s.expirou ? s.cookie : null;
      if (url === '/api/auth/refresh') {
        return viva ? json(viva, 201, undefined, true) : json({ message: 'Sessão expirada' }, 401);
      }
      if (!viva) return json({ message: 'Sessão expirada' }, 401);
      const escopo = `${viva.id}:${viva.activeMembership!.membershipId}`;
      // como o guard: a aba que espera outra sessão é recusada antes de tudo
      const esperado = (init?.headers as Record<string, string> | undefined)?.[
        'x-veyra-expected-scope'
      ];
      if (esperado && esperado !== escopo) {
        return json({ message: 'A sessão deste navegador mudou em outra aba.' }, 409, escopo);
      }
      const segurar = (resposta: Response) => {
        if (!s.segurar || !url.startsWith(s.segurar)) return resposta;
        // chega quando o teste mandar — e IGNORA o abort, como uma resposta
        // que já estava a caminho
        s.segurar = null;
        return new Promise<Response>((resolve) => s.seguradas.push(() => resolve(resposta)));
      };
      if (url === '/api/auth/logout') {
        if (s.logoutQuebrado) return json({ message: 'indisponível' }, 503, escopo);
        s.cookie = null;
        return json({ ok: true }, 201, escopo);
      }
      if (url === '/api/auth/me') return json(viva, 200, escopo);
      if (url === '/api/clinics/status') return json({ active: true }, 200, escopo);
      if (url.startsWith('/api/clinics/patients')) {
        return segurar(
          json(
            [{ id: `p-${viva.id}`, name: PACIENTES[viva.id], createdAt: '2030-01-01T00:00:00Z' }],
            200,
            escopo,
          ),
        );
      }
      if (url.startsWith('/api/contacts?')) {
        return segurar(
          json(
            {
              items: [
                { id: `c-${viva.id}`, name: CONTATOS[viva.id], emails: [], companyName: null },
              ],
              total: 1,
              page: 1,
              pageSize: 6,
            },
            200,
            escopo,
          ),
        );
      }
      return json({ message: `fora do teste: ${url}` }, 404, escopo);
    }),
  );
  return s;
}

/** Todo cache criado, em ordem: o da sessão anterior precisa ficar vazio. */
const criados: QueryClient[] = [];
const semRetentativa = (semente?: AuthUserDto | null) => {
  const client = criarQueryClient(semente);
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  criados.push(client);
  return client;
};

function abrirAba() {
  render(
    <StrictMode>
      <SessionQueryProvider criar={semRetentativa}>
        <MemoryRouter initialEntries={['/login']}>
          <App />
        </MemoryRouter>
      </SessionQueryProvider>
    </StrictMode>,
  );
}

async function entrar(email: string) {
  fireEvent.change(await screen.findByLabelText('E-mail'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'senha-ficticia' } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
}

async function abrirPacientes() {
  const lateral = within(await screen.findByRole('navigation', { name: 'Principal' }));
  fireEvent.click(await lateral.findByRole('link', { name: 'Pacientes' }));
}

const buscar = (termo: string) =>
  fireEvent.change(screen.getByLabelText(/^Buscar paciente/), { target: { value: termo } });

beforeEach(() => {
  criados.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('duas sessões na mesma aba (ADR-050)', () => {
  it('expiração SEM logout e login em outro workspace: nada da sessão anterior, nem enquanto a nova carrega', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();

    // a sessão expira no servidor; a aba só descobre na próxima requisição
    servidor.expirou = true;
    buscar('Pac');
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByText('Paciente de A')).toBeNull();

    // outra pessoa, outro workspace, na mesma aba; a lista dela demora
    await entrar('b@teste.test');
    servidor.segurar = '/api/clinics/patients';
    await abrirPacientes();
    await waitFor(() => expect(servidor.seguradas).toHaveLength(1));
    // enquanto a lista de B não chega, nada de A aparece (antes: o cache de A)
    expect(screen.queryByText('Paciente de A')).toBeNull();
    servidor.seguradas[0]();
    expect(await screen.findByText('Paciente de B')).toBeInTheDocument();
    expect(screen.queryByText('Paciente de A')).toBeNull();
    // e o cache de A não ficou guardado em lugar nenhum: todo cache anterior está vazio
    for (const anterior of criados.slice(0, -1)) {
      expect(anterior.getQueryCache().getAll()).toEqual([]);
    }
  });

  it('busca global com cache de 30 s (Core): a busca de A não reaparece para B no mesmo termo', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    const abrirBusca = async () =>
      fireEvent.click(await screen.findByRole('button', { name: /Buscar contato ou seção/ }));
    await abrirBusca();
    fireEvent.change(screen.getByRole('combobox', { name: 'Buscar no workspace' }), {
      target: { value: 'Ana' },
    });
    expect(await screen.findByText('Ana de A')).toBeInTheDocument();

    servidor.expirou = true;
    fireEvent.change(screen.getByRole('combobox', { name: 'Buscar no workspace' }), {
      target: { value: 'Ana d' },
    });
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();

    // B, segundos depois, busca o MESMO termo; a resposta de B demora
    await entrar('b@teste.test');
    servidor.segurar = '/api/contacts?';
    await abrirBusca();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Buscar no workspace' }), {
      target: { value: 'Ana' },
    });
    await waitFor(() => expect(servidor.seguradas).toHaveLength(1));
    // antes: o resultado de A vinha do cache, sem nem recarregar
    expect(screen.queryByText('Ana de A')).toBeNull();
    servidor.seguradas[0]();
    expect(await screen.findByText('Ana de B')).toBeInTheDocument();
    expect(screen.queryByText('Ana de A')).toBeNull();
  });

  it('aba que volta a ficar visível relê a sessão: cookie trocado em outra aba recomeça a tela SEM nenhum clique', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();
    servidor.cookie = B; // outra aba entrou como B enquanto esta estava em segundo plano
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(escopoAtual()).toBe('u-b:m-b'));
    expect(screen.queryByText('Paciente de A')).toBeNull();
  });

  it('logout que FALHA (503): a sessão continua e a tela avisa — nada de fingir que saiu com o cookie vivo', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();
    servidor.logoutQuebrado = true;
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(
      await screen.findByText(
        'Não foi possível sair — você continua conectado neste navegador. Tente de novo.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
    expect(escopoAtual()).toBe('u-a:m-a');
  });

  it('logout numa aba DESATUALIZADA: o servidor recusa, e a aba recomeça na sessão do cookie — sem fingir que o navegador saiu', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();
    servidor.cookie = B; // outra aba entrou como B
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => expect(escopoAtual()).toBe('u-b:m-b'));
    expect(servidor.cookie).toBe(B); // a sessão de B não foi encerrada pela aba de A
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Entrar' })).toBeNull();
    expect(screen.queryByText('Paciente de A')).toBeNull();
  });

  it('resposta ANTIGA, que chega depois do novo login, não aparece', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();

    // um pedido de A fica a caminho, já calculado com os dados de A
    servidor.segurar = '/api/clinics/patients';
    buscar('Paci');
    await waitFor(() => expect(servidor.seguradas).toHaveLength(1));

    servidor.expirou = true;
    buscar('Pacie');
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    await entrar('b@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de B')).toBeInTheDocument();
    buscar('Paci');

    // agora a resposta antiga chega
    servidor.seguradas[0]();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Paciente de A')).toBeNull();
    expect(await screen.findByText('Paciente de B')).toBeInTheDocument();
  });

  it('login em OUTRA aba (o cookie muda para todas): a resposta de outro escopo é descartada e a aba recomeça na sessão do cookie', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();

    servidor.cookie = B; // outra aba entrou como B
    buscar('Pac');
    // a aba recomeça e relê quem é a sessão: agora B (aqui, a partir do /login
    // do MemoryRouter; no navegador, o BrowserRouter mantém a URL)
    await waitFor(() => expect(escopoAtual()).toBe('u-b:m-b'));
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('Paciente de A')).toBeNull();
    await abrirPacientes();
    expect(await screen.findByText('Paciente de B')).toBeInTheDocument();
    expect(screen.queryByText('Paciente de A')).toBeNull();
  });

  it('logout pela tela e login de outra pessoa: cache novo, nada de A enquanto a lista de B carrega', async () => {
    const servidor = subirServidor();
    abrirAba();
    await entrar('a@teste.test');
    await abrirPacientes();
    expect(await screen.findByText('Paciente de A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(servidor.cookie).toBeNull();
    expect(screen.queryByText('Paciente de A')).toBeNull();
    await entrar('b@teste.test');
    servidor.segurar = '/api/clinics/patients';
    await abrirPacientes();
    await waitFor(() => expect(servidor.seguradas).toHaveLength(1));
    expect(screen.queryByText('Paciente de A')).toBeNull();
  });
});

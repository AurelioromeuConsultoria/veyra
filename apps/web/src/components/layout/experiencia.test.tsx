import type { AuthUserDto, ExperienceStatus, MembershipSummaryDto } from '@veyra/contracts';
import { sessionScopeKey } from '@veyra/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../../App';
import { criarQueryClient, SessionQueryProvider } from '../../lib/session-query';
import { reiniciarSessaoParaTestes } from '../../lib/session-scope';

/**
 * A experiência por produto no web (ADR-055, adendo 2). Dados FICTÍCIOS. O que
 * se prova, pela aplicação inteira:
 * - cada produto monta só o seu menu, as suas rotas e a sua busca; a rota de
 *   fora leva ao início com o aviso;
 * - carregando, desconhecida, indisponível e sem workspace nunca mostram o CRM;
 * - a experiência que fica indisponível SEM mudar a chave tira a tela anterior,
 *   e a releitura depois de 403/404 é limitada;
 * - a troca de workspace e a de experiência na mesma sessão chegam ao produto
 *   certo, sem resposta antiga;
 * - a divergência de sessão que persiste para a aba, sem nova tentativa.
 */
const PERMISSOES = [
  'contacts:read',
  'members:read',
  'conversations:read',
  'pipelines:read',
  'clinics:schedule:read',
  'clinics:catalog:read',
];

const membership = (id: string, nome: string, experiencia: string): MembershipSummaryDto => ({
  membershipId: `m-${id}`,
  workspaceId: `w-${id}`,
  workspaceName: nome,
  workspaceSlug: id,
  roleName: 'Owner',
  status: 'active',
  experience: experiencia,
});
const CRM = membership('crm', 'Empresa Fictícia', 'crm');
const CLINICA = membership('clinica', 'Clínica Fictícia', 'clinics');

function pessoa(
  ativa: MembershipSummaryDto | null,
  status: ExperienceStatus = 'ready',
  memberships: MembershipSummaryDto[] = [CRM, CLINICA],
): AuthUserDto {
  return {
    id: 'u-1',
    name: 'Pessoa Fictícia',
    email: 'pessoa@empresa.test',
    activeMembership: ativa,
    permissions: ativa ? (PERMISSOES as AuthUserDto['permissions']) : [],
    memberships,
    experience: ativa ? { key: ativa.experience, status } : null,
  };
}

const escopoDe = (u: AuthUserDto) =>
  sessionScopeKey(u.id, u.activeMembership?.membershipId, u.experience?.key);

type Rota = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
interface Servidor {
  sessao: AuthUserDto | null;
  chamadas: string[];
  /** respostas especiais, por prefixo de URL */
  rotas: Record<string, Rota>;
  /** o escopo que o servidor diz, se diferente do da sessão (incompatibilidade) */
  escopoForcado: string | null;
}

const json = (body: unknown, status: number, escopo?: string, emiteSessao = false) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(escopo ? { 'x-veyra-scope': escopo } : {}),
      ...(emiteSessao ? { 'x-veyra-new-session': '1' } : {}),
    },
  });

function subirServidor(sessao: AuthUserDto | null): Servidor {
  const s: Servidor = { sessao, chamadas: [], rotas: {}, escopoForcado: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const metodo = init?.method ?? 'GET';
      s.chamadas.push(`${metodo} ${url}`);
      for (const [prefixo, rota] of Object.entries(s.rotas)) {
        if (`${metodo} ${url}`.startsWith(prefixo)) {
          const r = await rota(url, init);
          if (r) return r;
        }
      }
      const viva = s.sessao;
      if (!viva) return json({ message: 'Sessão expirada' }, 401);
      const escopo = s.escopoForcado ?? escopoDe(viva);
      if (url === '/api/auth/me') return json(viva, 200, escopo);
      if (metodo === 'POST' && url === '/api/auth/switch-workspace') {
        const { membershipId } = JSON.parse(String(init!.body)) as { membershipId: string };
        const destino = viva.memberships.find((m) => m.membershipId === membershipId)!;
        s.sessao = pessoa(destino, 'ready', viva.memberships);
        // como o real: responde no escopo de quem pediu, com a marca de sessão nova
        return json(s.sessao, 201, escopo, true);
      }
      if (url === '/api/clinics/status') return json({ active: true }, 200, escopo);
      if (url.startsWith('/api/clinics/leads'))
        return json({ items: [], nextCursor: null }, 200, escopo);
      if (url.startsWith('/api/conversations'))
        return json({ items: [], nextCursor: null }, 200, escopo);
      if (url.startsWith('/api/notifications'))
        return json({ items: [], unreadCount: 0 }, 200, escopo);
      if (url.startsWith('/api/contacts')) {
        return json(
          {
            items: [
              {
                id: 'c-1',
                name: `Contato de ${viva.activeMembership?.workspaceName}`,
                emails: [],
                companyName: null,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 6,
          },
          200,
          escopo,
        );
      }
      if (url.startsWith('/api/clinics/')) return json([], 200, escopo);
      if (url.startsWith('/api/tags')) return json([], 200, escopo);
      return json({ message: `fora do teste: ${url}` }, 404, escopo);
    }),
  );
  return s;
}

const semRetentativa = (semente?: AuthUserDto | null) => {
  const client = criarQueryClient(semente);
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return client;
};

/**
 * O roteador FORA do provider da sessão: no navegador, o `BrowserRouter` lê a
 * URL da janela, que sobrevive à troca de sessão (a árvore remonta, a URL não).
 * Um `MemoryRouter` remontado voltaria à rota inicial.
 */
function abrir(caminho: string) {
  render(
    <MemoryRouter initialEntries={[caminho]}>
      <SessionQueryProvider criar={semRetentativa}>
        <App />
      </SessionQueryProvider>
    </MemoryRouter>,
  );
}

const lateral = async () => within(await screen.findByRole('navigation', { name: 'Principal' }));

/** A faixa do produto (o `AppHeader`), não o cabeçalho de uma página. */
const cabecalho = () =>
  screen.getByRole('navigation', { name: 'Onde você está' }).closest('header') as HTMLElement;

/** Na clínica, as Tags ficam nas Configurações (Etiquetas e campos), não na lateral. */
async function irParaTags() {
  fireEvent.click((await lateral()).getByRole('link', { name: /^Configurações$/ }));
  await screen.findByRole('heading', { name: 'Configurações', level: 1 });
  fireEvent.click(within(screen.getByRole('main')).getByRole('link', { name: /^Tags$/ }));
}

beforeEach(() => reiniciarSessaoParaTestes());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cada produto, o seu menu e as suas rotas', () => {
  it('CRM: o menu de sempre, sem nada do Clinics', async () => {
    subirServidor(pessoa(CRM));
    abrir('/tags');
    const menu = await lateral();
    expect(await menu.findByRole('link', { name: 'Contatos' })).toBeInTheDocument();
    expect(menu.getByRole('link', { name: 'Empresas' })).toBeInTheDocument();
    expect(menu.queryByRole('link', { name: 'Agenda da clínica' })).toBeNull();
    expect(menu.queryByText('Clínica')).toBeNull();
    expect(screen.getByText('veyra')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toMatch(/Empresa Fictícia · Veyra$/));
  });

  it('Clinics: o início é o Hoje da clínica, e o menu é o da clínica — nada do CRM que não é dela', async () => {
    subirServidor(pessoa(CLINICA));
    abrir('/');
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
    // o Hoje é o da clínica: os cartões dela, não o painel comercial
    expect(await screen.findByRole('region', { name: 'Retornos vencidos' })).toBeInTheDocument();
    const menu = await lateral();
    for (const da of ['Hoje', 'Agenda', 'Pacientes', 'Conversas', 'Retornos', 'Configurações']) {
      expect(menu.getByRole('link', { name: new RegExp(`^${da}$`) })).toBeInTheDocument();
    }
    // os grupos agrupam: os subitens não ficam expostos até a pessoa abrir
    expect(menu.getByRole('button', { name: 'Captação' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(menu.queryByRole('link', { name: 'Interessados' })).toBeNull();
    fireEvent.click(menu.getByRole('button', { name: 'Captação' }));
    expect(menu.getByRole('link', { name: 'Interessados' })).toBeInTheDocument();
    expect(menu.getByRole('link', { name: 'Funil' })).toBeInTheDocument();
    // um grupo com um item só (sem consents:read, só Retornos) mostra o item direto
    expect(menu.queryByRole('button', { name: 'Acompanhamento' })).toBeNull();
    for (const fora of ['Empresas', 'Tarefas', 'Sinais', 'Automações', 'Contatos', 'Tags']) {
      expect(menu.queryByRole('link', { name: new RegExp(`^${fora}$`) })).toBeNull();
    }
    expect(screen.getByText('veyra clinics')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.title).toMatch(/^Hoje · Clínica Fictícia · Veyra Clinics$/),
    );
  });

  it('rota direta de OUTRO produto leva ao início deste, com o aviso — nos dois sentidos', async () => {
    subirServidor(pessoa(CLINICA));
    abrir('/companies');
    expect(await screen.findByTestId('fora-da-experiencia')).toHaveTextContent(
      'Esta seção não faz parte do Veyra Clinics',
    );
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
  });

  it('no CRM, a rota do Clinics também não existe', async () => {
    const s = subirServidor(pessoa(CRM));
    s.rotas['GET /api/'] = (url) =>
      url === '/api/auth/me' || url.startsWith('/api/notifications') || url.startsWith('/api/tags')
        ? undefined
        : json({}, 200, escopoDe(s.sessao!));
    abrir('/clinics/agenda');
    expect(await screen.findByTestId('fora-da-experiencia')).toHaveTextContent(
      'Esta seção não faz parte do Veyra',
    );
    expect(s.chamadas.some((c) => c.includes('/api/clinics/'))).toBe(false);
  });
});

describe('a busca é do produto ativo', () => {
  it('no Clinics, a busca traz pacientes e interessados com o rótulo e o destino de cada um, e nenhuma seção do CRM', async () => {
    const s = subirServidor(pessoa(CLINICA));
    s.rotas['GET /api/clinics/patients'] = () =>
      json(
        [{ id: 'p-1', name: 'Paciente Fictício', createdAt: '2030-01-01T00:00:00Z' }],
        200,
        escopoDe(s.sessao!),
      );
    s.rotas['GET /api/clinics/leads'] = () =>
      json(
        {
          items: [{ id: 'c-9', name: 'Interessada Fictícia', createdAt: '2030-01-01T00:00:00Z' }],
          nextCursor: null,
        },
        200,
        escopoDe(s.sessao!),
      );
    abrir('/');
    await screen.findByRole('heading', { name: 'Hoje', level: 1 });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(await screen.findByLabelText('Buscar no workspace'), {
      target: { value: 'fic' },
    });
    const paciente = await screen.findByRole('option', { name: /Paciente Fictício.*Paciente/ });
    expect(
      screen.getByRole('option', { name: /Interessada Fictícia.*Interessado/ }),
    ).toBeInTheDocument();
    // a busca de contatos do CRM não sai no Clinics
    expect(s.chamadas.some((c) => c.startsWith('GET /api/contacts?'))).toBe(false);
    fireEvent.click(paciente);
    expect(await screen.findByText('Paciente não encontrado.')).toBeInTheDocument();
    // a seção do CRM não existe aqui
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(await screen.findByLabelText('Buscar no workspace'), {
      target: { value: 'empresas' },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByRole('option', { name: /^Empresas/ })).toBeNull();
  });

  it('no CRM, a seção Empresas aparece', async () => {
    subirServidor(pessoa(CRM));
    abrir('/tags');
    await lateral();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.change(await screen.findByLabelText('Buscar no workspace'), {
      target: { value: 'empresas' },
    });
    expect(await screen.findByRole('option', { name: /Empresas/ })).toBeInTheDocument();
  });
});

describe('os estados da experiência nunca mostram o CRM', () => {
  it('carregando: nenhum menu de produto nem o título da tela anterior antes da sessão', async () => {
    document.title = 'Tags · Empresa Fictícia · Veyra';
    const s = subirServidor(pessoa(CLINICA));
    let soltar!: () => void;
    s.rotas['GET /api/auth/me'] = () =>
      new Promise<Response>((r) => (soltar = () => r(json(s.sessao, 200, escopoDe(s.sessao!)))));
    abrir('/');
    expect(await screen.findByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Principal' })).toBeNull();
    // o título neutro é gravado num efeito, logo depois de a tela montar
    await waitFor(() => expect(document.title).toBe('Veyra'));
    await act(async () => soltar());
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
  });

  it.each([
    ['desconhecida', pessoa({ ...CLINICA, experience: 'outra' }), /produto desconhecido/],
    ['indisponível', pessoa(CLINICA, 'unavailable'), /Veyra Clinics está indisponível/],
    ['sem workspace', pessoa(null), /não tem um workspace ativo/],
  ])(
    '%s: a tela neutra, sem menu de produto nem o título da tela anterior',
    async (_caso, sessao, titulo) => {
      document.title = 'Contatos · Empresa Fictícia · Veyra';
      subirServidor(sessao);
      abrir('/contacts');
      expect(await screen.findByRole('heading', { name: titulo })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Principal' })).toBeNull();
      expect(screen.queryByText('veyra clinics')).toBeNull();
      // o título neutro é gravado num efeito, logo depois de a tela montar
      await waitFor(() => expect(document.title).toBe('Veyra'));
    },
  );

  it('INDISPONÍVEL sem mudar a chave: um 403 relê a sessão e a tela anterior sai; "Verificar de novo" traz o produto com cache novo, sem o dado de antes', async () => {
    const s = subirServidor(pessoa(CLINICA));
    let tag = 'Tag de antes';
    let reter = false;
    let retida = false;
    let soltarTags!: () => void;
    s.rotas['GET /api/tags'] = () => {
      const corpo = json(
        [{ id: 't-1', name: tag, color: 'gray', usageCount: 0 }],
        200,
        escopoDe(s.sessao!),
      );
      if (!reter) return corpo;
      return new Promise<Response>((r) => {
        retida = true;
        soltarTags = () => r(corpo);
      });
    };
    abrir('/tags');
    expect(await screen.findByText('Tag de antes')).toBeInTheDocument();
    const mes = () => s.chamadas.filter((c) => c === 'GET /api/auth/me').length;
    const antes = mes();
    // o Clinics foi desativado: a chave é a mesma, o estado não; a próxima
    // consulta do vertical responde 403
    s.sessao = pessoa(CLINICA, 'unavailable');
    s.rotas['GET /api/clinics/patients'] = () =>
      s.sessao!.experience!.status === 'ready'
        ? undefined
        : json({ message: 'Clinics desativado' }, 403, escopoDe(s.sessao!));
    fireEvent.click((await lateral()).getByRole('link', { name: 'Pacientes' }));
    expect(
      await screen.findByRole('heading', { name: /Veyra Clinics está indisponível/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Principal' })).toBeNull();
    expect(screen.queryByText('Tag de antes')).toBeNull();
    expect(mes() - antes).toBe(1);

    // reativado; a tela neutra não relê sozinha — a pessoa pede
    s.sessao = pessoa(CLINICA);
    tag = 'Tag de depois';
    reter = true;
    fireEvent.click(screen.getByRole('button', { name: 'Verificar de novo' }));
    expect(await screen.findByRole('heading', { name: 'Pacientes', level: 1 })).toBeInTheDocument();
    await irParaTags();
    await screen.findByRole('heading', { name: 'Tags', level: 1 });
    await waitFor(() => expect(retida).toBe(true));
    // a consulta nova está retida: o dado de ANTES da desativação não volta
    // (sem a troca de sessão pelo estado, o cache antigo o mostraria já)
    expect(screen.queryByText('Tag de antes')).toBeNull();
    await act(async () => soltarTags());
    expect(await screen.findByText('Tag de depois')).toBeInTheDocument();
  });

  it('a releitura depois de 403/404 é limitada: vários 403/404 seguidos, uma releitura só', async () => {
    const s = subirServidor(pessoa(CRM));
    abrir('/tags');
    await lateral();
    const mes = () => s.chamadas.filter((c) => c === 'GET /api/auth/me').length;
    const antes = mes();
    // falta de permissão (403 em Tags) e rota fora do teste (404 em Equipe): a
    // sessão continua a mesma. O primeiro gasta a janela; os seguintes ficam
    // para o fim dela, que o teste não alcança
    s.rotas['GET /api/tags'] = () => json({ message: 'Sem permissão' }, 403, escopoDe(s.sessao!));
    for (const destino of ['Equipe', 'Tags', 'Equipe', 'Tags']) {
      fireEvent.click((await lateral()).getByRole('link', { name: destino }));
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(mes() - antes).toBe(1);
    // nenhuma recarga: a tela do produto continua
    expect(screen.getByRole('navigation', { name: 'Principal' })).toBeInTheDocument();
  });
});

describe('troca de workspace e de experiência', () => {
  it('pelo seletor: o produto, o menu e os dados passam a ser os do workspace escolhido', async () => {
    const s = subirServidor(pessoa(CRM));
    abrir('/tags');
    await lateral();
    fireEvent.click(await screen.findByRole('button', { name: /Trocar de workspace/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Clínica Fictícia/ }));
    expect(await screen.findByRole('heading', { name: 'Hoje', level: 1 })).toBeInTheDocument();
    expect((await lateral()).queryByRole('link', { name: 'Empresas' })).toBeNull();
    expect(s.chamadas).toContain('POST /api/auth/switch-workspace');
  });

  it('sem workspace ativo: a tela neutra oferece os outros e troca para o escolhido', async () => {
    subirServidor(pessoa(null, 'ready', [CRM]));
    abrir('/');
    expect(
      await screen.findByRole('heading', { name: /não tem um workspace ativo/ }),
    ).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Empresa Fictícia/ }));
    expect(await (await lateral()).findByRole('link', { name: 'Hoje' })).toBeInTheDocument();
  });

  it('a resposta ATRASADA do workspace anterior não aparece depois da troca, na MESMA tela dos dois produtos', async () => {
    const s = subirServidor(pessoa(CRM));
    let retida = false;
    let soltar!: () => void;
    s.rotas['GET /api/tags'] = () => {
      const viva = s.sessao!;
      const corpo = json(
        [
          {
            id: `t-${viva.activeMembership!.workspaceSlug}`,
            name: `Tag de ${viva.activeMembership!.workspaceName}`,
            color: 'gray',
            usageCount: 0,
          },
        ],
        200,
        escopoDe(viva),
      );
      // a do CRM fica retida até depois da troca
      if (viva.activeMembership!.membershipId !== CRM.membershipId) return corpo;
      return new Promise<Response>((r) => {
        retida = true;
        soltar = () => r(corpo);
      });
    };
    abrir('/tags');
    await waitFor(() => expect(retida).toBe(true));
    fireEvent.click(await screen.findByRole('button', { name: /Trocar de workspace/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Clínica Fictícia/ }));
    await screen.findByRole('heading', { name: 'Hoje', level: 1 });
    // a mesma tela (Tags existe nos dois produtos), agora na clínica
    await irParaTags();
    expect(await screen.findByText('Tag de Clínica Fictícia')).toBeInTheDocument();
    await act(async () => soltar());
    expect(screen.queryByText('Tag de Empresa Fictícia')).toBeNull();
    expect(screen.getByText('Tag de Clínica Fictícia')).toBeInTheDocument();
  });

  it('a MESMA sessão muda de experiência no mesmo workspace: a tela vira a do produto novo', async () => {
    const s = subirServidor(pessoa({ ...CLINICA, experience: 'crm' }));
    abrir('/tags');
    expect(await (await lateral()).findByRole('link', { name: 'Empresas' })).toBeInTheDocument();
    // a operação trocou a experiência; a pessoa e a membership são as mesmas
    s.sessao = pessoa(CLINICA);
    // a aba volta a ficar visível e relê a sessão: a resposta já vem no escopo novo
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(screen.queryByText('veyra clinics')).toBeInTheDocument());
    const menu = await lateral();
    expect(menu.queryByRole('link', { name: 'Empresas' })).toBeNull();
    expect(menu.getByRole('link', { name: 'Pacientes' })).toBeInTheDocument();
    // a rota em que estava (Tags) também existe no produto novo: continua nela
    expect(await screen.findByRole('heading', { name: 'Tags', level: 1 })).toBeInTheDocument();
  });
});

describe('as configurações do produto', () => {
  it('no Clinics, a entrada do menu leva à página com só as seções que o papel alcança, e o rastro diz onde se está', async () => {
    subirServidor(pessoa(CLINICA));
    abrir('/');
    const menu = await lateral();
    // a entrada está no menu: o cabeçalho não repete o atalho
    expect(within(cabecalho()).queryByRole('link', { name: 'Configurações' })).toBeNull();
    fireEvent.click(menu.getByRole('link', { name: /^Configurações$/ }));
    expect(
      await screen.findByRole('heading', { name: 'Configurações', level: 1 }),
    ).toBeInTheDocument();
    const pagina = within(screen.getByRole('main'));
    for (const alcanca of [/^Clínica/, /^Equipe/, /^Etiquetas e campos/]) {
      expect(pagina.getByRole('link', { name: alcanca })).toBeInTheDocument();
    }
    // sem a permissão de cada uma, e nada do CRM que a clínica não monta
    // (Uso e plano exige `workspace:read`, que esta pessoa não tem)
    for (const fora of [
      /^Privacidade e IA/,
      /^Auditoria/,
      /^Integrações/,
      /^Automações/,
      /^Uso e plano/,
    ]) {
      expect(pagina.queryByRole('link', { name: fora })).toBeNull();
    }
    // a subpágina: o menu marca Configurações e o rastro diz "Configurações › Campos"
    fireEvent.click(pagina.getByRole('link', { name: /^Campos$/ }));
    const rastro = within(await screen.findByRole('navigation', { name: 'Onde você está' }));
    expect(await rastro.findByText('Campos')).toBeInTheDocument();
    expect(rastro.getByText('Configurações')).toBeInTheDocument();
    expect(menu.getByRole('link', { name: /^Configurações$/ }).className).toMatch(/font-medium/);
  });

  it('no CRM, o atalho do cabeçalho leva à página (o menu dele não tem a entrada)', async () => {
    subirServidor(pessoa(CRM));
    abrir('/tags');
    await lateral();
    fireEvent.click(within(cabecalho()).getByRole('link', { name: 'Configurações' }));
    expect(
      await screen.findByRole('heading', { name: 'Configurações', level: 1 }),
    ).toBeInTheDocument();
  });

  it('sem nenhuma seção ao alcance do papel, nenhum atalho', async () => {
    subirServidor({ ...pessoa(CRM), permissions: [] });
    abrir('/tags');
    await lateral();
    expect(screen.queryByRole('link', { name: 'Configurações' })).toBeNull();
  });
});

describe('incompatibilidade de sessão', () => {
  it('a MESMA divergência de novo: a aba para e pede para atualizar, sem recarga e sem nova requisição', async () => {
    const recarregar = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload: recarregar });
    document.title = 'Tags · Empresa Fictícia · Veyra';
    const s = subirServidor(pessoa(CRM));
    // o servidor fala um escopo que este web não calcula (outra versão)
    s.escopoForcado = 'u-1:m-crm';
    abrir('/tags');
    expect(
      await screen.findByRole('heading', { name: 'Atualize a página para continuar' }),
    ).toBeInTheDocument();
    // o título neutro é gravado num efeito, logo depois de a tela montar
    await waitFor(() => expect(document.title).toBe('Veyra'));
    const depois = s.chamadas.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chamadas.length).toBe(depois);
    expect(recarregar).not.toHaveBeenCalled();
    expect(s.chamadas.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

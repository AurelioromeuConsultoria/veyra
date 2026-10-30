import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppShell } from '../../components/layout/AppShell';
import { GlobalSearch } from '../../components/layout/GlobalSearch';
import { ExperienceProvider } from '../../lib/experience';
import { ME_KEY } from '../../lib/session';
import { clinicsExperience } from './experience';
import { crmExperience } from '../../experiences/crm';
import { SettingsPage } from '../../pages/Settings';
import { ClinicsAiReleasesPage, RELEASE_REASON_LABELS } from './AiReleasesPage';
import { ACCOUNT_LINK_NOTICE, ProfessionalsTab } from './catalog/ProfessionalsTab';
import { ClinicsCatalogPage } from './CatalogPage';

// o cabeçalho tem seus próprios dados (notificações, busca); aqui só a lateral
vi.mock('../../components/layout/AppHeader', () => ({ AppHeader: () => null }));

type Resposta = { status?: number; body?: unknown; pendente?: boolean };
type Rota = Resposta | ((corpo: unknown) => Resposta | Promise<Resposta>);

/** fetch falso por rota ("GET /api/…"); registra toda chamada, em ordem. */
function mockApi(rotas: Record<string, Rota>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      chamadas.push(chave);
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => chave.startsWith(prefixo));
      const definida: Rota = rota
        ? rotas[rota]
        : { status: 404, body: { message: `sem mock: ${chave}` } };
      const resposta =
        typeof definida === 'function'
          ? await definida(init?.body ? JSON.parse(String(init.body)) : undefined)
          : definida;
      if (resposta.pendente) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(resposta.body ?? {}), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

/** Promessa controlada pelo teste: segura uma resposta até `soltar`. */
function adiada<T>() {
  let soltar!: (valor: T) => void;
  const promessa = new Promise<T>((resolve) => (soltar = resolve));
  return { promessa, soltar };
}

const usuario = (permissions: string[]) => ({
  id: 'u1',
  name: 'Dona da Clínica',
  email: 'dona@clinica.test',
  activeMembership: {
    membershipId: 'm1',
    workspaceId: 'w1',
    workspaceName: 'Clínica',
    workspaceSlug: 'clinica',
    roleName: 'Owner',
    status: 'active',
  },
  permissions,
  memberships: [],
});
const LEITURA = ['clinics:catalog:read'];
const GESTAO = ['clinics:catalog:read', 'clinics:catalog:manage', 'members:read'];
const doCatalogo = (chamadas: string[]) =>
  chamadas.filter((c) => /\/api\/(clinics\/(services|professionals|units)|members)/.test(c));

function renderizar(
  ui: ReactNode,
  caminho = '/',
  queryClient = novoCliente(),
  experiencia = clinicsExperience,
) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[caminho]}>
        <ExperienceProvider value={experiencia}>{ui}</ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}
/** só a barra lateral — a página também tem o eyebrow "Clínica" */
const lateral = () => within(screen.getByRole('navigation', { name: 'Principal' }));
const novoCliente = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

afterEach(() => vi.unstubAllGlobals());

describe('Clinics no web — o menu é da experiência; a página só consulta com status ATIVO confirmado e permissão', () => {
  it('o menu do Clinics é da EXPERIÊNCIA (ADR-055): no CRM ele não aparece, nem com o vertical ativo', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(GESTAO) },
      'GET /api/clinics/status': { body: { active: true } },
    });
    renderizar(
      <AppShell manifestos={[crmExperience, clinicsExperience]} />,
      '/',
      novoCliente(),
      crmExperience,
    );
    await lateral().findByRole('link', { name: 'Hoje' });
    expect(lateral().queryByRole('link', { name: 'Catálogo' })).toBeNull();
    expect(lateral().queryByText('Clínica')).toBeNull();
  });

  it('na experiência da clínica, o catálogo fica nas Configurações: a entrada do menu fica marcada nele, e o Hoje é o da clínica', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(GESTAO) },
      'GET /api/clinics/status': { body: { active: true } },
    });
    renderizar(<AppShell manifestos={[crmExperience, clinicsExperience]} />, '/clinics/catalog');
    const configuracoes = await lateral().findByRole('link', { name: 'Configurações' });
    expect(configuracoes).toHaveAttribute('href', '/settings');
    expect(configuracoes.className).toMatch(/font-medium/);
    expect(lateral().queryByRole('link', { name: 'Catálogo' })).toBeNull();
    // o Hoje é o da clínica; nada do CRM que não é dela
    expect(lateral().getByRole('link', { name: 'Hoje' })).toHaveAttribute('href', '/clinics/today');
    expect(lateral().queryByRole('link', { name: 'Empresas' })).toBeNull();
  });

  const casos: [string, Resposta, string[], RegExp][] = [
    ['status CARREGANDO', { pendente: true }, GESTAO, /Carregando/],
    [
      'status com ERRO',
      { status: 500, body: { message: 'x' } },
      GESTAO,
      /Não foi possível verificar/,
    ],
    ['vertical INATIVO', { body: { active: false } }, GESTAO, /não está ativo neste workspace/],
    [
      'ativo SEM permissão',
      { body: { active: true } },
      ['contacts:read'],
      /não tem acesso ao catálogo/,
    ],
  ];

  it.each(casos)(
    '%s: a página só explica, e nada do catálogo é consultado',
    async (_caso, status, permissoes, mensagem) => {
      const chamadas = mockApi({
        'GET /api/auth/me': { body: usuario(permissoes) },
        'GET /api/clinics/status': status,
      });
      // lateral e página na MESMA árvore: a mensagem da página prova que o
      // status já tem resposta (ou segue pendente) quando a lateral é conferida
      renderizar(
        <>
          <AppShell manifestos={[crmExperience, clinicsExperience]} />
          <ClinicsCatalogPage />
        </>,
        '/clinics/catalog',
      );
      expect(await screen.findByText(mensagem)).toBeInTheDocument();
      await waitFor(() => expect(chamadas).toContain('GET /api/clinics/status'));
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(doCatalogo(chamadas)).toEqual([]);
    },
  );

  it('ATIVO e com permissão: NADA do catálogo sai antes da resposta do status; depois, o catálogo é consultado, e a busca o oferece', async () => {
    const status = adiada<Resposta>();
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(GESTAO) },
      'GET /api/clinics/status': () => status.promessa,
      'GET /api/clinics/services': { body: [] },
    });
    renderizar(
      <>
        <AppShell manifestos={[crmExperience, clinicsExperience]} />
        <ClinicsCatalogPage />
      </>,
      '/clinics/catalog',
    );
    await waitFor(() => expect(chamadas).toContain('GET /api/clinics/status'));
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(doCatalogo(chamadas)).toEqual([]);

    status.soltar({ body: { active: true } });
    expect(await lateral().findByRole('link', { name: 'Configurações' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(await screen.findByRole('tablist', { name: 'Partes do catálogo' })).toBeInTheDocument();
    await waitFor(() => expect(doCatalogo(chamadas)).toContain('GET /api/clinics/services'));

    renderizar(<GlobalSearch open onOpenChange={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Buscar no workspace'), {
      target: { value: 'profissionais' },
    });
    // a seção das Configurações é achada pela descrição, com o lugar onde mora
    expect(
      await screen.findByRole('option', { name: /Clínica.*Configurações/ }),
    ).toBeInTheDocument();
  });

  it('só LEITURA (recepção, Profissional): nenhum botão de ação', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(LEITURA) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/services': {
        body: [
          {
            id: 's1',
            name: 'Limpeza',
            durationMin: 60,
            priceCents: 15000,
            currency: 'BRL',
            archivedAt: null,
          },
        ],
      },
    });
    renderizar(<ClinicsCatalogPage />, '/clinics/catalog');
    expect(await screen.findByText('Limpeza')).toBeInTheDocument();
    expect(screen.getByText(/150,00/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Novo serviço/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Arquivar/ })).toBeNull();
  });
});

const S1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e01';
const S2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05';
const U1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e02';
const P1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e03';
const M9 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e04';

describe('drawer do profissional — limites de salvamento e o aviso do vínculo', () => {
  const ana = {
    id: P1,
    name: 'Ana',
    account: { membershipId: M9, active: true },
    serviceIds: [S1],
    workingHours: [{ unitId: U1, weekday: 1, startMinute: 480, endMinute: 720 }],
    archivedAt: null,
  };
  const limpeza = {
    id: S1,
    name: 'Limpeza',
    durationMin: 60,
    priceCents: null,
    currency: 'BRL',
    archivedAt: null,
  };
  const comum: Record<string, Rota> = {
    'GET /api/auth/me': { body: usuario(GESTAO) },
    'GET /api/clinics/professionals': { body: [ana] },
    'GET /api/clinics/services': { body: [limpeza] },
    'GET /api/clinics/units': {
      body: [{ id: U1, name: 'Unidade principal', timezone: 'America/Sao_Paulo' }],
    },
    'GET /api/members': {
      body: [
        {
          membershipId: M9,
          userId: 'u9',
          name: 'Bia',
          email: 'bia@x.test',
          roleId: 'r',
          roleName: 'Member',
          status: 'active',
          createdAt: '',
        },
      ],
    },
  };

  it('diz que vincular conta não muda papel nem permissões, e que o vínculo é salvo à parte', async () => {
    mockApi(comum);
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    expect(await screen.findByText(ACCOUNT_LINK_NOTICE)).toBeInTheDocument();
    expect(ACCOUNT_LINK_NOTICE).toMatch(/não muda o papel nem concede permissões/);
    expect(screen.getByText(/nome, serviços e horários são salvos juntos/)).toBeInTheDocument();
    expect(screen.getByText(/Conta vinculada — salva à parte/)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Bia/ })).toBeInTheDocument();
  });

  it('o perfil vai num pedido só; se o servidor recusa, a tela diz que NADA foi salvo', async () => {
    const pedidos: unknown[] = [];
    const chamadas = mockApi({
      ...comum,
      [`PUT /api/clinics/professionals/${P1}/profile`]: (corpo: unknown) => {
        pedidos.push(corpo);
        return { status: 400, body: { message: 'Unidade inexistente ou arquivada' } };
      },
    });
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar perfil' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nada foi salvo. Unidade inexistente ou arquivada',
    );
    expect(pedidos).toEqual([
      {
        name: 'Ana',
        serviceIds: [S1],
        intervals: [{ unitId: U1, weekday: 1, startMinute: 480, endMinute: 720 }],
      },
    ]);
    // nome, serviços e horários NUNCA em pedidos separados
    expect(
      chamadas.filter((c) => c.startsWith('PUT') && /\/(services|working-hours)$/.test(c)),
    ).toEqual([]);
  });

  it('sobreposição é recusada na tela pela MESMA regra do contrato, sem chamar o servidor', async () => {
    const chamadas = mockApi(comum);
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    // Ana já atende 08:00–12:00 na segunda; outro intervalo padrão é 08:00–12:00
    fireEvent.click(
      await screen.findByRole('button', { name: 'Acrescentar intervalo na segunda' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nada foi salvo. Intervalos sobrepostos na segunda',
    );
    expect(chamadas.some((c) => c.startsWith('PUT'))).toBe(false);
  });

  it('o editor NÃO monta enquanto os serviços carregam (salvar antes apagaria os serviços); depois, eles vêm marcados', async () => {
    const servicos = adiada<Resposta>();
    mockApi({ ...comum, 'GET /api/clinics/services': () => servicos.promessa });
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    expect(await screen.findByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar perfil' })).toBeNull();

    servicos.soltar({ body: [limpeza] });
    expect(await screen.findByRole('checkbox', { name: 'Limpeza' })).toBeChecked();
  });

  it('serviços que FALHAM ao carregar: o editor não monta, e nada pode ser salvo', async () => {
    const chamadas = mockApi({
      ...comum,
      'GET /api/clinics/services': { status: 500, body: { message: 'fora do ar' } },
    });
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    expect(
      await screen.findByText(/Não foi possível carregar serviços e unidades/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Salvar perfil' })).toBeNull();
    expect(chamadas.some((c) => c.startsWith('PUT') || c.startsWith('POST'))).toBe(false);
  });

  it('recarga que FALHA depois de salvar não troca a confirmação por erro (os dados carregados valem)', async () => {
    let chamadasDeServicos = 0;
    mockApi({
      ...comum,
      'GET /api/clinics/services': () =>
        ++chamadasDeServicos === 1
          ? { body: [limpeza] }
          : { status: 500, body: { message: 'fora do ar' } },
      [`PUT /api/clinics/professionals/${P1}/profile`]: { body: ana },
    });
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Salvar perfil' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Perfil salvo');
    await waitFor(() => expect(chamadasDeServicos).toBeGreaterThan(1));
    expect(screen.getByRole('status')).toHaveTextContent('Perfil salvo');
    expect(screen.queryByText(/Não foi possível carregar serviços/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Salvar perfil' })).toBeInTheDocument();
  });

  it('vínculo com serviço ARQUIVADO: a tela avisa, e o envio leva só os ativos', async () => {
    const pedidos: unknown[] = [];
    mockApi({
      ...comum,
      'GET /api/clinics/professionals': { body: [{ ...ana, serviceIds: [S1, S2] }] },
      [`PUT /api/clinics/professionals/${P1}/profile`]: (corpo: unknown) => {
        pedidos.push(corpo);
        return { body: { ...ana, serviceIds: [S1] } };
      },
    });
    renderizar(<ProfessionalsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar Ana' }));
    expect(
      await screen.findByText('1 serviço arquivado deixa de estar habilitado ao salvar.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Perfil salvo');
    expect(pedidos).toEqual([expect.objectContaining({ serviceIds: [S1] })]);
  });

  it('quem gerencia o catálogo SEM `members:read` não vê nome de membro — nem do cache de outra tela', async () => {
    const chamadas = mockApi({
      ...comum,
      'GET /api/auth/me': { body: usuario(['clinics:catalog:read', 'clinics:catalog:manage']) },
    });
    const queryClient = novoCliente();
    // cache deixado por outra tela (ex.: Contatos), de quando havia permissão
    queryClient.setQueryData(['members'], (comum['GET /api/members'] as Resposta).body);
    renderizar(<ProfessionalsTab />, '/', queryClient);
    expect(await screen.findByText('Conta vinculada')).toBeInTheDocument();
    expect(screen.queryByText('Bia')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Editar Ana' }));
    expect(
      await screen.findByText(/exige também permissão para ver os membros/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Bia/ })).toBeNull();
    expect(chamadas).not.toContain('GET /api/members');
  });
});

const C1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e11';
const C2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e12';

describe('liberação para IA — porta, lista, conceder e revogar', () => {
  const RESTRICAO = ['clinics:restriction:manage', 'contacts:read'];
  const liberado = {
    contactId: C1,
    contactName: 'Fornecedora de Luvas',
    reason: 'supplier',
    releasedByMembershipId: 'm1',
    createdAt: '2026-10-19T12:00:00.000Z',
  };
  const dasLiberacoes = (chamadas: string[]) =>
    chamadas.filter((c) => /\/api\/(clinics\/(ai-releases|contacts)|contacts)/.test(c));

  it.each([
    ['status CARREGANDO', { pendente: true }, RESTRICAO, /Carregando/],
    ['vertical INATIVO', { body: { active: false } }, RESTRICAO, /não está ativo/],
    [
      'sem `contacts:read` (a lista traz nomes)',
      { body: { active: true } },
      ['clinics:restriction:manage'],
      /não tem acesso à liberação/,
    ],
    [
      'só o catálogo',
      { body: { active: true } },
      ['clinics:catalog:read', 'contacts:read'],
      /não tem acesso à liberação/,
    ],
  ] as [string, Resposta, string[], RegExp][])(
    '%s: só a mensagem, e nada da liberação é consultado',
    async (_caso, status, permissoes, mensagem) => {
      const chamadas = mockApi({
        'GET /api/auth/me': { body: usuario(permissoes) },
        'GET /api/clinics/status': status,
      });
      renderizar(<ClinicsAiReleasesPage />, '/clinics/ai-releases');
      expect(await screen.findByText(mensagem)).toBeInTheDocument();
      expect(dasLiberacoes(chamadas)).toEqual([]);
    },
  );

  it('as Configurações mostram cada seção só a quem tem TODAS as chaves da rota', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(['clinics:catalog:read']) },
      'GET /api/clinics/status': { body: { active: true } },
    });
    renderizar(<SettingsPage />, '/settings');
    expect(await screen.findByRole('link', { name: /^Clínica/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Privacidade e IA/ })).toBeNull();
  });

  it('"Privacidade e IA" exige as DUAS chaves da rota: só `restriction:manage`, sem `contacts:read`, não aparece', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(['clinics:restriction:manage']) },
      'GET /api/clinics/status': { body: { active: true } },
    });
    // a sessão já carregada, como no app: o "nenhuma" não pode passar no
    // instante antes de ela chegar
    const queryClient = novoCliente();
    queryClient.setQueryData(ME_KEY, usuario(['clinics:restriction:manage']));
    renderizar(<SettingsPage />, '/settings', queryClient);
    expect(
      screen.getByText('Nenhuma configuração disponível para o seu papel.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Privacidade e IA/ })).toBeNull();
  });

  it('RECARGA do status que falha depois de confirmar: a página volta a só explicar e não consulta mais', async () => {
    let consultas = 0;
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RESTRICAO) },
      'GET /api/clinics/status': () =>
        ++consultas === 1 ? { body: { active: true } } : { status: 500, body: { message: 'x' } },
      'GET /api/clinics/ai-releases': { body: { items: [], nextCursor: null } },
    });
    const queryClient = renderizar(<ClinicsAiReleasesPage />, '/clinics/ai-releases');
    const daLista = () => chamadas.filter((c) => c.startsWith('GET /api/clinics/ai-releases'));
    await waitFor(() => expect(daLista().length).toBeGreaterThan(0));
    const antes = daLista().length;
    await act(() => queryClient.invalidateQueries({ queryKey: ['clinics', 'status'] }));
    expect(await screen.findByText(/Não foi possível verificar/)).toBeInTheDocument();
    expect(daLista().length).toBe(antes);
    expect(consultas).toBe(2);
  });

  it('com as duas permissões: a lateral leva à tela; a lista traz nome e motivo; revogar apaga e recarrega', async () => {
    let lista = [liberado];
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RESTRICAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/ai-releases': () => ({ body: { items: lista, nextCursor: null } }),
      [`DELETE /api/clinics/contacts/${C1}/ai-release`]: () => {
        lista = [];
        return { body: { ok: true } };
      },
    });
    renderizar(
      <>
        <AppShell manifestos={[crmExperience, clinicsExperience]} />
        <ClinicsAiReleasesPage />
      </>,
      '/clinics/ai-releases',
    );
    // a tela mora nas Configurações: a entrada do menu fica marcada
    expect(await lateral().findByRole('link', { name: 'Configurações' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(lateral().queryByRole('link', { name: 'Liberação para IA' })).toBeNull();
    expect(await screen.findByText('Fornecedora de Luvas')).toBeInTheDocument();
    expect(screen.getByText(RELEASE_REASON_LABELS.supplier)).toBeInTheDocument();
    expect(screen.getByText(/Paciente nunca é liberável/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Revogar liberação de Fornecedora de Luvas' }),
    );
    expect(await screen.findByText('Nenhum contato liberado.')).toBeInTheDocument();
    expect(chamadas).toContain(`DELETE /api/clinics/contacts/${C1}/ai-release`);
  });

  it('lista longa: "Carregar mais" segue o cursor e acrescenta, sem repetir', async () => {
    const outro = { ...liberado, contactId: C2, contactName: 'Parceira de Eventos' };
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RESTRICAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/ai-releases?cursor=c2': { body: { items: [outro], nextCursor: null } },
      'GET /api/clinics/ai-releases': { body: { items: [liberado], nextCursor: 'c2' } },
    });
    renderizar(<ClinicsAiReleasesPage />, '/clinics/ai-releases');
    expect(await screen.findByText('Fornecedora de Luvas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Parceira de Eventos')).toBeInTheDocument();
    expect(screen.getByText('Fornecedora de Luvas')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(chamadas.filter((c) => c.includes('ai-releases'))).toEqual([
      'GET /api/clinics/ai-releases',
      'GET /api/clinics/ai-releases?cursor=c2',
    ]);
  });

  it('quem lê pacientes vê o paciente como NÃO LIBERÁVEL, sem poder escolhê-lo', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario([...RESTRICAO, 'clinics:schedule:read']) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/ai-releases': { body: { items: [], nextCursor: null } },
      [`GET /api/clinics/patients?contactIds=${C2}`]: {
        body: [{ id: 'p1', contactId: C2, name: 'Paciente Fictícia', createdAt: '' }],
      },
      'GET /api/contacts?': {
        body: { items: [{ id: C2, name: 'Paciente Fictícia' }], total: 1, page: 1, pageSize: 8 },
      },
    });
    renderizar(<ClinicsAiReleasesPage />, '/clinics/ai-releases');
    fireEvent.click(await screen.findByRole('button', { name: /Liberar contato/ }));
    fireEvent.change(await screen.findByLabelText(/^Buscar contato/), { target: { value: 'Pac' } });
    expect(await screen.findByText(/paciente — não liberável/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Paciente Fictícia/ })).toBeDisabled();
    // só os contatos da busca: a lista inteira de pacientes nunca é baixada
    expect(chamadas.filter((c) => c.includes('/api/clinics/patients'))).toEqual([
      `GET /api/clinics/patients?contactIds=${C2}`,
    ]);
  });

  it('conceder: só envia com contato E motivo da lista fechada; paciente volta 409 e a tela mostra o motivo', async () => {
    const pedidos: unknown[] = [];
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RESTRICAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/ai-releases': { body: { items: [], nextCursor: null } },
      'GET /api/contacts?': {
        body: {
          items: [{ id: C2, name: 'Paciente Fictícia' }],
          total: 1,
          page: 1,
          pageSize: 8,
        },
      },
      [`POST /api/clinics/contacts/${C2}/ai-release`]: (corpo: unknown) => {
        pedidos.push(corpo);
        return {
          status: 409,
          body: { message: 'Contato é paciente da clínica: não pode ser liberado para IA' },
        };
      },
    });
    renderizar(<ClinicsAiReleasesPage />, '/clinics/ai-releases');
    fireEvent.click(await screen.findByRole('button', { name: /Liberar contato/ }));
    const enviar = await screen.findByRole('button', { name: 'Liberar para IA' });
    expect(enviar).toBeDisabled();

    // uma letra não busca
    fireEvent.change(screen.getByLabelText(/^Buscar contato/), { target: { value: 'P' } });
    fireEvent.change(screen.getByLabelText(/^Buscar contato/), { target: { value: 'Pac' } });
    fireEvent.click(await screen.findByRole('radio', { name: /Paciente Fictícia/ }));
    expect(chamadas.filter((c) => c.startsWith('GET /api/contacts'))).toEqual([
      'GET /api/contacts?search=Pac&pageSize=8&status=active',
    ]);
    expect(enviar).toBeDisabled(); // falta o motivo

    // sem `schedule:read`, nenhuma consulta de pacientes
    expect(chamadas.some((c) => c.includes('/api/clinics/patients'))).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Motivo/), { target: { value: 'partner' } });
    fireEvent.click(enviar);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Contato é paciente da clínica: não pode ser liberado para IA',
    );
    expect(pedidos).toEqual([{ reason: 'partner' }]);
    expect(enviar).toBeEnabled();
    // a escolha não sobrevive a uma busca nova: nada de enviar quem sumiu da lista
    fireEvent.change(screen.getByLabelText(/^Buscar contato/), { target: { value: 'Outra' } });
    expect(enviar).toBeDisabled();
  });
});

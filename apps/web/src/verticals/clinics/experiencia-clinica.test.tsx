import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { AppShell } from '../../components/layout/AppShell';
import { GlobalSearch } from '../../components/layout/GlobalSearch';
import { ExperienceProvider } from '../../lib/experience';
import { ME_KEY } from '../../lib/session';
import { clinicsExperience } from './experience';
import { ClinicsTodayPage } from './hoje/HojePage';
import { ClinicsLeadsPage } from './InteressadosPage';
import { ContatoDaPessoa } from './pessoa/ContatoDaPessoa';
import { ClinicsPersonPage } from './pessoa/PessoaPage';

// o cabeçalho tem os seus próprios dados (notificações); aqui só a lateral
vi.mock('../../components/layout/AppHeader', () => ({ AppHeader: () => null }));

/**
 * A experiência da clínica (ADR-055, E-3, adendos 3 e 4): o Hoje por chave e
 * por papel, dizendo exatamente o que sabe e no fuso da UNIDADE; Interessados
 * paginados no servidor, com a passagem explícita para paciente; a pessoa, que
 * não revela o vínculo a quem não pode consultá-lo; e a ficha com o contato,
 * cada parte com TODAS as chaves da sua rota. Dados fictícios.
 */

type Resposta = { status?: number; body?: unknown; pendente?: boolean };
type Rota = Resposta | ((corpo: unknown) => Resposta | Promise<Resposta>);

function mockApi(rotas: Record<string, Rota>) {
  const chamadas: string[] = [];
  const corpos: { chave: string; corpo: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      chamadas.push(chave);
      const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (corpo !== undefined) corpos.push({ chave, corpo });
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => chave.startsWith(prefixo));
      const definida: Rota = rota
        ? rotas[rota]
        : { status: 404, body: { message: `sem mock: ${chave}` } };
      const resposta = typeof definida === 'function' ? await definida(corpo) : definida;
      if (resposta.pendente) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(resposta.body ?? {}), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { chamadas, corpos };
}

const usuario = (permissions: string[]) => ({
  id: 'u1',
  name: 'Pessoa da Clínica',
  email: 'pessoa@clinica.test',
  activeMembership: {
    membershipId: 'm1',
    workspaceId: 'w1',
    workspaceName: 'Clínica',
    workspaceSlug: 'clinica',
    roleName: 'Member',
    status: 'active',
  },
  permissions,
  memberships: [],
  experience: { key: 'clinics', status: 'ready' },
});

/** os papéis de hoje, pelas chaves (o nome "Recepção" para o Member é a D7) */
const RECEPCAO = [
  'workspace:read',
  'members:read',
  'contacts:read',
  'contacts:write',
  'pipelines:read',
  'conversations:read',
  'consents:read',
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:schedule:write',
];
const PROFISSIONAL = [
  'workspace:read',
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:care:read',
  'clinics:care:write',
];
const CONVIDADO = ['workspace:read', 'contacts:read', 'pipelines:read', 'conversations:read'];

function Local() {
  const l = useLocation();
  return <p data-testid="local">{l.pathname + l.search}</p>;
}

/**
 * A sessão JÁ carregada, como no app (o shell só monta uma tela de produto com
 * ela): sem isso, uma tela "sem acesso" passaria no instante antes de a sessão
 * chegar, mesmo com a regra quebrada.
 */
let sessaoAtual: ReturnType<typeof usuario> | null = null;

function renderizar(ui: ReactNode, caminho = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (sessaoAtual) queryClient.setQueryData(ME_KEY, sessaoAtual);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[caminho]}>
        <ExperienceProvider value={clinicsExperience}>
          <Routes>
            <Route path="/clinics/patient" element={<Local />} />
            <Route path="*" element={ui} />
          </Routes>
        </ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  sessaoAtual = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── O Hoje ───────────────────────────────────────────────────────────────────

/**
 * 01:30 UTC de 15/03 = 22:30 de QUINTA, 14/03, em São Paulo: o "hoje" da
 * unidade não é o do relógio do navegador (UTC nos testes).
 */
const AGORA = new Date('2030-03-15T01:30:00Z');
const UNIDADE = { id: 'un1', name: 'Centro', timezone: 'America/Sao_Paulo', active: true };

const horario = (
  id: string,
  startsAt: string,
  status: string,
  professionalId = 'pr2',
  patientName = `Paciente ${id}`,
) => ({
  id,
  patientId: `p-${id}`,
  patientName,
  professionalId,
  professionalName: professionalId === 'pr1' ? 'Dra. Ana Fictícia' : 'Dr. Beto Fictício',
  serviceId: 'sv',
  serviceName: 'Limpeza',
  unitId: 'un1',
  startsAt,
  endsAt: startsAt,
  localDate: '2030-03-14',
  localStart: startsAt.slice(11, 16),
  localEnd: startsAt.slice(11, 16),
  status,
  cancelReason: null,
});

const HOJE = [
  horario('a1', '2030-03-14T12:00:00Z', 'scheduled'), // passou: pendente
  horario('a2', '2030-03-14T14:30:00Z', 'confirmed'), // passou: pendente
  horario('a3', '2030-03-14T23:00:00Z', 'arrived', 'pr1'), // chegou
  horario('a4', '2030-03-15T02:00:00Z', 'confirmed', 'pr1'), // 23:00 local: a seguir
  horario('a5', '2030-03-14T13:00:00Z', 'attended'),
  horario('a6', '2030-03-14T15:00:00Z', 'no_show'),
  horario('a7', '2030-03-14T16:00:00Z', 'canceled'),
];
const AMANHA = [
  ...Array.from({ length: 7 }, (_, i) => horario(`b${i}`, `2030-03-15T1${i}:00:00Z`, 'scheduled')),
  horario('b9', '2030-03-15T20:00:00Z', 'confirmed'),
];
const retorno = (i: number) => ({
  id: `r${i}`,
  patientName: `Retorno ${i}`,
  dueDate: '2030-03-01',
  status: 'pending',
  overdue: true,
  assignee: i === 0 ? { membershipId: 'm2', name: 'Dra. Ana Fictícia', hasAccess: true } : null,
  appointment: null,
});
const conversa = (id: string, nome: string, janela: string | null) => ({
  id,
  contactName: nome,
  status: 'open',
  lastMessageAt: '2030-03-15T01:00:00Z',
  windowExpiresAt: janela,
});

function rotasDoHoje(extra: Record<string, Rota> = {}) {
  return mockApi({
    'GET /api/clinics/status': { body: { active: true } },
    'GET /api/clinics/units': { body: [UNIDADE] },
    'GET /api/clinics/professionals': {
      body: [
        { id: 'pr1', name: 'Dra. Ana Fictícia', account: { membershipId: 'm1', active: true } },
        { id: 'pr2', name: 'Dr. Beto Fictício', account: null },
      ],
    },
    'GET /api/clinics/appointments?date=2030-03-14': { body: HOJE },
    'GET /api/clinics/appointments?date=2030-03-15': { body: AMANHA },
    'GET /api/clinics/outreach/candidates': {
      body: [
        { request: { id: 'q1', state: 'draft' } },
        { request: { id: 'q2', state: 'draft' } },
        { request: { id: 'q3', state: 'sent' } },
        { request: null },
      ],
    },
    'GET /api/clinics/returns': { body: Array.from({ length: 101 }, (_, i) => retorno(i)) },
    'GET /api/conversations': {
      body: {
        items: [
          conversa('cv1', 'Bia Fictícia', '2030-03-15T03:30:00Z'),
          conversa('cv2', 'Caio Fictício', '2030-03-15T00:30:00Z'), // a janela já fechou
          conversa('cv3', 'Davi Fictício', '2030-03-15T10:30:00Z'),
        ],
        nextCursor: 'mais',
      },
    },
    'GET /api/clinics/metrics/no-show': {
      body: { attended: 27, noShow: 3, rate: 0.1, pendingPast: 2, canceled: 1 },
    },
    ...extra,
  });
}

const cartao = (nome: string) => within(screen.getByRole('region', { name: nome }));

describe('o Hoje da clínica', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(AGORA);
  });

  it('recepção: o dia da UNIDADE, separado pelo que se sabe, com contagens exatas; confirmar à mão não é enviar', async () => {
    const { chamadas, corpos } = rotasDoHoje({
      'POST /api/clinics/appointments/a1/status': { body: horario('a1', '', 'confirmed') },
      // a recepção não é profissional: a conta ligada é a de outra pessoa
      'GET /api/clinics/professionals': {
        body: [
          {
            id: 'pr1',
            name: 'Dra. Ana Fictícia',
            account: { membershipId: 'm-ana', active: true },
          },
          { id: 'pr2', name: 'Dr. Beto Fictício', account: null },
        ],
      },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsTodayPage />, '/clinics/today');

    // o "hoje" é o da unidade (quinta, 14), não o do navegador (sexta, 15, em UTC)
    expect(await screen.findByText('quinta-feira, 14 de março')).toBeInTheDocument();
    const agenda = await screen.findByRole('region', { name: 'Agenda de hoje' });
    expect(
      await within(agenda).findByText('1 atendido · 1 falta · 1 chegou · 2 pendentes · 1 a seguir'),
    ).toBeInTheDocument();
    expect(within(agenda).getByText(/^Pendentes/)).toBeInTheDocument();
    expect(within(agenda).getByText('Chegaram')).toBeInTheDocument();
    expect(within(agenda).getByText('A seguir')).toBeInTheDocument();
    // sem conta ligada a um profissional, não há "Minha agenda" inventada
    expect(within(agenda).queryByText('Minha agenda')).toBeNull();
    // "chegou" não é "em atendimento", e a recepção não registra atendimento
    expect(within(agenda).queryByText(/em atendimento/i)).toBeNull();
    expect(within(agenda).queryByRole('button', { name: 'Registrar atendimento' })).toBeNull();

    const confirmar = cartao('Confirmar amanhã');
    expect(await confirmar.findByText('7 ainda não confirmados · 15/03')).toBeInTheDocument();
    expect(confirmar.getByText('e mais 2')).toBeInTheDocument();
    expect(
      confirmar.getByText(/2 pedidos de confirmação por WhatsApp esperando aprovação/),
    ).toBeInTheDocument();
    expect(confirmar.getByRole('link', { name: 'Revisar envios' })).toHaveAttribute(
      'href',
      '/clinics/outreach',
    );

    // os retornos: 101 pedidos, a contagem não finge ser exata
    const retornos = cartao('Retornos vencidos');
    expect(await retornos.findByText('mais de 100')).toBeInTheDocument();
    expect(retornos.getAllByRole('listitem')).toHaveLength(5);

    // as conversas: a seleção declarada, sem total, e só as de janela aberta
    const conversas = cartao('Conversas com janela aberta');
    expect(conversas.getByText('entre as 50 abertas mais recentes')).toBeInTheDocument();
    expect(await conversas.findByText('Bia Fictícia')).toBeInTheDocument();
    expect(conversas.getByText('Davi Fictício')).toBeInTheDocument();
    expect(conversas.queryByText('Caio Fictício')).toBeNull();

    // a semana da unidade: de segunda (11) a quinta (14); o fim é exclusivo
    expect(await cartao('Faltas da semana').findByText('3')).toBeInTheDocument();
    expect(chamadas).toContain(
      'GET /api/clinics/metrics/no-show?from=2030-03-11&to=2030-03-15&unitId=un1',
    );

    // "Marcar como confirmado" muda o agendamento — e nada é enviado
    fireEvent.click(within(agenda).getAllByRole('button', { name: 'Marcar como confirmado' })[0]);
    await waitFor(() =>
      expect(corpos).toContainEqual({
        chave: 'POST /api/clinics/appointments/a1/status',
        corpo: { to: 'confirmed' },
      }),
    );
    expect(chamadas.some((c) => /outreach\/(requests|approve)/.test(c))).toBe(false);
    // o que muda o dia muda as faltas da semana: elas são relidas
    const faltas = () => chamadas.filter((c) => c.includes('/api/clinics/metrics/no-show')).length;
    await waitFor(() => expect(faltas()).toBeGreaterThanOrEqual(2));
  });

  it('quem confirma mas não vê consentimentos: "Confirmar amanhã" sem a linha dos pedidos, e a rota dos candidatos nem é chamada', async () => {
    const { chamadas } = rotasDoHoje();
    mockSessao(RECEPCAO.filter((k) => k !== 'consents:read'));
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    const confirmar = within(await screen.findByRole('region', { name: 'Confirmar amanhã' }));
    expect(await confirmar.findByText('7 ainda não confirmados · 15/03')).toBeInTheDocument();
    expect(confirmar.queryByText(/esperando aprovação/)).toBeNull();
    expect(confirmar.queryByRole('link', { name: 'Revisar envios' })).toBeNull();
    expect(chamadas.some((c) => c.includes('/api/clinics/outreach/'))).toBe(false);
  });

  it('Profissional ligado à conta: "Minha agenda" e a "Agenda da equipe" à parte; só os cartões e as ações das chaves dele, e nenhuma consulta de conversa, envio ou contato', async () => {
    const { chamadas } = rotasDoHoje();
    mockSessao(PROFISSIONAL);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    const agenda = await screen.findByRole('region', { name: 'Agenda de hoje' });
    expect(await within(agenda).findByRole('button', { name: /Minha agenda/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(agenda).getByRole('button', { name: /Agenda da equipe/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // a3 chegou e é dele: registra o atendimento; não confirma nem marca chegada
    expect(
      within(agenda).getByRole('button', { name: 'Registrar atendimento' }),
    ).toBeInTheDocument();
    expect(within(agenda).queryByRole('button', { name: 'Marcar como confirmado' })).toBeNull();
    expect(within(agenda).queryByRole('button', { name: 'Registrar chegada' })).toBeNull();

    expect(await screen.findByRole('region', { name: 'Retornos vencidos' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Faltas da semana' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Confirmar amanhã' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Conversas com janela aberta' })).toBeNull();
    await waitFor(() =>
      expect(chamadas.some((c) => c.startsWith('GET /api/clinics/returns'))).toBe(true),
    );
    expect(
      chamadas.filter((c) =>
        /\/api\/(conversations|contacts|deals|pipelines|clinics\/outreach)/.test(c),
      ),
    ).toEqual([]);
  });

  it('a agenda do dia acima do teto: o cartão diz a recusa do servidor, sem contagem', async () => {
    rotasDoHoje({
      'GET /api/clinics/appointments?date=2030-03-14': {
        status: 422,
        body: { message: 'Este dia tem mais de 500 horários e não cabe numa lista só.' },
      },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    const agenda = within(await screen.findByRole('region', { name: 'Agenda de hoje' }));
    expect(
      await agenda.findByText('Este dia tem mais de 500 horários e não cabe numa lista só.'),
    ).toBeInTheDocument();
    expect(agenda.queryByText(/atendido/)).toBeNull();
  });

  it('sem unidade cadastrada: o Hoje diz, em vez de sumir com os cartões do dia; os retornos ficam por unidade', async () => {
    const { chamadas } = rotasDoHoje({ 'GET /api/clinics/units': { body: [] } });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    expect(await screen.findByText(/ainda não tem unidade/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agenda de hoje' })).toBeNull();
    // sem unidade conhecida, os retornos são de todas, e o cartão diz
    const retornos = within(await screen.findByRole('region', { name: 'Retornos vencidos' }));
    expect(await retornos.findByText('mais de 100 · todas as unidades')).toBeInTheDocument();
    expect(
      chamadas.some((c) => c.startsWith('GET /api/clinics/returns') && c.includes('unitId')),
    ).toBe(false);
  });

  it('com a unidade: os retornos são os DELA', async () => {
    const { chamadas } = rotasDoHoje();
    mockSessao(RECEPCAO);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    const retornos = within(await screen.findByRole('region', { name: 'Retornos vencidos' }));
    expect(await retornos.findByText('mais de 100')).toBeInTheDocument();
    expect(
      chamadas.some((c) => c.startsWith('GET /api/clinics/returns') && c.includes('unitId=un1')),
    ).toBe(true);
  });

  it('Profissional SEM vínculo de conta: nada de "Minha agenda" — só a da equipe, aberta', async () => {
    rotasDoHoje({
      'GET /api/clinics/professionals': {
        body: [{ id: 'pr1', name: 'Dra. Ana Fictícia', account: null }],
      },
    });
    mockSessao(PROFISSIONAL);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    const agenda = await screen.findByRole('region', { name: 'Agenda de hoje' });
    expect(await within(agenda).findByRole('button', { name: /Agenda da equipe/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(agenda).queryByText(/Minha agenda/)).toBeNull();
  });

  it('sem as chaves do Clinics (Guest): só o cartão das conversas, e nada do vertical é consultado', async () => {
    const { chamadas } = rotasDoHoje();
    mockSessao(CONVIDADO);
    renderizar(<ClinicsTodayPage />, '/clinics/today');
    expect(
      await screen.findByRole('region', { name: 'Conversas com janela aberta' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agenda de hoje' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Retornos vencidos' })).toBeNull();
    expect(chamadas.filter((c) => /\/api\/clinics\/(?!status)/.test(c))).toEqual([]);
  });
});

// ── Interessados ─────────────────────────────────────────────────────────────

const lead = (id: string, name: string) => ({ id, name, createdAt: '2030-03-10T12:00:00Z' });

describe('Interessados', () => {
  it('paginados no servidor: "Carregar mais" pede a página seguinte pelo cursor', async () => {
    const { chamadas } = mockApi({
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/leads?limit=50&cursor=c2': {
        body: { items: [lead('c3', 'Carla Fictícia')], nextCursor: null },
      },
      'GET /api/clinics/leads?limit=50': {
        body: { items: [lead('c1', 'Ana Fictícia'), lead('c2', 'Bia Fictícia')], nextCursor: 'c2' },
      },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsLeadsPage />, '/clinics/leads');
    expect(await screen.findByRole('link', { name: 'Ana Fictícia' })).toHaveAttribute(
      'href',
      '/clinics/person?id=c1',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Carla Fictícia')).toBeInTheDocument();
    expect(screen.getByText('Ana Fictícia')).toBeInTheDocument();
    expect(chamadas).toContain('GET /api/clinics/leads?limit=50&cursor=c2');
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).toBeNull();
  });

  it('"Tornar paciente" é explícito: as consequências antes, a rota de pacientes, e a ficha depois', async () => {
    const { corpos } = mockApi({
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/leads': {
        body: { items: [lead('c1', 'Ana Fictícia')], nextCursor: null },
      },
      'POST /api/clinics/patients': {
        body: { id: 'p-novo', name: 'Ana Fictícia', createdAt: '2030-03-15T01:30:00Z' },
      },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsLeadsPage />, '/clinics/leads');
    fireEvent.click(await screen.findByRole('button', { name: 'Tornar paciente' }));
    expect(await screen.findByText('Ao tornar paciente:')).toBeInTheDocument();
    expect(corpos).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar: tornar paciente' }));
    expect(await screen.findByTestId('local')).toHaveTextContent('/clinics/patient?id=p-novo');
    expect(corpos).toEqual([{ chave: 'POST /api/clinics/patients', corpo: { contactId: 'c1' } }]);
  });

  it('sem `clinics:schedule:read` (só contatos): a lista não existe para ela, e a rota nem é chamada', async () => {
    const { chamadas } = mockApi({ 'GET /api/clinics/status': { body: { active: true } } });
    mockSessao(CONVIDADO);
    renderizar(<ClinicsLeadsPage />, '/clinics/leads');
    expect(
      await screen.findByText('Você não tem acesso aos interessados da clínica.'),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.includes('/api/clinics/leads'))).toBe(false);
  });

  it('sem `contacts:write`, nenhum "Novo interessado"; sem criar ficha, nenhum "Tornar paciente"', async () => {
    mockApi({
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/leads': {
        body: { items: [lead('c1', 'Ana Fictícia')], nextCursor: null },
      },
    });
    mockSessao(['contacts:read', 'clinics:schedule:read']);
    renderizar(<ClinicsLeadsPage />, '/clinics/leads');
    expect(await screen.findByText('Ana Fictícia')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Novo interessado/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tornar paciente' })).toBeNull();
  });
});

// ── A pessoa ─────────────────────────────────────────────────────────────────

const C1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e01';
const contato = {
  id: C1,
  name: 'Marina Fictícia',
  emails: ['marina@exemplo.test'],
  phones: ['+5511999990000'],
  companyId: null,
  companyName: null,
  tags: [],
};

describe('a pessoa (o destino de um contato na clínica)', () => {
  it('quem consulta pacientes: se for paciente, vai à ficha', async () => {
    const { chamadas } = mockApi({
      [`GET /api/clinics/patients?contactIds=${C1}`]: {
        body: [{ id: 'p-9', contactId: C1, name: 'Marina Fictícia', createdAt: '2030-01-01' }],
      },
      [`GET /api/contacts/${C1}`]: { body: contato },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(await screen.findByTestId('local')).toHaveTextContent('/clinics/patient?id=p-9');
    expect(chamadas).toContain(`GET /api/clinics/patients?contactIds=${C1}`);
  });

  it('quem consulta pacientes e ela não é: interessado, com "Tornar paciente"', async () => {
    mockApi({
      [`GET /api/clinics/patients?contactIds=${C1}`]: { body: [] },
      [`GET /api/contacts/${C1}`]: { body: contato },
      'GET /api/conversations': { body: { items: [], nextCursor: null } },
      [`GET /api/contacts/${C1}/deals`]: { body: [] },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(
      await screen.findByRole('heading', { name: 'Marina Fictícia', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Clínica · Interessado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tornar paciente' })).toBeInTheDocument();
  });

  it('sem `clinics:schedule:read`: o vínculo nem é consultado, e a tela é a mesma para paciente e não paciente', async () => {
    const { chamadas } = mockApi({
      [`GET /api/contacts/${C1}`]: { body: contato },
      'GET /api/conversations': { body: { items: [], nextCursor: null } },
      [`GET /api/contacts/${C1}/deals`]: { body: [] },
    });
    mockSessao(CONVIDADO);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(
      await screen.findByRole('heading', { name: 'Marina Fictícia', level: 1 }),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.includes('/api/clinics/'))).toBe(false);
    expect(screen.queryByText(/Interessado|Paciente/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tornar paciente' })).toBeNull();
  });

  it('enquanto o vínculo é consultado, a tela só diz "Carregando…" — o nome não aparece antes da decisão', async () => {
    const { chamadas } = mockApi({
      [`GET /api/clinics/patients?contactIds=${C1}`]: { pendente: true },
      [`GET /api/contacts/${C1}`]: { body: contato },
    });
    // as chaves da ficha, e nenhuma das partes que consultariam mais rotas
    mockSessao(['contacts:read', 'clinics:schedule:read', 'clinics:catalog:read']);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    await waitFor(() => expect(chamadas).toContain(`GET /api/contacts/${C1}`));
    await new Promise((r) => setTimeout(r, 50));
    // o contato já chegou; o vínculo, não: continua o carregamento, sem o nome
    expect(screen.getByText('Carregando…')).toBeInTheDocument();
    expect(screen.queryByText('Marina Fictícia')).toBeNull();
  });

  it('sem a chave do catálogo (a ficha a exige): o vínculo não é consultado', async () => {
    const { chamadas } = mockApi({
      [`GET /api/contacts/${C1}`]: { body: contato },
    });
    mockSessao(['contacts:read', 'clinics:schedule:read']);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(
      await screen.findByRole('heading', { name: 'Marina Fictícia', level: 1 }),
    ).toBeInTheDocument();
    expect(chamadas.some((c) => c.includes('/api/clinics/'))).toBe(false);
    expect(screen.queryByText(/Interessado/)).toBeNull();
  });

  it('o contato arquivado abre como "Arquivado", sem "Tornar paciente"', async () => {
    mockApi({
      [`GET /api/clinics/patients?contactIds=${C1}`]: { body: [] },
      [`GET /api/contacts/${C1}`]: { body: { ...contato, status: 'archived' } },
    });
    mockSessao(RECEPCAO);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(await screen.findByText('Clínica · Arquivado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tornar paciente' })).toBeNull();
  });

  it('sem `contacts:read`: nada é consultado nem mostrado', async () => {
    const { chamadas } = mockApi({});
    mockSessao(PROFISSIONAL);
    renderizar(<ClinicsPersonPage />, `/clinics/person?id=${C1}`);
    expect(
      await screen.findByText('Você não tem acesso aos dados deste contato.'),
    ).toBeInTheDocument();
    expect(chamadas.filter((c) => !c.startsWith('GET /api/auth/me'))).toEqual([]);
  });
});

// ── O contato na ficha ───────────────────────────────────────────────────────

describe('o contato na ficha e na pessoa: cada parte com TODAS as chaves da sua rota', () => {
  it('só `contacts:read`: os dados, sem consultar conversas, oportunidades nem consentimento', async () => {
    const { chamadas } = mockApi({ [`GET /api/contacts/${C1}`]: { body: contato } });
    mockSessao(['contacts:read']);
    renderizar(<ContatoDaPessoa contactId={C1} />);
    expect(await screen.findByText('+5511999990000')).toBeInTheDocument();
    expect(chamadas.filter((c) => !c.startsWith('GET /api/auth/me'))).toEqual([
      `GET /api/contacts/${C1}`,
    ]);
    expect(screen.queryByRole('heading', { name: 'Conversas' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Oportunidades' })).toBeNull();
  });

  it('sem `contacts:read`: nenhuma parte aparece e nenhuma consulta sai, nem a das conversas', async () => {
    const { chamadas } = mockApi({});
    mockSessao(['conversations:read', 'pipelines:read', 'consents:read']);
    renderizar(<ContatoDaPessoa contactId={C1} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('region', { name: 'Contato' })).toBeNull();
    expect(chamadas).toEqual([]);
  });

  it('com as chaves de cada parte: as conversas levam a Conversas e as oportunidades ao Funil', async () => {
    mockApi({
      [`GET /api/contacts/${C1}/deals`]: {
        body: [{ id: 'd1', title: 'Clareamento', status: 'open', amountCents: 50000 }],
      },
      [`GET /api/contacts/${C1}/consents`]: { body: { contactId: C1, purposes: [] } },
      [`GET /api/contacts/${C1}`]: { body: contato },
      // TODOS os estados (o padrão da rota seria só as abertas): a URL exata
      [`GET /api/conversations?contactId=${C1}&status=all&limit=5`]: {
        body: {
          items: [{ id: 'cv1', subject: 'Agendamento', lastMessageAt: '2030-03-14T12:00:00Z' }],
          nextCursor: null,
        },
      },
    });
    mockSessao(['contacts:read', 'conversations:read', 'pipelines:read']);
    renderizar(<ContatoDaPessoa contactId={C1} />);
    expect(await screen.findByRole('link', { name: 'Agendamento' })).toHaveAttribute(
      'href',
      '/inbox?c=cv1',
    );
    expect(await screen.findByText('Clareamento')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir o Funil' })).toHaveAttribute(
      'href',
      '/pipeline',
    );
  });

  it('"Editar dados" (com `contacts:write`) grava telefone e e-mail pelo Core — o que o consentimento precisa', async () => {
    const { corpos } = mockApi({
      [`PATCH /api/contacts/${C1}`]: { body: { ...contato, phones: ['+5511988887777'] } },
      [`GET /api/contacts/${C1}`]: { body: contato },
    });
    mockSessao(['contacts:read', 'contacts:write']);
    renderizar(<ContatoDaPessoa contactId={C1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar dados' }));
    fireEvent.change(screen.getByLabelText('Telefones'), {
      target: { value: '+5511988887777\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(corpos).toContainEqual({
        chave: `PATCH /api/contacts/${C1}`,
        // só o que mudou: os e-mails, iguais, não vão
        corpo: { name: 'Marina Fictícia', phones: ['+5511988887777'] },
      }),
    );
  });
});

describe('editar só o nome não reenvia telefones nem e-mails', () => {
  it('o PATCH leva só o nome: um número acrescentado por outra pessoa não é tirado (nem o consentimento dele)', async () => {
    const { corpos } = mockApi({
      [`PATCH /api/contacts/${C1}`]: { body: { ...contato, name: 'Marina Nova' } },
      [`GET /api/contacts/${C1}`]: { body: contato },
    });
    mockSessao(['contacts:read', 'contacts:write']);
    renderizar(<ContatoDaPessoa contactId={C1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Editar dados' }));
    fireEvent.change(screen.getByRole('textbox', { name: /^Nome/ }), {
      target: { value: 'Marina Nova' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(corpos).toContainEqual({
        chave: `PATCH /api/contacts/${C1}`,
        corpo: { name: 'Marina Nova' },
      }),
    );
  });
});

// ── O menu de cada papel ─────────────────────────────────────────────────────

describe('o menu de cada papel (as chaves de cada destino, TODAS)', () => {
  const lateral = () => within(screen.getByRole('navigation', { name: 'Principal' }));
  const abrirMenu = (permissoes: string[]) => {
    mockApi({ 'GET /api/clinics/status': { body: { active: true } } });
    mockSessao(permissoes);
    renderizar(<AppShell manifestos={[clinicsExperience]} />, '/clinics/today');
  };
  const links = () =>
    lateral()
      .queryAllByRole('link')
      .map((l) => l.textContent);
  const grupos = () =>
    lateral()
      .queryAllByRole('button')
      .map((b) => b.textContent);

  it('recepção (Member): as quatro entradas, os três grupos e as Configurações', async () => {
    abrirMenu(RECEPCAO);
    // a sessão chegou: o que exige chave já foi decidido
    await lateral().findByRole('link', { name: 'Configurações' });
    expect(links()).toEqual(['Hoje', 'Agenda', 'Pacientes', 'Conversas', 'Configurações']);
    expect(grupos()).toEqual(['Captação', 'Acompanhamento', 'Indicadores']);
  });

  it('Profissional: sem Conversas nem Captação; Acompanhamento só com Retornos, mostrado direto', async () => {
    abrirMenu(PROFISSIONAL);
    // a sessão chegou: o que exige chave já foi decidido
    await lateral().findByRole('link', { name: 'Configurações' });
    expect(links()).toEqual(['Hoje', 'Agenda', 'Pacientes', 'Retornos', 'Configurações']);
    expect(grupos()).toEqual(['Indicadores']);
  });

  it('Guest: sem as chaves do Clinics — Conversas, o Funil direto e as Configurações dele', async () => {
    abrirMenu(CONVIDADO);
    // a sessão chegou: o que exige chave já foi decidido
    await lateral().findByRole('link', { name: 'Configurações' });
    expect(links()).toEqual(['Hoje', 'Conversas', 'Funil', 'Configurações']);
    expect(grupos()).toEqual([]);
  });

  it('a busca de quem só lê contatos (sem a agenda): nenhum provedor, e nenhuma consulta de interessados', async () => {
    const { chamadas } = mockApi({});
    mockSessao(['contacts:read']);
    renderizar(<GlobalSearch open onOpenChange={() => undefined} />);
    fireEvent.change(await screen.findByLabelText('Buscar no workspace'), {
      target: { value: 'Marina' },
    });
    expect(await screen.findByPlaceholderText('Buscar uma seção do produto…')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(chamadas.some((c) => /\/api\/clinics\/(leads|patients)/.test(c))).toBe(false);
  });
});

/** A sessão: já no cache da tela, e o `/api/auth/me` a devolve se for relido. */
function mockSessao(permissions: string[]) {
  sessaoAtual = usuario(permissions);
  const fetchAtual = globalThis.fetch as unknown as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/me') {
        return new Response(JSON.stringify(usuario(permissions)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return fetchAtual(input, init);
    }),
  );
}

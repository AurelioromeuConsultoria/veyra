import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AppShell } from '../../components/layout/AppShell';
import { NavContributionsProvider } from '../../lib/nav';
import { ClinicsAgendaPage } from './AgendaPage';
import { CONSEQUENCIAS_DO_PACIENTE, ClinicsPatientsPage, TETO_DA_LISTA } from './PatientsPage';
import { useClinicsNavGroups } from './nav';

vi.mock('../../components/layout/AppHeader', () => ({ AppHeader: () => null }));

type Resposta = { status?: number; body?: unknown; pendente?: boolean };
type Rota = Resposta | ((corpo: unknown) => Resposta);

/** fetch falso por rota ("GET /api/…", prefixo mais longo vence); registra toda chamada. */
function mockApi(rotas: Record<string, Rota>) {
  const chamadas: { chave: string; corpo?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
      chamadas.push({ chave, corpo });
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => chave.startsWith(prefixo));
      const definida: Rota = rota
        ? rotas[rota]
        : { status: 404, body: { message: `sem mock: ${chave}` } };
      const resposta = typeof definida === 'function' ? definida(corpo) : definida;
      if (resposta.pendente) return new Promise<Response>(() => undefined);
      return new Response(JSON.stringify(resposta.body ?? {}), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

const usuario = (permissions: string[]) => ({
  id: 'u1',
  name: 'Pessoa Fictícia',
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
});

const RECEPCAO = [
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:schedule:write',
  'contacts:read',
];
const PROFISSIONAL = [
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:care:read',
  'clinics:care:write',
];

const U = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e02';
const S1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e01';
const ANA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e03';
const BIA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e04';
const PAC = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05';
const AG = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e06';
const ARQ = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e07';
const DIA = '2030-11-04'; // segunda
/** Como o cartão se identifica: hora, paciente e profissional. */
const QUEM = '09:00 Paciente Fictícia (Ana Fictícia)';

const comercial = [1, 2, 3, 4, 5].map((weekday) => ({
  unitId: U,
  weekday,
  startMinute: 480,
  endMinute: 720,
}));
const catalogo: Record<string, Rota> = {
  'GET /api/clinics/status': { body: { active: true } },
  'GET /api/clinics/units': {
    body: [{ id: U, name: 'Unidade principal', timezone: 'America/Sao_Paulo' }],
  },
  'GET /api/clinics/services': {
    body: [
      {
        id: S1,
        name: 'Limpeza',
        durationMin: 60,
        priceCents: null,
        currency: 'BRL',
        archivedAt: null,
      },
    ],
  },
  'GET /api/clinics/professionals': {
    body: [
      {
        id: ANA,
        name: 'Ana Fictícia',
        account: null,
        serviceIds: [S1],
        workingHours: comercial,
        archivedAt: null,
      },
      {
        id: BIA,
        name: 'Bia Fictícia',
        account: null,
        serviceIds: [],
        workingHours: comercial,
        archivedAt: null,
      },
    ],
  },
};
const agendamento = (extra: Record<string, unknown> = {}) => ({
  id: AG,
  patientId: PAC,
  patientName: 'Paciente Fictícia',
  professionalId: ANA,
  professionalName: 'Ana Fictícia',
  serviceId: S1,
  serviceName: 'Limpeza',
  unitId: U,
  startsAt: '2030-11-04T12:00:00.000Z',
  endsAt: '2030-11-04T13:00:00.000Z',
  localDate: DIA,
  localStart: '09:00',
  localEnd: '10:00',
  status: 'scheduled',
  cancelReason: null,
  ...extra,
});

function renderizar(ui: ReactNode, caminho = `/clinics/agenda?dia=${DIA}`) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[caminho]}>
        <NavContributionsProvider value={useClinicsNavGroups}>{ui}</NavContributionsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
/** Chamadas a dados do vertical (o status não conta: é ele que abre a porta). */
const doVertical = (chamadas: { chave: string }[]) =>
  chamadas.filter((c) =>
    /\/api\/clinics\/(appointments|units|professionals|services|patients)/.test(c.chave),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Passa o tempo de cache (30 s) e devolve o foco: o TanStack recarrega o que venceu. */
function recarregarAoVoltarOFoco() {
  const agora = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(agora + 31_000);
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

describe('Agenda da clínica (F2.3)', () => {
  it.each([
    ['status CARREGANDO', { pendente: true }, RECEPCAO, /Carregando/],
    [
      'status com ERRO',
      { status: 500, body: { message: 'x' } },
      RECEPCAO,
      /Não foi possível verificar/,
    ],
    ['vertical INATIVO', { body: { active: false } }, RECEPCAO, /não está ativo/],
    [
      'sem a chave da agenda',
      { body: { active: true } },
      ['clinics:catalog:read'],
      /não tem acesso à agenda/,
    ],
    [
      'agenda SEM a chave do catálogo',
      { body: { active: true } },
      ['clinics:schedule:read'],
      /não tem acesso à agenda/,
    ],
  ] as [string, Resposta, string[], RegExp][])(
    '%s: só a mensagem, e nada do vertical é consultado',
    async (_c, status, perms, msg) => {
      const chamadas = mockApi({
        'GET /api/auth/me': { body: usuario(perms) },
        'GET /api/clinics/status': status,
      });
      renderizar(<ClinicsAgendaPage />);
      expect(await screen.findByText(msg)).toBeInTheDocument();
      expect(doVertical(chamadas)).toEqual([]);
    },
  );

  it('a lateral mostra Agenda da clínica e Pacientes a quem lê a agenda', async () => {
    mockApi({ 'GET /api/auth/me': { body: usuario(RECEPCAO) }, ...catalogo });
    renderizar(<AppShell />, '/');
    const lateral = within(screen.getByRole('navigation', { name: 'Principal' }));
    expect(await lateral.findByRole('link', { name: 'Agenda da clínica' })).toHaveAttribute(
      'href',
      '/clinics/agenda',
    );
    expect(lateral.getByRole('link', { name: 'Pacientes' })).toHaveAttribute(
      'href',
      '/clinics/patients',
    );
  });

  it('só o catálogo: a lateral não tem Agenda da clínica nem Pacientes', async () => {
    mockApi({ 'GET /api/auth/me': { body: usuario(['clinics:catalog:read']) }, ...catalogo });
    renderizar(<AppShell />, '/');
    const lateral = within(screen.getByRole('navigation', { name: 'Principal' }));
    expect(await lateral.findByRole('link', { name: 'Catálogo' })).toBeInTheDocument();
    expect(lateral.queryByRole('link', { name: 'Agenda da clínica' })).toBeNull();
    expect(lateral.queryByRole('link', { name: 'Pacientes' })).toBeNull();
  });

  it('nenhuma unidade ativa: explica e não consulta a agenda', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/units': { body: [] },
    });
    renderizar(<ClinicsAgendaPage />);
    expect(await screen.findByText('Nenhuma unidade ativa.')).toBeInTheDocument();
    expect(chamadas.some((c) => c.chave.startsWith('GET /api/clinics/appointments'))).toBe(false);
  });

  it('recepção: grade por profissional na hora da unidade, ações de estado, cancelar exige motivo e fecha, e NENHUM registro de atendimento', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento()] },
      [`POST /api/clinics/appointments/${AG}/status`]: () => ({
        body: agendamento({ status: 'canceled' }),
      }),
    });
    renderizar(<ClinicsAgendaPage />);
    expect(
      await screen.findByText('segunda-feira, 04/11/2030', { exact: false }),
    ).toBeInTheDocument();
    const ana = await screen.findByRole('region', { name: 'Agenda de Ana Fictícia' });
    expect(within(ana).getByText('Expediente 08:00–12:00')).toBeInTheDocument();
    expect(await within(ana).findByText('09:00–10:00')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Agenda de Bia Fictícia' })).getByText(
        'Nenhum agendamento.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Agendar/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Confirmar: ${QUEM}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Marcar falta: ${QUEM}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Registrar atendimento/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Cancelar: ${QUEM}` }));
    const confirmar = screen.getByRole('button', { name: `Confirmar cancelamento: ${QUEM}` });
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`Motivo do cancelamento: ${QUEM}`), {
      target: { value: 'patient_request' },
    });
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.chave === `POST /api/clinics/appointments/${AG}/status`)?.corpo,
      ).toEqual({ to: 'canceled', cancelReason: 'patient_request' }),
    );
    // depois do sucesso, o formulário de cancelamento fecha
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: `Confirmar cancelamento: ${QUEM}` })).toBeNull(),
    );
  });

  it('`Profissional`: registra atendimento, mas não agenda nem muda estado', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': {
        body: [agendamento({ status: 'confirmed', attendanceId: null })],
      },
      [`POST /api/clinics/appointments/${AG}/attendance`]: { status: 201, body: { id: 'x' } },
    });
    renderizar(<ClinicsAgendaPage />);
    const registrar = await screen.findByRole('button', {
      name: `Registrar atendimento: ${QUEM}`,
    });
    expect(screen.queryByRole('button', { name: /Agendar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Registrar chegada:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Cancelar:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remarcar:/ })).toBeNull();
    fireEvent.click(registrar);
    await waitFor(() =>
      expect(chamadas.map((c) => c.chave)).toContain(
        `POST /api/clinics/appointments/${AG}/attendance`,
      ),
    );
  });

  it('agendamento de profissional ARQUIVADO não some: aparece numa coluna própria', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': {
        body: [agendamento({ professionalId: ARQ, professionalName: 'Carla Arquivada' })],
      },
    });
    renderizar(<ClinicsAgendaPage />);
    const coluna = await screen.findByRole('region', {
      name: 'Agenda de Carla Arquivada (arquivado)',
    });
    expect(within(coluna).getByText('09:00–10:00')).toBeInTheDocument();
    // cancelar, sim; remarcar, não: o drawer não teria serviços nem horários dele
    const quemArq = '09:00 Paciente Fictícia (Carla Arquivada)';
    expect(screen.getByRole('button', { name: `Cancelar: ${quemArq}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Remarcar: ${quemArq}` })).toBeNull();
  });

  it('recarga que FALHA depois de um sucesso: some tudo do dia, inclusive a coluna do arquivado', async () => {
    let vez = 0;
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': () =>
        vez++ === 0
          ? {
              body: [
                agendamento(),
                agendamento({
                  id: 'arquivado',
                  professionalId: ARQ,
                  professionalName: 'Carla Arquivada',
                }),
              ],
            }
          : { status: 500, body: { message: 'x' } },
      [`POST /api/clinics/appointments/${AG}/status`]: {
        body: agendamento({ status: 'confirmed' }),
      },
    });
    renderizar(<ClinicsAgendaPage />);
    expect(
      await screen.findByRole('region', { name: 'Agenda de Carla Arquivada (arquivado)' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Confirmar: ${QUEM}` }));
    expect(
      await screen.findByText('Não foi possível carregar a agenda do dia.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('region', { name: /arquivado/ })).toBeNull();
  });

  it('remarcar: só os serviços que o profissional faz, e sem `serviceId` quando o serviço não muda', async () => {
    const S2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e08';
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/services': {
        body: [
          {
            id: S1,
            name: 'Limpeza',
            durationMin: 60,
            priceCents: null,
            currency: 'BRL',
            archivedAt: null,
          },
          {
            id: S2,
            name: 'Clareamento',
            durationMin: 30,
            priceCents: null,
            currency: 'BRL',
            archivedAt: null,
          },
        ],
      },
      'GET /api/clinics/appointments': { body: [agendamento()] },
      [`POST /api/clinics/appointments/${AG}/reschedule`]: { body: agendamento() },
    });
    renderizar(<ClinicsAgendaPage />);
    fireEvent.click(await screen.findByRole('button', { name: `Remarcar: ${QUEM}` }));
    const dialogo = await screen.findByRole('dialog', { name: 'Remarcar' });
    const servico = within(dialogo).getByLabelText(/^Serviço/);
    expect(servico).toHaveValue(S1);
    expect(within(servico).queryByRole('option', { name: /Clareamento/ })).toBeNull();
    const horario = within(dialogo).getByLabelText(/^Horário/);
    // o próprio horário não conta como ocupado para ele mesmo
    await waitFor(() =>
      expect(
        within(horario)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toContain('09:00'),
    );
    fireEvent.change(horario, { target: { value: '10:00|' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Remarcar' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.chave === `POST /api/clinics/appointments/${AG}/reschedule`)?.corpo,
      ).toEqual({ date: DIA, time: '10:00' }),
    );
  });

  it('remarcar com o serviço original ARQUIVADO: explica e obriga a escolher outro', async () => {
    const S2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e08';
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/professionals': {
        body: [
          {
            id: ANA,
            name: 'Ana Fictícia',
            account: null,
            serviceIds: [S1, S2],
            workingHours: comercial,
            archivedAt: null,
          },
        ],
      },
      // a lista de serviços ativos já não traz o S1
      'GET /api/clinics/services': {
        body: [
          {
            id: S2,
            name: 'Clareamento',
            durationMin: 30,
            priceCents: null,
            currency: 'BRL',
            archivedAt: null,
          },
        ],
      },
      'GET /api/clinics/appointments': { body: [agendamento()] },
      [`POST /api/clinics/appointments/${AG}/reschedule`]: { body: agendamento() },
    });
    renderizar(<ClinicsAgendaPage />);
    fireEvent.click(await screen.findByRole('button', { name: `Remarcar: ${QUEM}` }));
    const dialogo = await screen.findByRole('dialog', { name: 'Remarcar' });
    expect(
      within(dialogo).getByText(/O serviço Limpeza foi arquivado: escolha outro\./),
    ).toBeInTheDocument();
    const servico = within(dialogo).getByLabelText(/^Serviço/);
    expect(servico).toHaveValue('');
    fireEvent.change(servico, { target: { value: S2 } });
    const horario = within(dialogo).getByLabelText(/^Horário/);
    await waitFor(() => expect(within(horario).getAllByRole('option').length).toBeGreaterThan(1));
    fireEvent.change(horario, { target: { value: '10:00|' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Remarcar' }));
    await waitFor(() =>
      expect(
        chamadas.find((c) => c.chave === `POST /api/clinics/appointments/${AG}/reschedule`)?.corpo,
      ).toEqual({ date: DIA, time: '10:00', serviceId: S2 }),
    );
  });

  it('busca de paciente cuja RECARGA falha (ex.: acesso revogado): a lista anterior some', async () => {
    let vez = 0;
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/patients?': () =>
        vez++ === 0
          ? { body: [{ id: PAC, contactId: 'c1', name: 'Paciente Fictícia', createdAt: '' }] }
          : { status: 403, body: { message: 'x' } },
      'GET /api/clinics/appointments': { body: [] },
    });
    renderizar(<ClinicsAgendaPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Agendar/ }));
    fireEvent.change(await screen.findByLabelText(/^Buscar paciente/), {
      target: { value: 'Pac' },
    });
    expect(await screen.findByRole('radio', { name: 'Paciente Fictícia' })).toBeInTheDocument();
    recarregarAoVoltarOFoco();
    expect(await screen.findByText('Não foi possível buscar pacientes.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('busca de paciente com erro: o alerta, e nada escolhível', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/patients?': { status: 500, body: { message: 'x' } },
      'GET /api/clinics/appointments': { body: [] },
    });
    renderizar(<ClinicsAgendaPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Agendar/ }));
    fireEvent.change(await screen.findByLabelText(/^Buscar paciente/), {
      target: { value: 'Pac' },
    });
    expect(await screen.findByText('Não foi possível buscar pacientes.')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('agenda carregando: nada de "Nenhum agendamento"', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': { pendente: true },
    });
    renderizar(<ClinicsAgendaPage />);
    expect(await screen.findByText('Carregando a agenda do dia…')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum agendamento.')).toBeNull();
  });

  it('agenda com erro: o alerta, sem cartões e sem "Nenhum agendamento"', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': { status: 500, body: { message: 'x' } },
    });
    renderizar(<ClinicsAgendaPage />);
    expect(
      await screen.findByText('Não foi possível carregar a agenda do dia.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nenhum agendamento.')).toBeNull();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('dia inválido na URL: volta para hoje e consulta só datas válidas', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [] },
    });
    renderizar(<ClinicsAgendaPage />, '/clinics/agenda?dia=2030-01-01%26professionalId%3Dx');
    await screen.findByRole('region', { name: 'Agenda de Ana Fictícia' });
    const consultas = chamadas.filter((c) => c.chave.startsWith('GET /api/clinics/appointments'));
    expect(consultas.length).toBeGreaterThan(0);
    for (const c of consultas) {
      expect(c.chave).toMatch(/^GET \/api\/clinics\/appointments\?date=\d{4}-\d{2}-\d{2}$/);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Próximo dia' })); // sem RangeError
    await screen.findByRole('region', { name: 'Agenda de Ana Fictícia' });
  });

  it('agendar: paciente por BUSCA, só profissional habilitado, só horário livre; envia o corpo certo e mostra o 409', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/patients?': {
        body: [{ id: PAC, contactId: 'c1', name: 'Paciente Fictícia', createdAt: '' }],
      },
      'GET /api/clinics/appointments': { body: [agendamento()] },
      'POST /api/clinics/appointments': {
        status: 409,
        body: { message: 'Horário já ocupado para este profissional' },
      },
    });
    renderizar(<ClinicsAgendaPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Agendar/ }));
    fireEvent.change(await screen.findByLabelText(/^Buscar paciente/), {
      target: { value: 'Pac' },
    });
    fireEvent.click(await screen.findByRole('radio', { name: 'Paciente Fictícia' }));
    expect(chamadas.map((c) => c.chave)).toContain('GET /api/clinics/patients?search=Pac&limit=20');
    // a lista inteira de pacientes nunca é baixada
    expect(chamadas.some((c) => c.chave === 'GET /api/clinics/patients')).toBe(false);
    fireEvent.change(screen.getByLabelText(/^Serviço/), { target: { value: S1 } });
    const profissional = screen.getByLabelText(/^Profissional/);
    expect(within(profissional).queryByRole('option', { name: 'Bia Fictícia' })).toBeNull();
    fireEvent.change(profissional, { target: { value: ANA } });
    const horario = screen.getByLabelText(/^Horário/);
    const horas = within(horario)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(horas).toContain('08:00');
    expect(horas).not.toContain('09:00'); // ocupado pela agenda do dia
    expect(horas).toContain('10:00');
    fireEvent.change(horario, { target: { value: '10:00|' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Horário já ocupado para este profissional',
    );
    expect(chamadas.find((c) => c.chave === 'POST /api/clinics/appointments')?.corpo).toEqual({
      patientId: PAC,
      professionalId: ANA,
      serviceId: S1,
      date: DIA,
      time: '10:00',
    });
  });
});

describe('Pacientes (F2.3)', () => {
  it.each([
    ['status CARREGANDO', { pendente: true }, RECEPCAO, /Carregando/],
    [
      'status com ERRO',
      { status: 500, body: { message: 'x' } },
      RECEPCAO,
      /Não foi possível verificar/,
    ],
    ['vertical INATIVO', { body: { active: false } }, RECEPCAO, /não está ativo/],
    [
      'sem a chave da agenda',
      { body: { active: true } },
      ['contacts:read'],
      /não tem acesso aos pacientes/,
    ],
  ] as [string, Resposta, string[], RegExp][])(
    '%s: só a mensagem, e nenhum paciente é consultado',
    async (_c, status, perms, msg) => {
      const chamadas = mockApi({
        'GET /api/auth/me': { body: usuario(perms) },
        'GET /api/clinics/status': status,
      });
      renderizar(<ClinicsPatientsPage />, '/clinics/patients');
      expect(await screen.findByText(msg)).toBeInTheDocument();
      expect(doVertical(chamadas)).toEqual([]);
    },
  );

  it('as consequências aparecem ANTES de confirmar; quem já é paciente (conferido só entre os da busca) não pode ser escolhido', async () => {
    const outro = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e09';
    const ja = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e10';
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/patients?limit=': {
        body: [
          { id: PAC, contactId: ja, name: 'Já Paciente', createdAt: '2030-01-01T00:00:00.000Z' },
        ],
      },
      'GET /api/clinics/patients?contactIds=': {
        body: [{ id: PAC, contactId: ja, name: 'Já Paciente', createdAt: '' }],
      },
      'GET /api/contacts?': {
        body: {
          items: [
            { id: ja, name: 'Já Paciente' },
            { id: outro, name: 'Nova Fictícia' },
          ],
          total: 2,
          page: 1,
          pageSize: 8,
        },
      },
      'POST /api/clinics/patients': (corpo) => ({
        status: 201,
        body: {
          id: 'p2',
          contactId: (corpo as { contactId: string }).contactId,
          name: 'Nova Fictícia',
          createdAt: '',
        },
      }),
    });
    renderizar(<ClinicsPatientsPage />, '/clinics/patients');
    expect(await screen.findByText('Já Paciente')).toBeInTheDocument();
    expect(chamadas.map((c) => c.chave)).toContain(
      `GET /api/clinics/patients?limit=${TETO_DA_LISTA}`,
    );
    fireEvent.click(screen.getByRole('button', { name: /Novo paciente/ }));
    for (const c of CONSEQUENCIAS_DO_PACIENTE) expect(screen.getByText(c)).toBeInTheDocument();
    const dialogo = screen.getByRole('dialog', { name: 'Novo paciente' });
    fireEvent.change(within(dialogo).getByLabelText(/^Buscar contato/), {
      target: { value: 'Fic' },
    });
    // enquanto confere, ninguém é escolhível; conferido, só quem ainda não é paciente
    await waitFor(() =>
      expect(within(dialogo).getByRole('radio', { name: /Nova Fictícia/ })).toBeEnabled(),
    );
    expect(within(dialogo).getByRole('radio', { name: /Já Paciente/ })).toBeDisabled();
    expect(chamadas.map((c) => c.chave)).toContain(
      `GET /api/clinics/patients?contactIds=${ja}%2C${outro}`,
    );
    fireEvent.click(within(dialogo).getByRole('radio', { name: /Nova Fictícia/ }));
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Tornar paciente' }));
    await waitFor(() =>
      expect(chamadas.find((c) => c.chave === 'POST /api/clinics/patients')?.corpo).toEqual({
        contactId: outro,
      }),
    );
  });

  it('teto da lista: avisa e pede a busca; quem só lê a agenda (Profissional) não vê "Novo paciente"', async () => {
    const muitos = Array.from({ length: TETO_DA_LISTA }, (_, i) => ({
      id: `p${i}`,
      contactId: `c${i}`,
      name: `Paciente ${i}`,
      createdAt: '2030-01-01T00:00:00.000Z',
    }));
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/patients?limit=': { body: muitos },
    });
    renderizar(<ClinicsPatientsPage />, '/clinics/patients');
    expect(await screen.findByText(/Mostrando os 50 mais recentes/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Novo paciente/ })).toBeNull();
  });

  it('conferência de "já é paciente" com erro: o alerta, e ninguém é escolhível', async () => {
    const outro = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e09';
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/patients?limit=': { body: [] },
      'GET /api/clinics/patients?contactIds=': { status: 500, body: { message: 'x' } },
      'GET /api/contacts?': {
        body: { items: [{ id: outro, name: 'Nova Fictícia' }], total: 1, page: 1, pageSize: 8 },
      },
    });
    renderizar(<ClinicsPatientsPage />, '/clinics/patients');
    fireEvent.click(await screen.findByRole('button', { name: /Novo paciente/ }));
    const dialogo = screen.getByRole('dialog', { name: 'Novo paciente' });
    fireEvent.change(within(dialogo).getByLabelText(/^Buscar contato/), {
      target: { value: 'Fic' },
    });
    expect(
      await within(dialogo).findByText(
        'Não foi possível conferir quem já é paciente. Tente de novo.',
      ),
    ).toBeInTheDocument();
    expect(within(dialogo).getByRole('radio', { name: /Nova Fictícia/ })).toBeDisabled();
  });

  it('lista cuja RECARGA falha depois de um sucesso: o alerta, e as linhas antigas somem', async () => {
    let vez = 0;
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/patients?limit=': () =>
        vez++ === 0
          ? { body: [{ id: PAC, name: 'Já Paciente', createdAt: '2030-01-01T00:00:00.000Z' }] }
          : { status: 500, body: { message: 'x' } },
    });
    renderizar(<ClinicsPatientsPage />, '/clinics/patients');
    expect(await screen.findByText('Já Paciente')).toBeInTheDocument();
    recarregarAoVoltarOFoco();
    expect(await screen.findByText('Não foi possível carregar os pacientes.')).toBeInTheDocument();
    expect(screen.queryByText('Já Paciente')).toBeNull();
  });

  it('lista com erro: o alerta, sem linhas antigas', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      'GET /api/clinics/status': { body: { active: true } },
      'GET /api/clinics/patients?limit=': { status: 500, body: { message: 'x' } },
    });
    renderizar(<ClinicsPatientsPage />, '/clinics/patients');
    expect(await screen.findByText('Não foi possível carregar os pacientes.')).toBeInTheDocument();
    expect(screen.queryByText('Nenhum paciente ainda.')).toBeNull();
  });
});

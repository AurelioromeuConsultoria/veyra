import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { vi } from 'vitest';
import { ExperienceProvider } from '../../lib/experience';
import { clinicsExperience } from './experience';
import { ME_KEY } from '../../lib/session';
import { criarQueryClient } from '../../lib/session-query';
import { ClinicsAgendaPage } from './AgendaPage';
import { ClinicsNoShowPage, taxaLegivel } from './NoShowPage';
import { ClinicsPatientPage } from './PatientPage';
import { ClinicsReturnsPage } from './ReturnsPage';
import { motivosPermitidos } from './continuidade';

/**
 * As telas da continuidade (F3.3b; ADR-048 adendo 7 e as condições da
 * aprovação da F3.3). Dados FICTÍCIOS. O que se prova: a escolha explícita
 * entre avulso e pacote, nenhuma consulta a pacotes sem `care:read`, falha sem
 * dado antigo e 0 % distinto de "sem dados".
 */

/** `espera`: a resposta só sai quando a promessa resolve (para segurar um pedido). */
type Resposta = { status?: number; body?: unknown; pendente?: boolean; espera?: Promise<unknown> };
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
      if (resposta.espera) await resposta.espera;
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
/** registra atendimento, mas NÃO lê pacotes (papel customizado) */
const ESCREVE_SEM_LER = ['clinics:catalog:read', 'clinics:schedule:read', 'clinics:care:write'];

const U = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e02';
const S1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e01';
const S2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e08';
const ANA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e03';
const PAC = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05';
const AG = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e06';
const P1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e11';
const P2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e12';
const R1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e21';
const DIA = '2030-11-04';
const QUEM = '09:00 Paciente Fictícia (Ana Fictícia)';

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
        returnIntervalDays: 30,
        archivedAt: null,
      },
      {
        id: S2,
        name: 'Peeling',
        durationMin: 60,
        priceCents: null,
        currency: 'BRL',
        returnIntervalDays: null,
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
        workingHours: [1, 2, 3, 4, 5].map((weekday) => ({
          unitId: U,
          weekday,
          startMinute: 480,
          endMinute: 720,
        })),
        archivedAt: null,
      },
    ],
  },
};

const agendamento = {
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
  status: 'confirmed',
  cancelReason: null,
  // no alcance clínico de quem atende (D8, ADR-061): o servidor manda
  careInScope: true,
};

const pacote = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  patientId: PAC,
  serviceId: S1,
  totalSessions: 10,
  consumedSessions: 3,
  remainingSessions: 7,
  totalPriceCents: 150050,
  currency: 'BRL',
  status: 'active',
  createdAt: '2030-01-01T00:00:00.000Z',
  closedAt: null,
  ...extra,
});

const retorno = (extra: Record<string, unknown> = {}) => ({
  id: R1,
  patientId: PAC,
  patientName: 'Paciente Fictícia',
  serviceId: S1,
  serviceName: 'Limpeza',
  unitId: U,
  dueDate: '2030-12-01',
  status: 'pending',
  overdue: false,
  assignee: null,
  appointment: null,
  closedAt: null,
  ...extra,
});

/** O MESMO cache de produção (sem recarga no foco), sem retentativa. */
let client: QueryClient;
function renderizar(ui: ReactNode, caminho: string) {
  client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[caminho]}>
        <ExperienceProvider value={clinicsExperience}>{ui}</ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const aPacotes = (chamadas: { chave: string }[]) =>
  chamadas.filter((c) => c.chave.includes('/api/clinics/packages'));

/** Uma recarga, como a de uma invalidação depois de uma ação. */
function recarregar() {
  act(() => {
    void client.invalidateQueries();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Abre o agendamento pelo bloco da grade: as ações moram no painel (ADR-062). */
async function abrirAgendamento() {
  fireEvent.click(await screen.findByRole('button', { name: `Abrir agendamento: ${QUEM}` }));
  return screen.findByRole('dialog', { name: 'Agendamento' });
}

async function abrirRegistro() {
  const painel = await abrirAgendamento();
  fireEvent.click(within(painel).getByRole('button', { name: `Registrar atendimento: ${QUEM}` }));
  return screen.findByRole('dialog', { name: 'Registrar atendimento' });
}

describe('registro de atendimento: a escolha EXPLÍCITA entre avulso e pacote', () => {
  it('nada vem marcado, nem com um pacote só; o pacote mostra o saldo antes e depois; envia o pacote escolhido', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      // um elegível; outro serviço e um encerrado não são opções
      'GET /api/clinics/packages': {
        body: [
          pacote(P1),
          pacote(P2, { serviceId: S2 }),
          pacote('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e13', {
            status: 'completed',
            remainingSessions: 0,
          }),
        ],
      },
      [`POST /api/clinics/appointments/${AG}/attendance`]: { status: 201, body: { id: 'x' } },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    const opcao = await within(painel).findByLabelText(
      'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6 depois deste atendimento',
    );
    expect(within(painel).getAllByRole('radio')).toHaveLength(2);
    for (const r of within(painel).getAllByRole('radio')) expect(r).not.toBeChecked();
    // o saldo é consulta, não reserva (ajuste A1, decisão 2)
    expect(
      within(painel).getByText(/não é uma reserva: pode mudar até a confirmação/),
    ).toBeInTheDocument();
    const confirmar = within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' });
    expect(confirmar).toBeDisabled();
    fireEvent.click(opcao);
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 7 → 6)',
      }),
    );
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: `POST /api/clinics/appointments/${AG}/attendance`,
        corpo: { packageId: P1 },
      }),
    );
  });

  it('a falha ao carregar os pacotes NÃO vira avulso: o alerta, nenhuma opção, nada confirmável; "tentar de novo" recarrega', async () => {
    let falhar = true;
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () =>
        falhar ? { status: 500, body: { message: 'x' } } : { body: [pacote(P1)] },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    expect(await within(painel).findByRole('alert')).toHaveTextContent(
      /Não foi possível carregar os pacotes/,
    );
    expect(within(painel).queryAllByRole('radio')).toHaveLength(0);
    expect(
      within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' }),
    ).toBeDisabled();
    falhar = false;
    fireEvent.click(within(painel).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(painel).findAllByRole('radio')).toHaveLength(2);
    expect(chamadas.filter((c) => c.chave.startsWith('POST'))).toEqual([]);
  });

  it('a RECUSA do servidor (o saldo mudou): a mensagem, as opções recarregam e a escolha é desfeita; nada é reenviado em silêncio', async () => {
    let saldo = 1;
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () => ({
        body: [pacote(P1, { remainingSessions: saldo, consumedSessions: 10 - saldo })],
      }),
      [`POST /api/clinics/appointments/${AG}/attendance`]: () => {
        saldo = 0;
        return { status: 409, body: { message: 'O pacote não tem mais sessões' } };
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 1, ficam 0 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 1 → 0)',
      }),
    );
    expect(await within(painel).findByRole('alert')).toHaveTextContent(
      'O pacote não tem mais sessões',
    );
    // recarregou: o pacote sem saldo some, e sobra só "avulso", DESMARCADO
    await waitFor(() => expect(within(painel).getAllByRole('radio')).toHaveLength(1));
    expect(within(painel).getByLabelText('Avulso (sem pacote)')).not.toBeChecked();
    expect(
      within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' }),
    ).toBeDisabled();
    expect(chamadas.filter((c) => c.chave.startsWith('POST'))).toHaveLength(1);
  });

  it('a recusa com o pacote AINDA elegível (o saldo caiu de 5 para 4): a opção volta DESMARCADA, com o saldo novo; e durante a recarga nada é confirmável', async () => {
    let saldo = 5;
    let segurar = false;
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () =>
        segurar
          ? { pendente: true }
          : { body: [pacote(P1, { remainingSessions: saldo, consumedSessions: 10 - saldo })] },
      [`POST /api/clinics/appointments/${AG}/attendance`]: () => {
        saldo = 4;
        segurar = true;
        return { status: 409, body: { message: 'O saldo do pacote mudou' } };
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 5, ficam 4 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 5 → 4)',
      }),
    );
    expect(await within(painel).findByRole('alert')).toHaveTextContent('O saldo do pacote mudou');
    // a agenda é relida pela PRÓPRIA recusa (outra pessoa pode ter registrado)
    const agenda = () =>
      chamadas.filter((c) => c.chave.startsWith('GET /api/clinics/appointments')).length;
    await waitFor(() => expect(agenda()).toBe(2));
    // a recarga está pendente: nenhuma opção e nada confirmável
    await waitFor(() => expect(within(painel).queryAllByRole('radio')).toHaveLength(0));
    expect(within(painel).getByText('Carregando os pacotes…')).toBeInTheDocument();
    expect(
      within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' }),
    ).toBeDisabled();
    // a recarga chega: o pacote continua, com o saldo novo, e DESMARCADO
    segurar = false;
    recarregar();
    const opcao = await within(painel).findByLabelText(
      'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 4, ficam 3 depois deste atendimento',
    );
    expect(opcao).not.toBeChecked();
    expect(
      within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' }),
    ).toBeDisabled();
    expect(chamadas.filter((c) => c.chave.startsWith('POST'))).toHaveLength(1);
  });

  it('dois pacotes iguais do mesmo serviço são distinguíveis pela data de criação, na opção e no botão', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': {
        body: [pacote(P1), pacote(P2, { createdAt: '2030-02-01T13:30:00.000Z' })],
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    await within(painel).findByLabelText(
      'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6 depois deste atendimento',
    );
    fireEvent.click(
      within(painel).getByLabelText(
        'Pacote de 10 sessões, criado em 01/02/2030 10:30: restam 7, ficam 6 depois deste atendimento',
      ),
    );
    expect(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 01/02/2030 10:30 (restam 7 → 6)',
      }),
    ).toBeEnabled();
  });

  it('sem `care:read`: NENHUMA consulta a pacotes; só "avulso", com o aviso, e ainda assim escolhido explicitamente', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(ESCREVE_SEM_LER) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      [`POST /api/clinics/appointments/${AG}/attendance`]: { status: 201, body: { id: 'x' } },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    expect(within(painel).getByText(/não estão visíveis para você/)).toBeInTheDocument();
    // sem pacote elegível, sem o aviso do saldo
    expect(within(painel).queryByText(/não é uma reserva/)).toBeNull();
    const avulso = within(painel).getByLabelText('Avulso (sem pacote)');
    expect(avulso).not.toBeChecked();
    expect(
      within(painel).getByRole('button', { name: 'Escolha avulso ou um pacote' }),
    ).toBeDisabled();
    fireEvent.click(avulso);
    fireEvent.click(within(painel).getByRole('button', { name: 'Registrar atendimento avulso' }));
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: `POST /api/clinics/appointments/${AG}/attendance`,
        corpo: { packageId: null },
      }),
    );
    expect(await within(painel).findByRole('status')).toHaveTextContent(
      'Atendimento registrado como avulso.',
    );
    expect(aPacotes(chamadas)).toEqual([]);
  });

  it('depois do sucesso, o saldo é o RELIDO do servidor, mesmo quando difere de "antes − 1"; durante a releitura, nenhum saldo; "Concluir" fecha', async () => {
    let saldo = 7;
    let segurar = false;
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () =>
        segurar
          ? { pendente: true }
          : { body: [pacote(P1, { remainingSessions: saldo, consumedSessions: 10 - saldo })] },
      // outra sessão consumiu no meio: o servidor fica com 5, não com 6
      [`POST /api/clinics/appointments/${AG}/attendance`]: () => {
        saldo = 5;
        segurar = true;
        return { status: 201, body: { id: 'x' } };
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 7 → 6)',
      }),
    );
    expect(await within(painel).findByRole('status')).toHaveTextContent(
      'Atendimento registrado, com 1 sessão do pacote escolhido.',
    );
    // a releitura está pendente: nenhum saldo, nem o antigo nem o calculado
    expect(within(painel).getByText('Conferindo o saldo no servidor…')).toBeInTheDocument();
    expect(within(painel).queryByText(/restam/)).toBeNull();
    segurar = false;
    recarregar();
    expect(
      await within(painel).findByText(
        'Saldo no servidor: pacote de 10 sessões, criado em 31/12/2029 21:00: restam 5.',
      ),
    ).toBeInTheDocument();
    expect(within(painel).queryByText(/restam 6/)).toBeNull();
    expect(chamadas.filter((c) => c.chave.startsWith('POST'))).toHaveLength(1);
    fireEvent.click(within(painel).getByRole('button', { name: 'Concluir' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Registrar atendimento' })).toBeNull(),
    );
  });

  it('se `care:read` deixa de valer DURANTE o registro, nenhum saldo aparece como do servidor: nem o antigo, nem uma consulta nova', async () => {
    let permissoes = PROFISSIONAL;
    let liberar: () => void = () => undefined;
    const resposta = new Promise<void>((r) => (liberar = r));
    const chamadas = mockApi({
      'GET /api/auth/me': () => ({ body: usuario(permissoes) }),
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': { body: [pacote(P1)] },
      [`POST /api/clinics/appointments/${AG}/attendance`]: {
        status: 201,
        body: { id: 'x' },
        espera: resposta,
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 7 → 6)',
      }),
    );
    // a sessão é relida SEM `care:read` antes de a resposta do registro chegar
    permissoes = ESCREVE_SEM_LER;
    act(() => {
      void client.invalidateQueries({ queryKey: ME_KEY });
    });
    expect(await within(painel).findByText(/não estão visíveis para você/)).toBeInTheDocument();
    // e o pacote do cache some das opções
    expect(within(painel).queryByText(/Pacote de 10 sessões/)).toBeNull();
    const lidas = aPacotes(chamadas).length;
    act(() => liberar());
    expect(await within(painel).findByRole('status')).toHaveTextContent(
      'Atendimento registrado, com 1 sessão do pacote escolhido.',
    );
    expect(within(painel).getByText(/deixaram de estar visíveis para você/)).toBeInTheDocument();
    expect(within(painel).queryByText(/Saldo no servidor/)).toBeNull();
    expect(within(painel).queryByText(/restam/)).toBeNull();
    expect(aPacotes(chamadas)).toHaveLength(lidas);
  });

  it('a releitura CANCELADA em voo volta ao dado de antes do registro: ele NÃO aparece como saldo do servidor; "conferir de novo" traz o relido', async () => {
    let saldo = 7;
    let segurar = false;
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () =>
        segurar
          ? { pendente: true }
          : { body: [pacote(P1, { remainingSessions: saldo, consumedSessions: 10 - saldo })] },
      [`POST /api/clinics/appointments/${AG}/attendance`]: () => {
        saldo = 6;
        segurar = true;
        return { status: 201, body: { id: 'x' } };
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 7 → 6)',
      }),
    );
    expect(await within(painel).findByText('Conferindo o saldo no servidor…')).toBeInTheDocument();
    // outra parte da tela cancela a releitura: o cache volta ao de ANTES
    act(() => {
      void client.cancelQueries({ queryKey: ['clinics', 'packages'] });
    });
    expect(await within(painel).findByRole('alert')).toHaveTextContent(
      'Não foi possível conferir o saldo atualizado. O atendimento já está registrado.',
    );
    expect(within(painel).queryByText(/restam/)).toBeNull();
    segurar = false;
    fireEvent.click(within(painel).getByRole('button', { name: 'Conferir de novo' }));
    expect(
      await within(painel).findByText(
        'Saldo no servidor: pacote de 10 sessões, criado em 31/12/2029 21:00: restam 6.',
      ),
    ).toBeInTheDocument();
  });

  it('a releitura do saldo que FALHA não mostra saldo antigo: o alerta, e "conferir de novo" traz o do servidor; o pacote esgotado aparece concluído', async () => {
    // antes do registro, 1 sessão; depois, a releitura falha e, na seguinte, o
    // pacote vem concluído
    let fase: 'antes' | 'falha' | 'depois' = 'antes';
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [agendamento] },
      'GET /api/clinics/packages': () =>
        fase === 'falha'
          ? { status: 500, body: { message: 'x' } }
          : {
              body: [
                fase === 'antes'
                  ? pacote(P1, { remainingSessions: 1, consumedSessions: 9 })
                  : pacote(P1, { remainingSessions: 0, consumedSessions: 10, status: 'completed' }),
              ],
            },
      [`POST /api/clinics/appointments/${AG}/attendance`]: () => {
        fase = 'falha';
        return { status: 201, body: { id: 'x' } };
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirRegistro();
    fireEvent.click(
      await within(painel).findByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 1, ficam 0 depois deste atendimento',
      ),
    );
    fireEvent.click(
      within(painel).getByRole('button', {
        name: 'Registrar e consumir 1 sessão do pacote criado em 31/12/2029 21:00 (restam 1 → 0)',
      }),
    );
    expect(await within(painel).findByRole('alert')).toHaveTextContent(
      'Não foi possível conferir o saldo atualizado. O atendimento já está registrado.',
    );
    expect(within(painel).queryByText(/restam/)).toBeNull();
    fase = 'depois';
    fireEvent.click(within(painel).getByRole('button', { name: 'Conferir de novo' }));
    expect(
      await within(painel).findByText(
        'Saldo no servidor: pacote de 10 sessões, criado em 31/12/2029 21:00: restam 0 (Concluído).',
      ),
    ).toBeInTheDocument();
    // uma recarga seguinte que falha: com erro, nenhum saldo, nem o já relido
    fase = 'falha';
    recarregar();
    expect(await within(painel).findByRole('alert')).toHaveTextContent(
      'Não foi possível conferir o saldo atualizado.',
    );
    expect(within(painel).queryByText(/restam/)).toBeNull();
  });
});

describe('correção do consumo na agenda (F5.2b, ADR-059)', () => {
  const atendido = { ...agendamento, status: 'attended', attendanceId: 'at1' };
  const atendimento = (extra: Record<string, unknown> = {}) => ({
    id: 'at1',
    appointmentId: AG,
    professionalId: ANA,
    completedAt: '2030-11-04T13:00:00.000Z',
    packageId: P1,
    originalPackageId: P1,
    consumptionRevision: 0,
    ...extra,
  });
  const P2_MESMO = pacote(P2, {
    createdAt: '2030-02-01T00:00:00.000Z',
    consumedSessions: 6,
    remainingSessions: 4,
  });
  const CORRIGIR = `POST /api/clinics/appointments/${AG}/attendance/package-correction`;
  const correcao = (extra: Record<string, unknown> = {}) => ({
    id: 'c1',
    attendanceId: 'at1',
    appointmentId: AG,
    fromPackageId: P1,
    toPackageId: null,
    revision: 1,
    reason: 'wrong_choice',
    correctedByMembershipId: 'm1',
    createdAt: '2030-11-05T12:00:00.000Z',
    ...extra,
  });
  async function abrirCorrecao() {
    const painel = await abrirAgendamento();
    fireEvent.click(within(painel).getByRole('button', { name: `Corrigir consumo: ${QUEM}` }));
    return screen.findByRole('dialog', { name: 'Corrigir consumo' });
  }

  it('do pacote para avulso: o consumo atual, nada marcado, os saldos antes e depois, o motivo; envia a revisão vista com Idempotency-Key', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [atendido] },
      [`GET /api/clinics/appointments/${AG}/attendance`]: { body: atendimento() },
      'GET /api/clinics/packages': { body: [pacote(P1), P2_MESMO] },
      [CORRIGIR]: { status: 201, body: correcao() },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirCorrecao();
    // a data no padrão brasileiro, o dia da unidade (o `localDate`), sem conversão de fuso
    expect(
      await within(painel).findByText('04/11/2030 09:00 · Paciente Fictícia · Limpeza'),
    ).toBeInTheDocument();
    expect(
      await within(painel).findByText(
        'Uma sessão do pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7.',
      ),
    ).toBeInTheDocument();
    // as opções: o outro pacote do serviço e avulso; o atual não; nada marcado
    expect(within(painel).getAllByRole('radio')).toHaveLength(2);
    for (const r of within(painel).getAllByRole('radio')) expect(r).not.toBeChecked();
    const confirmar = within(painel).getByRole('button', { name: 'Confirmar correção' });
    expect(confirmar).toBeDisabled();
    fireEvent.click(within(painel).getByLabelText('Avulso (sem pacote)'));
    expect(within(painel).getByText(/recebe a sessão de volta: restam 7 → 8/)).toBeInTheDocument();
    // sem motivo, nada se confirma; "cadastrado depois" não vale saindo de um pacote
    expect(confirmar).toBeDisabled();
    const motivo = within(painel).getByRole('combobox', { name: 'Motivo da correção' });
    expect(
      within(motivo).queryByRole('option', { name: 'Pacote cadastrado depois do atendimento' }),
    ).toBeNull();
    fireEvent.change(motivo, { target: { value: 'wrong_choice' } });
    fireEvent.click(confirmar);
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: CORRIGIR,
        corpo: { expectedRevision: 0, packageId: null, reason: 'wrong_choice' },
      }),
    );
    const [, init] = vi
      .mocked(fetch)
      .mock.calls.find(([url, i]) => `${i?.method} ${String(url)}` === CORRIGIR)!;
    expect((init?.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await within(painel).findByText('Consumo corrigido: do pacote para avulso (correção nº 1).'),
    ).toBeInTheDocument();
  });

  it('de avulso para um pacote: só pacotes ativos do serviço com saldo; "cadastrado depois" aparece; envia a revisão que a pessoa viu', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [atendido] },
      [`GET /api/clinics/appointments/${AG}/attendance`]: {
        body: atendimento({ packageId: null, originalPackageId: P1, consumptionRevision: 2 }),
      },
      'GET /api/clinics/packages': {
        body: [
          pacote(P1),
          pacote(P2, { serviceId: S2 }),
          pacote('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e13', {
            status: 'completed',
            remainingSessions: 0,
          }),
        ],
      },
      [CORRIGIR]: { status: 201, body: correcao({ fromPackageId: null, toPackageId: P1 }) },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirCorrecao();
    expect(await within(painel).findByText('Avulso (sem pacote).')).toBeInTheDocument();
    expect(within(painel).getByText('Este consumo já foi corrigido 2 vezes.')).toBeInTheDocument();
    // avulso não é opção (já é o atual); outro serviço e o concluído também não
    expect(within(painel).getAllByRole('radio')).toHaveLength(1);
    fireEvent.click(
      within(painel).getByLabelText(
        'Pacote de 10 sessões, criado em 31/12/2029 21:00: restam 7, ficam 6',
      ),
    );
    expect(
      within(painel).getByText(/passa a consumir esta sessão: restam 7 → 6/),
    ).toBeInTheDocument();
    fireEvent.change(within(painel).getByRole('combobox', { name: 'Motivo da correção' }), {
      target: { value: 'package_registered_late' },
    });
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar correção' }));
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: CORRIGIR,
        corpo: { expectedRevision: 2, packageId: P1, reason: 'package_registered_late' },
      }),
    );
  });

  it('a falha ao carregar os pacotes NÃO vira avulso: o alerta, nenhuma opção, nada confirmável', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [atendido] },
      [`GET /api/clinics/appointments/${AG}/attendance`]: { body: atendimento() },
      'GET /api/clinics/packages': { status: 500, body: { message: 'x' } },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirCorrecao();
    expect(
      await within(painel).findByText(
        'Não foi possível carregar o consumo atual e os pacotes. Sem eles, nada é corrigido.',
      ),
    ).toBeInTheDocument();
    expect(within(painel).queryAllByRole('radio')).toHaveLength(0);
    expect(within(painel).getByRole('button', { name: 'Confirmar correção' })).toBeDisabled();
    expect(chamadas.some((c) => c.chave === CORRIGIR)).toBe(false);
  });

  it('a recusa (outra pessoa corrigiu antes, 409): a mensagem do servidor, tudo relido e a escolha desfeita', async () => {
    let leituras = 0;
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': { body: [atendido] },
      [`GET /api/clinics/appointments/${AG}/attendance`]: () => {
        leituras += 1;
        return { body: atendimento() };
      },
      'GET /api/clinics/packages': { body: [pacote(P1), P2_MESMO] },
      [CORRIGIR]: {
        status: 409,
        body: { message: 'O consumo deste atendimento mudou; recarregue.' },
      },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const painel = await abrirCorrecao();
    fireEvent.click(await within(painel).findByLabelText('Avulso (sem pacote)'));
    fireEvent.change(within(painel).getByRole('combobox', { name: 'Motivo da correção' }), {
      target: { value: 'wrong_choice' },
    });
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar correção' }));
    expect(
      await within(painel).findByText('O consumo deste atendimento mudou; recarregue.'),
    ).toBeInTheDocument();
    await waitFor(() => expect(leituras).toBeGreaterThanOrEqual(2));
    await waitFor(() => {
      for (const r of within(painel).getAllByRole('radio')) expect(r).not.toBeChecked();
    });
    expect(within(painel).getByRole('button', { name: 'Confirmar correção' })).toBeDisabled();
  });

  it('D8: o horário fora do alcance (de outro profissional) não oferece registrar nem corrigir', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(PROFISSIONAL) },
      ...catalogo,
      'GET /api/clinics/appointments': {
        body: [
          { ...agendamento, careInScope: false },
          {
            ...agendamento,
            id: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e99',
            status: 'attended',
            attendanceId: null,
            careInScope: false,
          },
        ],
      },
      'GET /api/clinics/packages': { body: [] },
    });
    renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
    const blocos = await screen.findAllByRole('button', { name: `Abrir agendamento: ${QUEM}` });
    expect(blocos).toHaveLength(2);
    for (const bloco of blocos) {
      fireEvent.click(bloco);
      const painel = await screen.findByRole('dialog', { name: 'Agendamento' });
      expect(within(painel).queryByRole('button', { name: /^Registrar atendimento:/ })).toBeNull();
      expect(within(painel).queryByRole('button', { name: /^Corrigir consumo:/ })).toBeNull();
      fireEvent.click(within(painel).getByRole('button', { name: 'Fechar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
  });

  it.each([
    ['a recepção (sem care)', RECEPCAO, 'at1'],
    ['quem escreve sem ler pacotes', ESCREVE_SEM_LER, 'at1'],
    ['o atendimento ainda não registrado', PROFISSIONAL, null],
  ] as [string, string[], string | null][])(
    '%s: nenhuma ação de corrigir',
    async (_c, perms, attendanceId) => {
      mockApi({
        'GET /api/auth/me': { body: usuario(perms) },
        ...catalogo,
        'GET /api/clinics/appointments': {
          body: [{ ...agendamento, status: 'attended', attendanceId }],
        },
        'GET /api/clinics/packages': { body: [] },
      });
      renderizar(<ClinicsAgendaPage />, `/clinics/agenda?dia=${DIA}`);
      const painel = await abrirAgendamento();
      expect(within(painel).getByText('Atendido')).toBeInTheDocument();
      expect(within(painel).queryByRole('button', { name: /^Corrigir consumo:/ })).toBeNull();
    },
  );
});

describe('ficha do paciente', () => {
  const ficha = (permissoes: string[], extra: Record<string, Rota> = {}) =>
    mockApi({
      'GET /api/auth/me': { body: usuario(permissoes) },
      ...catalogo,
      [`GET /api/clinics/patients/${PAC}`]: {
        body: { id: PAC, name: 'Paciente Fictícia', createdAt: '2030-01-01T00:00:00Z' },
      },
      'GET /api/clinics/returns': { body: [retorno()] },
      ...extra,
    });

  it('sem `care:read`: a seção de pacotes não existe e NENHUMA consulta a pacotes é feita', async () => {
    const chamadas = ficha(RECEPCAO, { 'GET /api/clinics/packages': { body: [pacote(P1)] } });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    expect(await screen.findByRole('heading', { name: 'Paciente Fictícia' })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Retornos do paciente' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pacotes do paciente' })).toBeNull();
    // nem a aba nem o resumo dos pacotes
    expect(screen.queryByRole('tab', { name: 'Pacotes' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pacotes ativos' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Novo retorno' })).toBeNull();
    await waitFor(() =>
      expect(chamadas.some((c) => c.chave.includes('/api/clinics/returns'))).toBe(true),
    );
    expect(aPacotes(chamadas)).toEqual([]);
  });

  it('com `care:read`: o saldo e o preço "registrado"; a RECARGA que falha some com as linhas antigas', async () => {
    let falhar = false;
    ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': () =>
        falhar ? { status: 403, body: { message: 'x' } } : { body: [pacote(P1)] },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    const linha = await screen.findByRole('row', {
      name: 'Pacote de 10 sessões de Limpeza, criado em 31/12/2029 21:00',
    });
    expect(within(linha).getByText('3 de 10')).toBeInTheDocument();
    expect(within(linha).getByText('7')).toBeInTheDocument();
    expect(within(linha).getByText(/R\$\s?1\.500,50/)).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Preço total registrado' }),
    ).toBeInTheDocument();
    falhar = true;
    recarregar();
    // a recusa (403) mostra o motivo do servidor (sem vínculo, D8); as linhas somem
    expect(await screen.findByText('x')).toBeInTheDocument();
    expect(
      screen.queryByRole('row', {
        name: 'Pacote de 10 sessões de Limpeza, criado em 31/12/2029 21:00',
      }),
    ).toBeNull();
  });

  it('as sessões do pacote: quem consome agora, com o profissional, e as correções com o sentido e o motivo', async () => {
    ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': { body: [pacote(P1)] },
      [`GET /api/clinics/packages/${P1}/sessions`]: {
        body: {
          packageId: P1,
          sessions: [
            {
              attendanceId: 'a1',
              appointmentId: AG,
              professionalId: ANA,
              completedAt: '2030-11-04T13:00:00.000Z',
              consumptionRevision: 1,
            },
          ],
          corrections: [
            {
              id: 'c2',
              attendanceId: 'a2',
              appointmentId: AG,
              fromPackageId: P1,
              toPackageId: null,
              revision: 1,
              reason: 'wrong_choice',
              correctedByMembershipId: 'm1',
              createdAt: '2030-11-06T12:00:00.000Z',
            },
            {
              id: 'c1',
              attendanceId: 'a1',
              appointmentId: AG,
              fromPackageId: null,
              toPackageId: P1,
              revision: 1,
              reason: 'package_registered_late',
              correctedByMembershipId: 'm1',
              createdAt: '2030-11-05T12:00:00.000Z',
            },
          ],
        },
      },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sessões: Pacote de 10 sessões de Limpeza, criado em 31/12/2029 21:00',
      }),
    );
    const painel = await screen.findByRole('dialog', { name: 'Sessões do pacote' });
    expect(
      await within(painel).findByText(/Consomem este pacote agora \(1 de 10\)/),
    ).toBeInTheDocument();
    expect(
      await within(painel).findByText(/04\/11\/2030 10:00 · Ana Fictícia · consumo corrigido/),
    ).toBeInTheDocument();
    expect(
      within(painel).getByText(
        /05\/11\/2030 09:00 · de avulso para este pacote · Pacote cadastrado depois do atendimento/,
      ),
    ).toBeInTheDocument();
    // as contrações: "deste pacote", nunca "de este pacote"
    expect(
      within(painel).getByText(
        /06\/11\/2030 09:00 · deste pacote para avulso · Escolha errada no registro/,
      ),
    ).toBeInTheDocument();
    expect(within(painel).queryByText(/de este pacote|de o pacote/)).toBeNull();
    expect(within(painel).queryByText(/Mostrando as 100/)).toBeNull();
  });

  it('D8: as sessões de outros profissionais não aparecem, e a tela diz que o saldo as inclui', async () => {
    ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': { body: [pacote(P1)] },
      [`GET /api/clinics/packages/${P1}/sessions`]: {
        body: { packageId: P1, sessions: [], corrections: [] },
      },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sessões: Pacote de 10 sessões de Limpeza, criado em 31/12/2029 21:00',
      }),
    );
    const painel = await screen.findByRole('dialog', { name: 'Sessões do pacote' });
    expect(
      await within(painel).findByText(/O saldo inclui 3 sessões de outros profissionais/),
    ).toBeInTheDocument();
  });

  it('com 100 correções, a tela diz que a lista pode estar cortada', async () => {
    const cem = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      attendanceId: 'a1',
      appointmentId: AG,
      fromPackageId: i % 2 ? P1 : null,
      toPackageId: i % 2 ? null : P1,
      revision: 100 - i,
      reason: 'wrong_choice',
      correctedByMembershipId: 'm1',
      createdAt: '2030-11-05T12:00:00.000Z',
    }));
    ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': { body: [pacote(P1)] },
      [`GET /api/clinics/packages/${P1}/sessions`]: {
        body: { packageId: P1, sessions: [], corrections: cem },
      },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Sessões: Pacote de 10 sessões de Limpeza, criado em 31/12/2029 21:00',
      }),
    );
    const painel = await screen.findByRole('dialog', { name: 'Sessões do pacote' });
    expect(
      await within(painel).findByText(/Mostrando as 100 correções mais recentes/),
    ).toBeInTheDocument();
  });

  it('novo pacote: a confirmação mostra o que fica congelado e que o preço não é pagamento; envia centavos inteiros', async () => {
    const chamadas = ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': { body: [] },
      'POST /api/clinics/packages': { status: 201, body: pacote(P1) },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo pacote' }));
    const painel = await screen.findByRole('dialog', { name: 'Novo pacote' });
    fireEvent.change(within(painel).getByLabelText('Serviço'), { target: { value: S1 } });
    fireEvent.change(within(painel).getByLabelText(/Total de sessões/), {
      target: { value: '10' },
    });
    fireEvent.change(within(painel).getByLabelText(/Preço total/), {
      target: { value: '1.500,50' },
    });
    fireEvent.click(within(painel).getByRole('button', { name: 'Revisar pacote' }));
    expect(within(painel).getByText(/ficam congelados/)).toBeInTheDocument();
    expect(within(painel).getByText(/não é\s+pagamento/)).toBeInTheDocument();
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar e criar pacote' }));
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: 'POST /api/clinics/packages',
        corpo: { patientId: PAC, serviceId: S1, totalSessions: 10, totalPriceCents: 150050 },
      }),
    );
  });

  it('id inválido na URL: nada é consultado', async () => {
    const chamadas = ficha(PROFISSIONAL);
    renderizar(<ClinicsPatientPage />, '/clinics/patient?id=nao-e-um-id');
    expect(await screen.findByText('Paciente não encontrado.')).toBeInTheDocument();
    expect(chamadas.filter((c) => c.chave.includes('/api/clinics/patients'))).toEqual([]);
    expect(aPacotes(chamadas)).toEqual([]);
  });
});

describe('ficha do paciente — abas e resumo (ADR-062)', () => {
  const ficha = (permissoes: string[], extra: Record<string, Rota> = {}) =>
    mockApi({
      'GET /api/auth/me': { body: usuario(permissoes) },
      ...catalogo,
      [`GET /api/clinics/patients/${PAC}`]: {
        body: { id: PAC, name: 'Paciente Fictícia', createdAt: '2030-01-01T00:00:00Z' },
      },
      'GET /api/clinics/returns': { body: [retorno()] },
      ...extra,
    });
  /** a URL da tela, para conferir o `?aba=` sem perder o `?id=` */
  function Endereco() {
    return <output data-testid="endereco">{useLocation().search}</output>;
  }

  it('só as abas que a pessoa pode ver; a primeira abre; as setas trocam, e a URL guarda a aba sem perder o id', async () => {
    ficha(PROFISSIONAL, { 'GET /api/clinics/packages': { body: [pacote(P1)] } });
    renderizar(
      <>
        <ClinicsPatientPage />
        <Endereco />
      </>,
      `/clinics/patient?id=${PAC}`,
    );
    const abas = await screen.findAllByRole('tab');
    // sem contato vinculado, nem notas nem contato
    expect(abas.map((a) => a.textContent)).toEqual(['Pacotes', 'Retornos']);
    const pacotes = screen.getByRole('tab', { name: 'Pacotes' });
    expect(pacotes).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Pacotes');
    expect(await screen.findByRole('region', { name: 'Pacotes do paciente' })).toBeInTheDocument();

    fireEvent.keyDown(pacotes, { key: 'ArrowRight' });
    const retornos = screen.getByRole('tab', { name: 'Retornos' });
    expect(retornos).toHaveAttribute('aria-selected', 'true');
    expect(retornos).toHaveFocus();
    expect(screen.getByRole('region', { name: 'Retornos do paciente' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Pacotes do paciente' })).toBeNull();
    const busca = new URLSearchParams(screen.getByTestId('endereco').textContent ?? '');
    expect(busca.get('id')).toBe(PAC);
    expect(busca.get('aba')).toBe('retornos');
    // a seta passa do fim e volta ao começo
    fireEvent.keyDown(retornos, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Pacotes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('`?aba=pacotes` sem `care:read` cai na primeira aba, e nenhuma consulta a pacotes sai', async () => {
    const chamadas = ficha(RECEPCAO, { 'GET /api/clinics/packages': { body: [pacote(P1)] } });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}&aba=pacotes`);
    expect(await screen.findByRole('tab', { name: 'Retornos' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByRole('region', { name: 'Retornos do paciente' })).toBeInTheDocument();
    await waitFor(() =>
      expect(chamadas.some((c) => c.chave.includes('/api/clinics/returns'))).toBe(true),
    );
    expect(aPacotes(chamadas)).toEqual([]);
  });

  it('o resumo: os retornos pendentes (o vencido marcado) e os pacotes ATIVOS com as sessões; a mesma consulta da aba', async () => {
    const chamadas = ficha(PROFISSIONAL, {
      'GET /api/clinics/returns': {
        body: [
          retorno({ overdue: true, dueDate: '2030-10-01' }),
          retorno({ id: 'r2', status: 'done', serviceName: 'Peeling', serviceId: S2 }),
        ],
      },
      'GET /api/clinics/packages': {
        body: [
          pacote(P1),
          pacote(P2, { status: 'completed', consumedSessions: 10, remainingSessions: 0 }),
        ],
      },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    const resumo = await screen.findByRole('complementary', { name: 'Resumo do paciente' });
    const pendentes = within(resumo).getByRole('region', { name: 'Retornos pendentes' });
    expect(await within(pendentes).findByText('Limpeza')).toBeInTheDocument();
    expect(within(pendentes).getByText('01/10/2030')).toBeInTheDocument();
    expect(within(pendentes).getByText('Vencido')).toBeInTheDocument();
    // o concluído não é pendente
    expect(within(pendentes).queryByText('Peeling')).toBeNull();

    const ativos = within(resumo).getByRole('region', { name: 'Pacotes ativos' });
    expect(
      await within(ativos).findByRole('img', { name: '3 de 10 sessões usadas' }),
    ).toBeInTheDocument();
    expect(within(ativos).getAllByRole('listitem')).toHaveLength(1);
    // aba e resumo dividem a consulta: um pedido de pacotes só
    expect(aPacotes(chamadas)).toHaveLength(1);

    // "Ver retornos" leva à aba
    fireEvent.click(within(resumo).getByRole('button', { name: 'Ver retornos' }));
    expect(screen.getByRole('tab', { name: 'Retornos' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a falha dos pacotes no resumo não mostra dado antigo', async () => {
    let falhar = false;
    ficha(PROFISSIONAL, {
      'GET /api/clinics/packages': () =>
        falhar ? { status: 500, body: { message: 'x' } } : { body: [pacote(P1)] },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    const ativos = await screen.findByRole('region', { name: 'Pacotes ativos' });
    expect(
      await within(ativos).findByRole('img', { name: '3 de 10 sessões usadas' }),
    ).toBeInTheDocument();
    falhar = true;
    recarregar();
    expect(await within(ativos).findByText('Pacotes indisponíveis agora.')).toBeInTheDocument();
    expect(within(ativos).queryByRole('img')).toBeNull();
  });
});

describe('ficha do paciente — notas e tarefas (F5.3b)', () => {
  const CONTATO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31';
  const CHAVE = 'clinics:patient-content:read';
  const ficha = (permissoes: string[], extra: Record<string, Rota> = {}) =>
    mockApi({
      'GET /api/auth/me': { body: usuario(permissoes) },
      ...catalogo,
      [`GET /api/clinics/patients/${PAC}`]: {
        body: {
          id: PAC,
          name: 'Paciente Fictícia',
          contactId: CONTATO,
          createdAt: '2030-01-01T00:00:00Z',
        },
      },
      'GET /api/clinics/returns': { body: [] },
      'GET /api/tasks': {
        body: {
          items: [{ id: 't1', title: 'Ligar sobre o retorno', status: 'open', dueAt: null }],
          total: 1,
          page: 1,
          pageSize: 20,
        },
      },
      'GET /api/notes': {
        body: [
          {
            id: 'n1',
            body: 'Prefere à tarde (fictício)',
            authorName: 'Ana',
            createdAt: '2030-01-02T12:00:00Z',
          },
        ],
      },
      ...extra,
    });
  const aConteudo = (chamadas: { chave: string }[]) =>
    chamadas.filter((c) => /\/api\/(tasks|notes)/.test(c.chave));
  // as notas ficam na aba delas (ADR-062): abrir a aba e achar a seção
  const regiao = async () => {
    fireEvent.click(await screen.findByRole('tab', { name: 'Notas e tarefas' }));
    return screen.findByRole('region', { name: 'Notas e tarefas do paciente' });
  };

  it('a recepção (com tasks:read, sem a chave): "Conteúdo restrito" e NENHUMA consulta a notas ou tarefas', async () => {
    const chamadas = ficha([...RECEPCAO, 'tasks:read']);
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    expect(within(await regiao()).getByText('Conteúdo restrito')).toBeInTheDocument();
    await waitFor(() =>
      expect(chamadas.some((c) => c.chave.includes('/api/clinics/returns'))).toBe(true),
    );
    expect(aConteudo(chamadas)).toEqual([]);
    expect(screen.queryByText('Ligar sobre o retorno')).toBeNull();
  });

  it('com tasks:read e a chave: as tarefas e as notas do paciente, pelo contato dele', async () => {
    const chamadas = ficha([...RECEPCAO, 'tasks:read', CHAVE]);
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    const r = await regiao();
    expect(await within(r).findByText('Ligar sobre o retorno')).toBeInTheDocument();
    expect(within(r).getByText('Prefere à tarde (fictício)')).toBeInTheDocument();
    expect(within(r).queryByText('Conteúdo restrito')).toBeNull();
    expect(aConteudo(chamadas).every((c) => c.chave.includes(`contactId=${CONTATO}`))).toBe(true);
  });

  it('o servidor recusa (a chave retirada no meio da sessão): "Conteúdo restrito", sem conteúdo', async () => {
    ficha([...RECEPCAO, 'tasks:read', CHAVE], {
      'GET /api/notes': { status: 403, body: { message: 'Conteúdo restrito' } },
    });
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    const r = await regiao();
    expect(await within(r).findByText('Conteúdo restrito')).toBeInTheDocument();
    expect(within(r).queryByText('Ligar sobre o retorno')).toBeNull();
  });

  it('sem tasks:read, a seção não existe (a chave sozinha não concede nada)', async () => {
    const chamadas = ficha([...RECEPCAO, CHAVE]);
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    expect(await screen.findByRole('region', { name: 'Retornos do paciente' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Notas e tarefas do paciente' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Notas e tarefas' })).toBeNull();
    expect(aConteudo(chamadas)).toEqual([]);
  });
});

describe('retornos', () => {
  it('a recepção vê o cancelado SEM motivo (a projeção do servidor) e só os motivos operacionais', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/returns/assignees': { body: [] },
      'GET /api/clinics/returns': {
        body: [
          retorno(),
          retorno({ id: R1.replace('21', '22'), status: 'canceled', dueDate: '2030-12-02' }),
        ],
      },
    });
    renderizar(<ClinicsReturnsPage />, '/clinics/returns');
    const cancelado = await screen.findByRole('row', {
      name: 'Retorno de Paciente Fictícia, Limpeza, vence 02/12/2030',
    });
    expect(within(cancelado).getByText('Cancelado')).toBeInTheDocument();
    const pendente = screen.getByRole('row', {
      name: 'Retorno de Paciente Fictícia, Limpeza, vence 01/12/2030',
    });
    fireEvent.click(
      within(pendente).getByRole('button', {
        name: 'Cancelar: Paciente Fictícia, Limpeza, vence 01/12/2030',
      }),
    );
    const painel = await screen.findByRole('dialog', { name: 'Cancelar retorno' });
    const opcoes = within(painel)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(opcoes).toEqual(['Escolha o motivo', 'Paciente recusou', 'Paciente não encontrado']);
  });

  it('os motivos conforme a permissão e a origem visível', () => {
    expect(motivosPermitidos(true, false)).toEqual(['patient_declined', 'patient_unreachable']);
    expect(motivosPermitidos(false, true, 'automatic')).toEqual([
      'patient_declined',
      'patient_unreachable',
      'not_needed',
    ]);
    expect(motivosPermitidos(false, true, 'manual')).toContain('created_in_error');
    // sem a origem visível, "criado por engano" não aparece
    expect(motivosPermitidos(false, true)).not.toContain('created_in_error');
    expect(motivosPermitidos(false, false)).toEqual([]);
  });

  it('os candidatos ao vínculo são paginados: "carregar mais" segue o cursor do servidor', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/returns/assignees': { body: [] },
      [`GET /api/clinics/returns/${R1}/candidates`]: () => {
        const ultima = chamadas[chamadas.length - 1].chave;
        return ultima.includes('cursor=c1')
          ? {
              body: {
                items: [
                  {
                    id: 'a2',
                    startsAt: '2030-11-05T12:00:00.000Z',
                    status: 'scheduled',
                    professionalName: 'Ana Fictícia',
                  },
                ],
                nextCursor: null,
              },
            }
          : {
              body: {
                items: [
                  {
                    id: 'a1',
                    startsAt: '2030-11-04T12:00:00.000Z',
                    status: 'scheduled',
                    professionalName: 'Ana Fictícia',
                  },
                ],
                nextCursor: 'c1',
              },
            };
      },
      'GET /api/clinics/returns': { body: [retorno()] },
    });
    renderizar(<ClinicsReturnsPage />, '/clinics/returns');
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Vincular agendamento: Paciente Fictícia, Limpeza, vence 01/12/2030',
      }),
    );
    const painel = await screen.findByRole('dialog', { name: 'Vincular agendamento' });
    expect(
      await within(painel).findByRole('button', {
        name: 'Vincular o agendamento de 04/11/2030 09:00',
      }),
    ).toBeInTheDocument();
    fireEvent.click(within(painel).getByRole('button', { name: 'Carregar mais' }));
    expect(
      await within(painel).findByRole('button', {
        name: 'Vincular o agendamento de 05/11/2030 09:00',
      }),
    ).toBeInTheDocument();
    expect(within(painel).queryByRole('button', { name: 'Carregar mais' })).toBeNull();
    expect(within(painel).getByText(/pode concluir o retorno/)).toBeInTheDocument();
  });

  it.each([
    [100, false],
    [101, true],
  ])('o teto da lista: pede 101 e mostra 100; com %i retornos, aviso=%s', async (total, aviso) => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/returns/assignees': { body: [] },
      'GET /api/clinics/returns': {
        body: Array.from({ length: total }, (_, i) =>
          retorno({ id: `r${i}`, dueDate: `2030-12-${String((i % 28) + 1).padStart(2, '0')}` }),
        ),
      },
    });
    renderizar(<ClinicsReturnsPage />, '/clinics/returns');
    await waitFor(() =>
      expect(screen.getAllByRole('row', { name: /^Retorno de / })).toHaveLength(100),
    );
    if (aviso) expect(screen.getByText(/Mostrando os 100 primeiros/)).toBeInTheDocument();
    else expect(screen.queryByText(/Mostrando os 100 primeiros/)).toBeNull();
    expect(chamadas.some((c) => /\/api\/clinics\/returns\?.*limit=101/.test(c.chave))).toBe(true);
  });

  it('a RECARGA que falha: o alerta, e as linhas antigas somem', async () => {
    let falhar = false;
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/returns/assignees': { body: [] },
      'GET /api/clinics/returns': () =>
        falhar ? { status: 500, body: { message: 'x' } } : { body: [retorno()] },
    });
    renderizar(<ClinicsReturnsPage />, '/clinics/returns');
    expect(
      await screen.findByRole('row', {
        name: 'Retorno de Paciente Fictícia, Limpeza, vence 01/12/2030',
      }),
    ).toBeInTheDocument();
    falhar = true;
    recarregar();
    expect(await screen.findByText('Não foi possível carregar os retornos.')).toBeInTheDocument();
    expect(
      screen.queryByRole('row', {
        name: 'Retorno de Paciente Fictícia, Limpeza, vence 01/12/2030',
      }),
    ).toBeNull();
  });
});

describe('taxa de faltas', () => {
  it('"Sem dados" (null) e 0 % são coisas diferentes', () => {
    expect(taxaLegivel(null)).toBe('Sem dados');
    expect(taxaLegivel(0)).toBe('0 %');
    expect(taxaLegivel(0.25)).toBe('25 %');
    // o arredondamento não apaga a diferença nas pontas
    expect(taxaLegivel(0.0004)).toBe('< 0,1 %');
    expect(taxaLegivel(0.9996)).toBe('> 99,9 %');
    // no limite exato (1999 faltas em 2000), nem "100 %"
    expect(taxaLegivel(1999 / 2000)).toBe('> 99,9 %');
    expect(taxaLegivel(1)).toBe('100 %');
  });

  it.each([
    [
      'sem dados',
      { attended: 0, noShow: 0, rate: null, pendingPast: 2, canceled: 1 },
      'Sem dados',
      /Nenhum atendido nem falta/,
    ],
    [
      '0 % legítimo',
      { attended: 4, noShow: 0, rate: 0, pendingPast: 0, canceled: 0 },
      '0 %',
      /0 faltas em 4 \(atendidos \+ faltas\)/,
    ],
  ])('na tela: %s', async (_caso, dado, taxa, detalhe) => {
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/metrics/no-show': {
        body: { from: '2030-10-06', to: '2030-11-05', unitId: U, ...dado },
      },
    });
    renderizar(<ClinicsNoShowPage />, '/clinics/no-show');
    const resumo = await screen.findByLabelText('Taxa de faltas');
    expect(within(resumo).getByText(taxa)).toBeInTheDocument();
    expect(within(resumo).getByText(detalhe)).toBeInTheDocument();
  });

  it('a RECARGA que falha: nenhum número antigo', async () => {
    let falhar = false;
    mockApi({
      'GET /api/auth/me': { body: usuario(RECEPCAO) },
      ...catalogo,
      'GET /api/clinics/metrics/no-show': () =>
        falhar
          ? { status: 500, body: { message: 'Falhou' } }
          : {
              body: {
                from: '2030-10-06',
                to: '2030-11-05',
                unitId: U,
                attended: 3,
                noShow: 1,
                rate: 0.25,
                pendingPast: 0,
                canceled: 0,
              },
            },
    });
    renderizar(<ClinicsNoShowPage />, '/clinics/no-show');
    expect(await screen.findByText('25 %')).toBeInTheDocument();
    falhar = true;
    recarregar();
    expect(await screen.findByRole('alert')).toHaveTextContent('Falhou');
    expect(screen.queryByText('25 %')).toBeNull();
  });
});

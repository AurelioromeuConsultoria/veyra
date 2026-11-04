import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUserDto, ConversationDto } from '@veyra/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ExperienceProvider } from '../../lib/experience';
import { ME_KEY } from '../../lib/session';
import { ContextoDaConversa } from '../../pages/InboxContexto';
import { clinicsExperience } from './experience';

/**
 * O contexto clínico nas Conversas, por composição (ADR-062, adendo 1, item
 * 5). Dados FICTÍCIOS. O que se prova, pelo painel do CORE com o manifesto da
 * clínica:
 *
 * - sem `clinics:schedule:read` (ou sem `contacts:read`), o encaixe não
 *   consulta nada da clínica e o painel sai IGUAL para paciente e interessado;
 * - a RAI nunca leva contato ao encaixe;
 * - com as chaves, cada bloco tem a sua: o próximo horário e os retornos com a
 *   agenda, os pacotes só com `clinics:care:read`, a ficha com a porta dela;
 * - o 400 da consulta de horários (o servidor que ainda não a aceita) é "sem
 *   dado": o bloco some, e os outros seguem.
 */

const CONVERSA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e51';
const PACIENTE_CONTATO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e52';
const INTERESSADO_CONTATO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e53';
const PACIENTE = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e54';

const conversa = (extra: Partial<ConversationDto> = {}): ConversationDto => ({
  id: CONVERSA,
  channelType: 'whatsapp',
  contactId: PACIENTE_CONTATO,
  contactName: 'Pessoa Fictícia',
  senderStatus: 'identified',
  senderAddress: '+5511987654321',
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: null,
  status: 'open',
  assigneeMembershipId: null,
  assigneeName: null,
  lastMessageAt: '2030-11-04T12:00:00.000Z',
  windowExpiresAt: null,
  createdAt: '2030-11-04T11:00:00.000Z',
  ...extra,
});

const usuario = (permissions: string[]) =>
  ({
    id: 'u1',
    name: 'Pessoa da Clínica',
    email: 'pessoa@clinica.test',
    activeMembership: {
      membershipId: 'm1',
      workspaceId: 'w1',
      workspaceName: 'Clínica',
      workspaceSlug: 'clinica',
      roleName: 'Member',
      roleSystemKey: 'member',
      status: 'active',
    },
    permissions,
    memberships: [],
    experience: { key: 'clinics', status: 'ready' },
  }) as unknown as AuthUserDto;

const BASE = ['conversations:read', 'contacts:read'];
const AGENDA = [...BASE, 'clinics:schedule:read', 'clinics:catalog:read'];
const COMPLETO = [...AGENDA, 'clinics:care:read'];

const daqui = (dias: number) => new Date(Date.now() + dias * 86_400_000).toISOString();
const horario = (id: string, startsAt: string, status: string) => ({
  id,
  patientId: PACIENTE,
  patientName: 'Pessoa Fictícia',
  professionalId: 'pr1',
  professionalName: 'Dra. Ana Fictícia',
  serviceId: 'sv1',
  serviceName: 'Limpeza de pele',
  unitId: 'un1',
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  localDate: startsAt.slice(0, 10),
  localStart: startsAt.slice(11, 16),
  localEnd: startsAt.slice(11, 16),
  status,
  cancelReason: null,
});

type Resposta = { status?: number; body?: unknown };

function mockApi(rotas: Record<string, Resposta>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      chamadas.push(url);
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => url.startsWith(prefixo));
      const r = rota ? rotas[rota] : { status: 404, body: { message: `sem mock: ${url}` } };
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

/** a clínica com um paciente, um interessado, horários, retornos e pacotes */
const CLINICA: Record<string, Resposta> = {
  '/api/clinics/status': { body: { active: true } },
  [`/api/clinics/patients?contactIds=${PACIENTE_CONTATO}`]: {
    body: [{ id: PACIENTE, contactId: PACIENTE_CONTATO, name: 'Pessoa Fictícia' }],
  },
  [`/api/clinics/patients?contactIds=${INTERESSADO_CONTATO}`]: { body: [] },
  '/api/clinics/appointments': {
    body: [
      horario('h-cancelado', daqui(1), 'canceled'),
      horario('h-depois', daqui(9), 'scheduled'),
      horario('h-proximo', daqui(2), 'confirmed'),
    ],
  },
  '/api/clinics/returns': {
    body: [
      {
        id: 'r1',
        patientId: PACIENTE,
        patientName: 'Pessoa Fictícia',
        serviceId: 'sv1',
        serviceName: 'Retorno de avaliação',
        dueDate: '2030-11-20',
        status: 'pending',
        overdue: false,
        assignee: null,
      },
      {
        id: 'r2',
        patientId: PACIENTE,
        patientName: 'Pessoa Fictícia',
        serviceId: 'sv1',
        serviceName: 'Outro',
        dueDate: '2030-10-01',
        status: 'done',
        overdue: false,
        assignee: null,
      },
    ],
  },
  '/api/clinics/packages': {
    body: [
      {
        id: 'pk1',
        patientId: PACIENTE,
        serviceId: 'sv1',
        totalSessions: 5,
        consumedSessions: 1,
        remainingSessions: 4,
        totalPriceCents: null,
        currency: 'BRL',
        status: 'active',
        createdAt: '2030-10-01T12:00:00.000Z',
        closedAt: null,
      },
    ],
  },
  '/api/clinics/services': { body: [{ id: 'sv1', name: 'Limpeza de pele' }] },
};

function renderizar(permissions: string[], c: ConversationDto) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(ME_KEY, usuario(permissions));
  const r = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExperienceProvider value={clinicsExperience}>
          <ContextoDaConversa conversa={c} janelaExpiraEm={null} />
        </ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...r, painel: screen.getByRole('complementary', { name: 'Contexto da conversa' }) };
}

/** espera as consultas assentarem (o status e o que vier depois dele) */
const assentar = () => new Promise((r) => setTimeout(r, 60));

/**
 * O que o painel diz: o texto e os papéis acessíveis. O avatar (cor por id) e o
 * destino do link do Core variam com o contato por construção, não pela clínica.
 */
const vistaDo = (painel: HTMLElement) => ({
  texto: painel.textContent,
  grupos: within(painel)
    .queryAllByRole('group')
    .map((g) => g.getAttribute('aria-label')),
  regioes: within(painel).queryAllByRole('region').length,
  links: within(painel)
    .queryAllByRole('link')
    .map((l) => l.textContent),
});

/** só os pedidos que dizem algo do contato (o status do vertical é do workspace) */
const doContato = (chamadas: string[]) =>
  chamadas.filter((u) => u.startsWith('/api/clinics/') && !u.startsWith('/api/clinics/status'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Contexto clínico da conversa (encaixe do manifesto)', () => {
  it('sem a agenda: nada é consultado e o painel é o MESMO para paciente e interessado', async () => {
    const chamadas = mockApi(CLINICA);
    const p = renderizar(BASE, conversa());
    await assentar();
    expect(within(p.painel).queryByRole('region', { name: 'Contexto clínico' })).toBeNull();
    const vistaPaciente = vistaDo(p.painel);
    p.unmount();

    const i = renderizar(BASE, conversa({ contactId: INTERESSADO_CONTATO }));
    await assentar();
    // o mesmo contato visível (o nome) e nada da clínica: a vista é idêntica
    expect(vistaDo(i.painel)).toEqual(vistaPaciente);
    expect(within(i.painel).queryByText('Sem ficha de paciente.')).toBeNull();
    expect(doContato(chamadas)).toEqual([]);
  });

  it('sem contacts:read: a agenda sozinha não refaz o vínculo — nada é consultado', async () => {
    const chamadas = mockApi(CLINICA);
    const { painel } = renderizar(
      ['conversations:read', 'clinics:schedule:read', 'clinics:catalog:read'],
      conversa(),
    );
    await assentar();
    expect(within(painel).queryByText(/Próximo horário|Sem ficha/)).toBeNull();
    expect(doContato(chamadas)).toEqual([]);
  });

  it('a RAI não leva contato ao encaixe: nada da clínica', async () => {
    const chamadas = mockApi(CLINICA);
    const { painel } = renderizar(
      COMPLETO,
      conversa({ senderStatus: 'unidentified', contactId: null, contactName: null }),
    );
    await assentar();
    expect(within(painel).queryByText(/Próximo horário|Sem ficha/)).toBeNull();
    expect(doContato(chamadas)).toEqual([]);
  });

  it('paciente, com todas as chaves: próximo horário, retornos, pacotes e a ficha', async () => {
    const chamadas = mockApi(CLINICA);
    const { painel } = renderizar(COMPLETO, conversa());
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });

    const proximo = await within(clinico).findByRole('group', { name: 'Próximo horário' });
    // o confirmado de daqui a 2 dias: nem o cancelado, nem o de depois
    const esperado = (
      CLINICA['/api/clinics/appointments'].body as { id: string; localStart: string }[]
    ).find((h) => h.id === 'h-proximo')!;
    expect(
      await within(proximo).findByText(esperado.localStart, { exact: false }),
    ).toBeInTheDocument();
    expect(within(proximo).getByText('Limpeza de pele · Dra. Ana Fictícia')).toBeInTheDocument();
    expect(within(proximo).getByText('Confirmado')).toBeInTheDocument();

    const retornos = within(clinico).getByRole('group', { name: 'Retornos pendentes' });
    await waitFor(() => expect(retornos).toHaveTextContent(/1 pendente(?!s)/));
    expect(within(retornos).getByText(/Retorno de avaliação/)).toBeInTheDocument();

    const pacotes = within(clinico).getByRole('group', { name: 'Pacotes ativos' });
    await waitFor(() => expect(pacotes).toHaveTextContent('Limpeza de pele · 4 de 5 restantes'));

    expect(
      within(clinico).getByRole('link', { name: /Abrir a ficha do paciente/ }),
    ).toHaveAttribute('href', `/clinics/patient?id=${PACIENTE}`);
    // o intervalo pedido tem 30 dias de distância, por paciente
    const pedido = chamadas.find((u) => u.startsWith('/api/clinics/appointments'))!;
    const q = new URL(pedido, 'http://x').searchParams;
    expect(q.get('patientId')).toBe(PACIENTE);
    expect((Date.parse(q.get('to')!) - Date.parse(q.get('from')!)) / 86_400_000).toBe(30);
  });

  it('sem clinics:care:read: os pacotes nem são consultados', async () => {
    const chamadas = mockApi(CLINICA);
    const { painel } = renderizar(AGENDA, conversa());
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });
    await waitFor(() => expect(clinico).toHaveTextContent(/1 pendente(?!s)/));
    expect(within(clinico).queryByRole('group', { name: 'Pacotes ativos' })).toBeNull();
    expect(chamadas.some((u) => u.startsWith('/api/clinics/packages'))).toBe(false);
  });

  it('sem o catálogo: sem o link da ficha (a porta dela pede as duas chaves)', async () => {
    mockApi(CLINICA);
    const { painel } = renderizar(
      ['conversations:read', 'contacts:read', 'clinics:schedule:read'],
      conversa(),
    );
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });
    await waitFor(() => expect(clinico).toHaveTextContent(/1 pendente(?!s)/));
    expect(within(clinico).queryByRole('link')).toBeNull();
  });

  it('interessado, com a agenda: diz que não há ficha e não consulta horário, retorno nem pacote', async () => {
    const chamadas = mockApi(CLINICA);
    const { painel } = renderizar(COMPLETO, conversa({ contactId: INTERESSADO_CONTATO }));
    expect(await within(painel).findByText('Sem ficha de paciente.')).toBeInTheDocument();
    expect(doContato(chamadas)).toEqual([
      `/api/clinics/patients?contactIds=${INTERESSADO_CONTATO}`,
    ]);
  });

  it('o 400 dos horários é "sem dado": o bloco some e os outros seguem', async () => {
    mockApi({
      ...CLINICA,
      '/api/clinics/appointments': { status: 400, body: { message: 'Data inválida' } },
    });
    const { painel } = renderizar(COMPLETO, conversa());
    const clinico = await within(painel).findByRole('region', { name: 'Contexto clínico' });
    await waitFor(() => expect(clinico).toHaveTextContent('Limpeza de pele · 4 de 5 restantes'));
    await assentar();
    expect(within(clinico).queryByRole('group', { name: 'Próximo horário' })).toBeNull();
    expect(within(clinico).queryByText('Agenda indisponível agora.')).toBeNull();
  });

  it('outro erro dos horários aparece como indisponível, sem dado antigo', async () => {
    mockApi({
      ...CLINICA,
      '/api/clinics/appointments': { status: 500, body: { message: 'falhou' } },
    });
    const { painel } = renderizar(COMPLETO, conversa());
    expect(await within(painel).findByText('Agenda indisponível agora.')).toBeInTheDocument();
  });
});

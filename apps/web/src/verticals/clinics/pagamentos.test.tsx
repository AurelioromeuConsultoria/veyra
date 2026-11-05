import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ExperienceProvider } from '../../lib/experience';
import { criarQueryClient } from '../../lib/session-query';
import { clinicsExperience } from './experience';
import { PagamentosDoPaciente } from './pagamentos/PagamentosDoPaciente';
import { ClinicsPatientPage } from './PatientPage';

/**
 * A aba "Pagamentos" da ficha (ADR-063, F6.1a). Dados FICTÍCIOS. O que se
 * prova: a aba só existe com `payments:read`; a lista destaca o saldo pendente e
 * identifica o não calculável; o painel mostra o histórico com autoria e a
 * anulação riscada; registrar e anular levam a `Idempotency-Key`, com as ações
 * só para quem tem a chave.
 */

type Resposta = { status?: number; body?: unknown };
type Rota = Resposta | ((corpo: unknown) => Resposta);

/** fetch falso por rota ("GET /api/…", prefixo mais longo vence); registra toda chamada. */
function mockApi(rotas: Record<string, Rota>) {
  const chamadas: { chave: string; corpo?: unknown; headers: Headers }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
      chamadas.push({ chave, corpo, headers: new Headers(init?.headers) });
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => chave.startsWith(prefixo));
      const definida: Rota = rota
        ? rotas[rota]
        : { status: 404, body: { message: `sem mock: ${chave}` } };
      const resposta = typeof definida === 'function' ? definida(corpo) : definida;
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
    roleName: 'Admin',
    status: 'active',
  },
  permissions,
  memberships: [],
});

const AGENDA = ['clinics:catalog:read', 'clinics:schedule:read'];
const LE = [...AGENDA, 'clinics:payments:read'];
const TUDO = [...LE, 'clinics:payments:write', 'clinics:payments:void'];

const PAC = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05';
const P1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e11';
const P2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e12';
const P3 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e13';
const PG1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31';
const PG2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e32';

const saldo = (extra: Record<string, unknown> = {}) => ({
  packageId: P1,
  patientId: PAC,
  serviceId: 'S1',
  serviceName: 'Limpeza de pele',
  status: 'active',
  totalPriceCents: 100_000,
  currency: 'BRL',
  receivedCents: 40_000,
  balanceCents: 60_000,
  createdAt: '2030-01-01T12:00:00.000Z',
  ...extra,
});

const pagamento = (extra: Record<string, unknown> = {}) => ({
  id: PG1,
  packageId: P1,
  amountCents: 40_000,
  currency: 'BRL',
  receivedOn: '2026-11-03',
  method: 'pix',
  createdBy: { membershipId: 'm1', name: 'Fulana Fictícia' },
  createdAt: '2026-11-05T17:32:00.000Z',
  void: null,
  ...extra,
});

const detalhe = (pagamentos: unknown[], extra: Record<string, unknown> = {}) => ({
  package: saldo(extra),
  payments: pagamentos,
  today: '2026-11-05',
});

let client: QueryClient;
function renderizar(ui: ReactNode, caminho = '/') {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const abrirPainel = async (servico = 'Limpeza de pele') => {
  fireEvent.click(
    await screen.findByRole('button', { name: `Pagamentos do pacote de ${servico}` }),
  );
  return screen.findByRole('dialog');
};

describe('a aba Pagamentos da ficha', () => {
  const ficha = (permissoes: string[]) =>
    mockApi({
      'GET /api/auth/me': { body: usuario(permissoes) },
      'GET /api/clinics/status': { body: { active: true } },
      [`GET /api/clinics/patients/${PAC}`]: {
        body: { id: PAC, name: 'Paciente Fictícia', createdAt: '2030-01-01T00:00:00Z' },
      },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: { body: [saldo()] },
      'GET /api/clinics/returns': { body: [] },
    });

  it('sem `payments:read`: a aba não existe e nenhuma consulta de pagamentos é feita', async () => {
    const chamadas = ficha(AGENDA);
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}`);
    expect(await screen.findByRole('heading', { name: 'Paciente Fictícia' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Pagamentos' })).toBeNull();
    expect(chamadas.some((c) => c.chave.includes('package-payments'))).toBe(false);
  });

  it('com `payments:read`: a aba existe e mostra os pacotes', async () => {
    ficha(LE);
    renderizar(<ClinicsPatientPage />, `/clinics/patient?id=${PAC}&aba=pagamentos`);
    expect(await screen.findByRole('tab', { name: 'Pagamentos' })).toBeInTheDocument();
    expect(
      await screen.findByRole('region', { name: 'Pagamentos do paciente' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('row', { name: 'Pacote de Limpeza de pele' })).toBeVisible();
  });
});

describe('a lista e o painel', () => {
  it('destaca o saldo pendente, identifica o não calculável e o cancelado', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(LE) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: {
        body: [
          saldo(),
          saldo({
            packageId: P2,
            serviceName: 'Peeling',
            totalPriceCents: null,
            receivedCents: 5_000,
            balanceCents: null,
          }),
          saldo({ packageId: P3, serviceName: 'Drenagem', status: 'canceled' }),
        ],
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const ativo = await screen.findByRole('row', { name: 'Pacote de Limpeza de pele' });
    expect(within(ativo).getByText(/a receber/)).toBeInTheDocument();
    expect(within(ativo).getByText('Ativo')).toBeInTheDocument();
    const semPreco = screen.getByRole('row', { name: 'Pacote de Peeling' });
    expect(
      within(semPreco).getByText('Saldo não calculável — preço não registrado'),
    ).toBeInTheDocument();
    expect(within(semPreco).getByText('Não registrado')).toBeInTheDocument();
    // o cancelado não aparece como pendência
    const cancelado = screen.getByRole('row', { name: 'Pacote de Drenagem' });
    expect(within(cancelado).queryByText(/a receber/)).toBeNull();
  });

  it('o histórico: autoria e instante; o anulado riscado, com quem, quando e o motivo; sem `write`/`void`, sem ações', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(LE) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: { body: [saldo()] },
      [`GET /api/clinics/packages/${P1}/payments`]: {
        body: detalhe([
          pagamento({ id: PG2, amountCents: 30_000, method: 'cash' }),
          pagamento({
            void: {
              reason: 'duplicate',
              voidedBy: { membershipId: 'm2', name: 'Beltrana Fictícia' },
              createdAt: '2026-11-05T18:00:00.000Z',
            },
          }),
        ]),
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const painel = await abrirPainel();
    expect(
      await within(painel).findAllByText(
        /registrado por Fulana Fictícia em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/,
      ),
    ).toHaveLength(2);
    expect(
      within(painel).getByText(/anulado por Beltrana Fictícia em .*motivo: duplicado/),
    ).toBeVisible();
    expect(within(painel).getByText(/R\$\s400,00 · Pix/)).toHaveClass('line-through');
    expect(within(painel).getByText(/R\$\s300,00 · Dinheiro/)).not.toHaveClass('line-through');
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    expect(within(painel).queryByRole('button', { name: /^Anular/ })).toBeNull();
  });

  it('registrar: o valor vem com o saldo e a data com hoje; a confirmação manda com Idempotency-Key', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(TUDO) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: { body: [saldo()] },
      [`GET /api/clinics/packages/${P1}/payments`]: { body: detalhe([pagamento()]) },
      [`POST /api/clinics/packages/${P1}/payments`]: {
        status: 201,
        body: pagamento({ id: PG2, amountCents: 60_000 }),
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const painel = await abrirPainel();
    fireEvent.click(await within(painel).findByRole('button', { name: 'Registrar pagamento' }));
    expect(within(painel).getByLabelText(/Valor recebido/)).toHaveValue('600,00');
    expect(within(painel).getByLabelText(/Data do recebimento/)).toHaveValue('2026-11-05');
    // sem a forma, não revisa
    const revisar = within(painel).getByRole('button', { name: 'Revisar pagamento' });
    expect(revisar).toBeDisabled();
    // acima do saldo, também não
    fireEvent.change(within(painel).getByLabelText(/Valor recebido/), {
      target: { value: '600,01' },
    });
    fireEvent.change(within(painel).getByLabelText('Forma'), { target: { value: 'pix' } });
    expect(within(painel).getByText('O valor passa do saldo do pacote.')).toBeVisible();
    expect(revisar).toBeDisabled();
    fireEvent.change(within(painel).getByLabelText(/Valor recebido/), {
      target: { value: '600,00' },
    });
    fireEvent.click(within(painel).getByRole('button', { name: 'Revisar pagamento' }));
    expect(within(painel).getByText(/Registrar o recebimento de/)).toHaveTextContent(
      /R\$\s600,00 em pix, recebido em 05\/11\/2026/,
    );
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar registro' }));
    expect(await within(painel).findByRole('status')).toHaveTextContent(
      /Pagamento de R\$\s600,00 registrado/,
    );
    const post = chamadas.find((c) => c.chave.startsWith('POST'));
    expect(post?.corpo).toEqual({ amountCents: 60_000, receivedOn: '2026-11-05', method: 'pix' });
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pacote cancelado: sem "Registrar pagamento", com "Anular"; a anulação pede o motivo e manda com Idempotency-Key', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(TUDO) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: {
        body: [saldo({ status: 'canceled' })],
      },
      [`GET /api/clinics/packages/${P1}/payments`]: {
        body: detalhe([pagamento()], { status: 'canceled' }),
      },
      [`POST /api/clinics/package-payments/${PG1}/void`]: {
        status: 201,
        body: pagamento({
          void: {
            reason: 'wrong_amount',
            voidedBy: { membershipId: 'm1', name: 'Pessoa Fictícia' },
            createdAt: '2026-11-05T18:00:00.000Z',
          },
        }),
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const painel = await abrirPainel();
    expect(
      await within(painel).findByText(/Pacote cancelado: não recebe pagamento novo/),
    ).toBeVisible();
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    fireEvent.click(
      within(painel).getByRole('button', {
        name: /^Anular o pagamento de R\$\s400,00 recebido em 03\/11\/2026$/,
      }),
    );
    const confirmar = within(painel).getByRole('button', { name: 'Confirmar anulação' });
    expect(confirmar).toBeDisabled();
    fireEvent.change(within(painel).getByLabelText('Motivo'), {
      target: { value: 'wrong_amount' },
    });
    fireEvent.click(confirmar);
    expect(await within(painel).findByRole('status')).toHaveTextContent(/anulado/);
    await waitFor(() => {
      const post = chamadas.find((c) => c.chave.startsWith('POST'));
      expect(post?.corpo).toEqual({ reason: 'wrong_amount' });
      expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

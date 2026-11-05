import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ExperienceProvider } from '../../lib/experience';
import { criarQueryClient } from '../../lib/session-query';
import { clinicsExperience } from './experience';
import { PagamentosDoPaciente } from './pagamentos/PagamentosDoPaciente';
import { limparTentativasPendentes } from './pagamentos/tentativa-pendente';
import { ClinicsPatientPage } from './PatientPage';

/**
 * A aba "Pagamentos" da ficha (ADR-063, F6.1a). Dados FICTÍCIOS. O que se
 * prova: a aba só existe com `payments:read`; a lista destaca o saldo pendente e
 * identifica o não calculável; o painel mostra o histórico com autoria e a
 * anulação riscada; registrar e anular levam a `Idempotency-Key`, com as ações
 * só para quem tem a chave.
 */

type Resposta = { status?: number; body?: unknown };
type Rota = Resposta | ((corpo: unknown) => Resposta | Promise<Resposta>);

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
      const resposta = typeof definida === 'function' ? await definida(corpo) : definida;
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
  timezone: 'America/Sao_Paulo',
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
  limparTentativasPendentes();
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
    // com o espaço entre o valor e o texto (o chip é flex)
    expect(within(ativo).getByText(/a receber/)).toHaveTextContent(/^R\$\s600,00 a receber$/);
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
    // no fuso da UNIDADE (São Paulo, UTC−3), não no do navegador
    expect(
      await within(painel).findAllByText('registrado por Fulana Fictícia em 05/11/2026 às 14:32'),
    ).toHaveLength(2);
    expect(
      within(painel).getByText(
        /^anulado por Beltrana Fictícia em 05\/11\/2026 às 15:00, motivo: duplicado$/,
      ),
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
    expect(within(painel).getByRole('button', { name: 'Registrar pagamento' })).toBeDisabled();
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
    expect(await within(painel).findByText(/^Pagamento de .* anulado\.$/)).toHaveAttribute(
      'role',
      'status',
    );
    await waitFor(() => {
      const post = chamadas.find((c) => c.chave.startsWith('POST'));
      expect(post?.corpo).toEqual({ reason: 'wrong_amount' });
      expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});

describe('o botão de registrar e o fuso', () => {
  const painelCom = async (extra: Record<string, unknown>, det: Record<string, unknown> = {}) => {
    mockApi({
      'GET /api/auth/me': { body: usuario(TUDO) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: { body: [saldo(extra)] },
      [`GET /api/clinics/packages/${P1}/payments`]: {
        body: { ...detalhe([pagamento()], extra), ...det },
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    return abrirPainel();
  };

  it('quitado (preço e saldo zero): "Registrar pagamento" indisponível, com "Pacote quitado"', async () => {
    const painel = await painelCom({ receivedCents: 100_000, balanceCents: 0 });
    expect(await within(painel).findByText(/^Pacote quitado/)).toBeVisible();
    expect(within(painel).getByRole('button', { name: 'Registrar pagamento' })).toBeDisabled();
  });

  it('sem preço: "Registrar pagamento" continua disponível', async () => {
    const painel = await painelCom({ totalPriceCents: null, balanceCents: null });
    expect(
      await within(painel).findByRole('button', { name: 'Registrar pagamento' }),
    ).toBeEnabled();
    expect(within(painel).queryByText(/Pacote quitado/)).toBeNull();
  });

  it('sem o fuso da unidade: os instantes na hora do navegador, e dito', async () => {
    const painel = await painelCom({}, { today: null, timezone: null });
    expect(
      await within(painel).findByText(
        /^registrado por Fulana Fictícia em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2} \(fuso do navegador, .+\)$/,
      ),
    ).toBeVisible();
  });
});

describe('a tentativa pendente (o resultado que não chegou)', () => {
  /**
   * O POST registra no "servidor" e a resposta se perde (`perder`), ou a rede
   * cai antes; a recarga do painel pode falhar junto (`recargaFalha`).
   */
  function cenario(opcoes: { recargaFalha?: boolean } = {}) {
    const estado: {
      perder: boolean;
      recargaFalha: boolean;
      /** o histórico depois do lançamento (o servidor gravou) */
      gravado: boolean;
      /** a leitura do painel espera este portão, quando houver */
      portao: Promise<void> | null;
    } = { perder: true, recargaFalha: opcoes.recargaFalha ?? false, gravado: false, portao: null };
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario(TUDO) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: () => {
        if (estado.recargaFalha) throw new TypeError('Failed to fetch');
        return { body: [saldo()] };
      },
      [`GET /api/clinics/packages/${P1}/payments`]: async () => {
        if (estado.portao) await estado.portao;
        if (estado.recargaFalha) throw new TypeError('Failed to fetch');
        return {
          body: estado.gravado
            ? detalhe([pagamento({ id: PG2, amountCents: 60_000 }), pagamento()], {
                receivedCents: 100_000,
                balanceCents: 0,
              })
            : detalhe([pagamento()]),
        };
      },
      [`POST /api/clinics/packages/${P1}/payments`]: () => {
        if (estado.perder) throw new TypeError('Failed to fetch');
        return { status: 201, body: pagamento({ id: PG2, amountCents: 60_000 }) };
      },
      [`POST /api/clinics/package-payments/${PG1}/void`]: () => {
        if (estado.perder) return { status: 503, body: { message: 'indisponível' } };
        return { status: 201, body: pagamento() };
      },
    });
    return { estado, chamadas };
  }

  const confirmarRegistro = async (painel: HTMLElement) => {
    fireEvent.click(await within(painel).findByRole('button', { name: 'Registrar pagamento' }));
    fireEvent.change(within(painel).getByLabelText('Forma'), { target: { value: 'pix' } });
    fireEvent.click(within(painel).getByRole('button', { name: 'Revisar pagamento' }));
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar registro' }));
  };

  const fecharEReabrir = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return abrirPainel();
  };

  const posts = (chamadas: ReturnType<typeof mockApi>) =>
    chamadas.filter((c) => c.chave.startsWith('POST'));

  it('com a recarga falhando: a pendência fica, sobrevive a fechar e reabrir, e "Tentar de novo" repete a MESMA chave e o MESMO corpo', async () => {
    const { estado, chamadas } = cenario({ recargaFalha: false });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    let painel = await abrirPainel();
    // a recarga que segue a falha também falha
    estado.recargaFalha = true;
    await confirmarRegistro(painel);
    const pendencia = await within(painel).findByRole('region', {
      name: 'Registro pendente de confirmação',
    });
    expect(pendencia).toHaveTextContent(/R\$\s600,00 em pix, recebido em 05\/11\/2026/);
    expect(within(pendencia).getByRole('alert')).toHaveTextContent(/O resultado não chegou/);
    // a falha da recarga não toma o lugar da pendência
    await waitFor(() =>
      expect(within(painel).getByText(/Não foi possível carregar/)).toBeInTheDocument(),
    );
    expect(within(painel).getByRole('button', { name: 'Tentar de novo' })).toBeEnabled();

    // a lista volta a carregar (a recarga da página, a rede de volta): a pendência continua
    estado.recargaFalha = false;
    await client.invalidateQueries();
    painel = await fecharEReabrir();
    expect(
      await within(painel).findByRole('region', { name: 'Registro pendente de confirmação' }),
    ).toBeVisible();

    estado.perder = false;
    fireEvent.click(within(painel).getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await within(painel).findByText(/^Pagamento de R\$\s600,00 registrado\.$/),
    ).toHaveAttribute('role', 'status');
    expect(
      within(painel).queryByRole('region', { name: 'Registro pendente de confirmação' }),
    ).toBeNull();
    const [primeiro, segundo] = posts(chamadas);
    expect(posts(chamadas)).toHaveLength(2);
    expect(segundo.headers.get('Idempotency-Key')).toBe(primeiro.headers.get('Idempotency-Key'));
    expect(segundo.corpo).toEqual(primeiro.corpo);

    // resolvida, some de vez: reabrir mostra o histórico, sem pendência
    painel = await fecharEReabrir();
    expect(
      await within(painel).findByRole('button', { name: 'Registrar pagamento' }),
    ).toBeVisible();
    expect(within(painel).queryByRole('region', { name: /pendente de confirmação/ })).toBeNull();
  });

  it('enquanto pendente, nada novo é enviado: o histórico aparece sem "Registrar" nem "Anular"', async () => {
    const { chamadas } = cenario();
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const painel = await abrirPainel();
    await confirmarRegistro(painel);
    await within(painel).findByRole('region', { name: 'Registro pendente de confirmação' });
    expect(
      await within(painel).findByRole('region', { name: 'Histórico de pagamentos' }),
    ).toBeVisible();
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    expect(within(painel).queryByRole('button', { name: /^Anular/ })).toBeNull();
    expect(posts(chamadas)).toHaveLength(1);
  });

  it('sem "Descartar": a pendência bloqueia o pacote no painel reaberto e aparece na lista; a leitura vazia do histórico não a resolve', async () => {
    const { chamadas } = cenario();
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    let painel = await abrirPainel();
    await confirmarRegistro(painel);
    const pendencia = await within(painel).findByRole('region', {
      name: 'Registro pendente de confirmação',
    });
    expect(within(pendencia).getByRole('alert')).toHaveTextContent(
      /o pagamento pode já ter sido registrado\. Só “Tentar de novo” confirma/,
    );
    expect(within(painel).queryByRole('button', { name: 'Descartar' })).toBeNull();
    expect(within(pendencia).getAllByRole('button')).toHaveLength(1);
    // a lista indica o caminho de volta
    expect(
      within(
        screen.getByRole('row', { name: 'Pacote de Limpeza de pele', hidden: true }),
      ).getByText('Operação pendente de confirmação'),
    ).toBeInTheDocument();

    // o histórico relido (sem o lançamento) não resolve nada
    await client.invalidateQueries();
    painel = await fecharEReabrir();
    expect(
      await within(painel).findByRole('region', { name: 'Histórico de pagamentos' }),
    ).toBeVisible();
    expect(
      within(painel).getByRole('region', { name: 'Registro pendente de confirmação' }),
    ).toBeVisible();
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    expect(within(painel).queryByRole('button', { name: /^Anular/ })).toBeNull();
    expect(posts(chamadas)).toHaveLength(1);
  });

  it('resolvido o resultado, as ações só voltam depois da releitura bem-sucedida; a releitura que falha mantém o bloqueio, com "Recarregar"', async () => {
    const { estado, chamadas } = cenario({ recargaFalha: false });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    let painel = await abrirPainel();
    await confirmarRegistro(painel);
    await within(painel).findByRole('region', { name: 'Registro pendente de confirmação' });
    painel = await fecharEReabrir();
    await within(painel).findByRole('region', { name: 'Registro pendente de confirmação' });

    // a resposta volta, mas a releitura falha
    estado.perder = false;
    estado.gravado = true;
    estado.recargaFalha = true;
    fireEvent.click(within(painel).getByRole('button', { name: 'Tentar de novo' }));
    const releitura = await within(painel).findByRole('region', {
      name: 'Atualizando o histórico',
    });
    expect(await within(releitura).findByRole('alert')).toHaveTextContent(
      /Não foi possível reler o histórico e o saldo/,
    );
    expect(within(releitura).getByText(/^Resposta recebida: Pagamento de/)).toBeVisible();
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    expect(within(painel).queryByRole('button', { name: /^Anular/ })).toBeNull();
    expect(within(painel).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    // fechar e reabrir não libera: a releitura falha de novo
    painel = await fecharEReabrir();
    expect(await within(painel).findByRole('button', { name: 'Recarregar' })).toBeVisible();
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();

    // a rede volta, mas a leitura demora: enquanto não chega, continua bloqueado
    estado.recargaFalha = false;
    let abrirPortao!: () => void;
    estado.portao = new Promise<void>((r) => {
      abrirPortao = r;
    });
    fireEvent.click(within(painel).getByRole('button', { name: 'Recarregar' }));
    expect(await within(painel).findByText('Atualizando o histórico e o saldo…')).toHaveAttribute(
      'role',
      'status',
    );
    expect(within(painel).queryByRole('button', { name: 'Registrar pagamento' })).toBeNull();
    abrirPortao();
    estado.portao = null;
    expect(
      await within(painel).findByText(/^Pagamento de R\$\s600,00 registrado\.$/),
    ).toHaveAttribute('role', 'status');
    expect(within(painel).queryByRole('region', { name: /pendente de confirmação/ })).toBeNull();
    // o histórico relido, com o lançamento; quitado, sem "Registrar" disponível
    expect(within(painel).getByText('Pacote quitado: o recebido cobre o preço.')).toBeVisible();
    expect(within(painel).getByRole('button', { name: 'Registrar pagamento' })).toBeDisabled();
    expect(
      within(
        screen.getByRole('row', { name: 'Pacote de Limpeza de pele', hidden: true }),
      ).queryByText('Operação pendente de confirmação'),
    ).toBeNull();
    const [primeiro, segundo] = posts(chamadas);
    expect(posts(chamadas)).toHaveLength(2);
    expect(segundo.headers.get('Idempotency-Key')).toBe(primeiro.headers.get('Idempotency-Key'));
  });

  it('a anulação com 5xx: pendente, sobrevive a fechar e reabrir, e repete a MESMA chave', async () => {
    const { estado, chamadas } = cenario();
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    let painel = await abrirPainel();
    fireEvent.click(
      await within(painel).findByRole('button', { name: /^Anular o pagamento de R\$\s400,00/ }),
    );
    fireEvent.change(within(painel).getByLabelText('Motivo'), { target: { value: 'duplicate' } });
    fireEvent.click(within(painel).getByRole('button', { name: 'Confirmar anulação' }));
    expect(
      await within(painel).findByRole('region', { name: 'Anulação pendente de confirmação' }),
    ).toHaveTextContent(/motivo: duplicado/);
    painel = await fecharEReabrir();
    await within(painel).findByRole('region', { name: 'Anulação pendente de confirmação' });
    estado.perder = false;
    fireEvent.click(within(painel).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(painel).findByText(/^Pagamento de .* anulado\.$/)).toHaveAttribute(
      'role',
      'status',
    );
    const [primeiro, segundo] = posts(chamadas);
    expect(segundo.headers.get('Idempotency-Key')).toBe(primeiro.headers.get('Idempotency-Key'));
    expect(segundo.corpo).toEqual({ reason: 'duplicate' });
  });

  it('a recusa definitiva (4xx) não fica pendente: mostra o motivo e libera', async () => {
    mockApi({
      'GET /api/auth/me': { body: usuario(TUDO) },
      [`GET /api/clinics/patients/${PAC}/package-payments`]: { body: [saldo()] },
      [`GET /api/clinics/packages/${P1}/payments`]: { body: detalhe([pagamento()]) },
      [`POST /api/clinics/packages/${P1}/payments`]: {
        status: 409,
        body: { message: 'O valor passa do saldo do pacote; nada foi registrado' },
      },
    });
    renderizar(<PagamentosDoPaciente pacienteId={PAC} />);
    const painel = await abrirPainel();
    await confirmarRegistro(painel);
    expect(await within(painel).findByRole('alert')).toHaveTextContent(/passa do saldo/);
    expect(within(painel).queryByRole('region', { name: /pendente de confirmação/ })).toBeNull();
    expect(within(painel).getByRole('button', { name: 'Confirmar registro' })).toBeEnabled();
  });
});

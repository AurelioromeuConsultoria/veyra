import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { useSession } from '../lib/session';
import { criarQueryClient } from '../lib/session-query';
import { ConsentimentoDaConversa, ConsentimentosDoContato } from './Consentimentos';

/**
 * O consentimento e o pedido de parar na tela (F4.4b; ADR-048 adendo 12).
 * Dados FICTÍCIOS. O que se prova: o número sai do servidor (os exatos do
 * contato, ou o da conversa), nunca digitado; a origem é da lista fechada; o
 * resultado indefinido trava a seção e repete o MESMO registro, com a mesma
 * chave; o definitivo mostra o motivo; e as permissões escondem e não
 * consultam.
 */

type Resposta = { status?: number; body?: unknown; falha?: boolean };
type Rota = Resposta | Resposta[];
type Chamada = { chave: string; corpo?: unknown; idempotencia: string | null };

/** fetch falso por rota exata ("GET /api/…"); a lista responde em ordem. */
function mockApi(rotas: Record<string, Rota>) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      const headers = new Headers(init?.headers);
      chamadas.push({
        chave,
        corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
        idempotencia: headers.get('Idempotency-Key'),
      });
      const rota = rotas[chave];
      const resposta = (Array.isArray(rota)
        ? rota.length > 1
          ? rota.shift()
          : rota[0]
        : rota) ?? {
        status: 404,
        body: { message: `sem mock: ${chave}` },
      };
      if (resposta.falha) throw new TypeError('Failed to fetch');
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
  email: 'pessoa@empresa.test',
  activeMembership: {
    membershipId: 'm1',
    workspaceId: 'w1',
    workspaceName: 'Empresa',
    workspaceSlug: 'empresa',
    roleName: 'Owner',
    status: 'active',
  },
  permissions,
  memberships: [],
});

const LE = ['contacts:read', 'consents:read'];
const GERE = [...LE, 'consents:manage'];
const TUDO = [...GERE, 'consents:unblock'];

const CT = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e09';
const CH = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31';
const P1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e33';
const P2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e34';
const P3 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e35';
const C1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e71';
const C2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e72';
const CV = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e81';
const N1 = '+5511900000001';
const N2 = '+5511900000002';

const consentimento = (extra: Record<string, unknown> = {}) => ({
  id: C1,
  contactId: CT,
  channelId: CH,
  number: N1,
  purposeId: P1,
  purposeKey: 'clinics_confirmacao',
  purposeVersion: 1,
  purposeDescription: 'Confirmação de horário (versão 1)',
  origin: 'in_person',
  receipt: 'CON-000001',
  grantedAt: '2030-11-01T12:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
  ...extra,
});
const bloqueio = (extra: Record<string, unknown> = {}) => ({
  id: 'b1',
  number: N2,
  origin: 'phone',
  receipt: 'PAR-000001',
  createdAt: '2030-11-01T13:00:00.000Z',
  liftedAt: null,
  liftReceipt: null,
  ...extra,
});

const doContato = (permissoes: string[]): Record<string, Rota> => ({
  'GET /api/auth/me': { body: usuario(permissoes) },
  [`GET /api/contacts/${CT}/consents`]: {
    body: {
      numbers: [N1, N2],
      stopBlocks: [bloqueio()],
      consents: [
        consentimento(),
        consentimento({
          id: C2,
          number: N2,
          receipt: 'CON-000002',
          revokedAt: '2030-11-01T13:00:00.000Z',
          revocationReason: 'stop_requested',
        }),
      ],
    },
  },
  'GET /api/consent-channels': { body: [{ id: CH, name: 'WhatsApp da clínica' }] },
  'GET /api/consent-purposes': {
    body: [
      {
        id: P1,
        key: 'clinics_confirmacao',
        version: 1,
        description: 'Confirmação de horário (versão 1)',
        category: 'utility',
        fields: [],
      },
      {
        id: P2,
        key: 'clinics_confirmacao',
        version: 2,
        description: 'Confirmação de horário (versão 2)',
        category: 'utility',
        fields: [],
      },
      {
        id: P3,
        key: 'clinics_reativacao',
        version: 1,
        description: 'Retorno',
        category: 'utility',
        fields: [],
      },
    ],
  },
});

/**
 * Diz quando a sessão chegou: sem ela, a tela ainda não sabe as permissões, e
 * "nada consultado" seria verdade só por enquanto (as mutações C11 e C12
 * sobreviviam a uma asserção feita antes da sessão).
 */
function SessaoCarregada() {
  const { data } = useSession();
  return data ? <p data-testid="sessao-carregada" /> : null;
}

function renderizar(ui: ReactNode) {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessaoCarregada />
        {ui}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** a sessão carregada e um ciclo a mais: as consultas que a tela faria já saíram */
async function depoisDaSessao() {
  await screen.findByTestId('sessao-carregada');
  await new Promise((r) => setTimeout(r, 20));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const UUID = /^[0-9a-f-]{36}$/;

/** Escolhe tudo e registra o consentimento do N1 na versão 2. */
async function concederN1() {
  const secao = await screen.findByTestId('consentimentos-do-contato');
  const finalidade = await within(secao).findByRole('combobox', {
    name: 'Finalidade do consentimento',
  });
  await within(finalidade).findByRole('option', { name: 'clinics_confirmacao v2' });
  fireEvent.change(within(secao).getByRole('combobox', { name: 'Canal do consentimento' }), {
    target: { value: CH },
  });
  fireEvent.change(within(secao).getByRole('combobox', { name: 'Número do consentimento' }), {
    target: { value: N1 },
  });
  fireEvent.change(finalidade, { target: { value: P2 } });
  fireEvent.change(within(secao).getByRole('combobox', { name: 'Origem do consentimento' }), {
    target: { value: 'in_person' },
  });
  fireEvent.click(within(secao).getByRole('button', { name: 'Registrar consentimento' }));
  return secao;
}

describe('a ficha do contato: consentimentos e pedido de parar', () => {
  it('mostra os números exatos, o pedido ativo e o histórico; concede com a chave e o número do servidor', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/consents`]: {
        status: 201,
        body: consentimento({ id: 'c3', purposeId: P2, purposeVersion: 2, receipt: 'CON-000003' }),
      },
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await screen.findByTestId('consentimentos-do-contato');
    expect(await within(secao).findByText(/PAR-000001/)).toBeInTheDocument();
    expect(within(secao).getByText('Pedido de parar ativo')).toBeInTheDocument();
    expect(within(secao).getByText(/Revogado em .* \(pedido de parar\)/)).toBeInTheDocument();
    // só os números sem pedido de parar, e só a versão mais recente de cada finalidade
    const numero = within(secao).getByRole('combobox', { name: 'Número do consentimento' });
    expect(
      within(numero)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Número…', N1]);
    const finalidade = within(secao).getByRole('combobox', {
      name: 'Finalidade do consentimento',
    });
    await within(finalidade).findByRole('option', { name: 'clinics_confirmacao v2' });
    expect(
      within(finalidade)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Finalidade…', 'clinics_confirmacao v2', 'clinics_reativacao v1']);
    expect(within(secao).getByRole('button', { name: 'Registrar consentimento' })).toBeDisabled();

    await concederN1();
    expect(screen.getByTestId('descricao-aceita')).toHaveTextContent(
      'A pessoa aceita: “Confirmação de horário (versão 2)”',
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Consentimento registrado: CON-000003',
    );
    const pedido = chamadas.find((c) => c.chave === `POST /api/contacts/${CT}/consents`);
    expect(pedido?.idempotencia).toMatch(UUID);
    expect(pedido?.corpo).toEqual({
      channelId: CH,
      number: N1,
      purposeId: P2,
      origin: 'in_person',
    });
  });

  it('o resultado indefinido trava a seção e só repete o MESMO registro, com a mesma chave', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/consents`]: [
        { falha: true },
        {
          status: 409,
          body: {
            message: 'Requisição idêntica em processamento, tente novamente',
            code: 'idempotency_retry',
          },
        },
        { status: 201, body: consentimento({ id: 'c3', receipt: 'CON-000003' }) },
      ],
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await concederN1();
    expect(await within(secao).findByRole('alert')).toHaveTextContent(
      'Consentimento: o resultado não chegou. Repita o mesmo registro: ele não cria outro.',
    );
    // nada que registre outra coisa
    expect(within(secao).getByRole('button', { name: 'Registrar consentimento' })).toBeDisabled();
    expect(within(secao).getByRole('button', { name: 'Revogar (CON-000001)' })).toBeDisabled();
    expect(
      within(secao).getByRole('button', { name: `Registrar pedido de parar (${N1})` }),
    ).toBeDisabled();
    expect(within(secao).getByRole('button', { name: `Retirar o pedido (${N2})` })).toBeDisabled();

    // o 409 que pede a mesma requisição continua indefinido
    fireEvent.click(within(secao).getByRole('button', { name: 'Repetir o mesmo registro' }));
    await waitFor(() =>
      expect(chamadas.filter((c) => c.chave === `POST /api/contacts/${CT}/consents`)).toHaveLength(
        2,
      ),
    );
    expect(
      await within(secao).findByRole('button', { name: 'Repetir o mesmo registro' }),
    ).toBeEnabled();
    fireEvent.click(within(secao).getByRole('button', { name: 'Repetir o mesmo registro' }));
    expect(await within(secao).findByRole('status')).toHaveTextContent(
      'Consentimento registrado: CON-000003',
    );
    const registros = chamadas.filter((c) => c.chave === `POST /api/contacts/${CT}/consents`);
    expect(registros).toHaveLength(3);
    expect(new Set(registros.map((r) => r.idempotencia)).size).toBe(1);
    expect(registros.map((r) => r.corpo)).toEqual(Array(3).fill(registros[0].corpo));
    expect(within(secao).queryByRole('button', { name: 'Repetir o mesmo registro' })).toBeNull();
  });

  it('o número escolhido que passa a ter pedido de parar deixa de valer para a concessão', async () => {
    const N3 = '+5511900000003';
    const leitura = (bloqueados: string[]) => ({
      body: {
        numbers: [N1, N2, N3],
        stopBlocks: bloqueados.map((n) => bloqueio({ id: `b-${n}`, number: n })),
        consents: [],
      },
    });
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`GET /api/contacts/${CT}/consents`]: [leitura([N2]), leitura([N2, N1])],
      [`POST /api/contacts/${CT}/stop`]: { status: 201, body: bloqueio({ number: N1 }) },
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await screen.findByTestId('consentimentos-do-contato');
    const finalidade = await within(secao).findByRole('combobox', {
      name: 'Finalidade do consentimento',
    });
    await within(finalidade).findByRole('option', { name: 'clinics_confirmacao v2' });
    fireEvent.change(within(secao).getByRole('combobox', { name: 'Canal do consentimento' }), {
      target: { value: CH },
    });
    fireEvent.change(within(secao).getByRole('combobox', { name: 'Número do consentimento' }), {
      target: { value: N1 },
    });
    fireEvent.change(finalidade, { target: { value: P2 } });
    fireEvent.change(within(secao).getByRole('combobox', { name: 'Origem do consentimento' }), {
      target: { value: 'in_person' },
    });
    expect(within(secao).getByRole('button', { name: 'Registrar consentimento' })).toBeEnabled();

    fireEvent.click(
      within(secao).getByRole('button', { name: `Registrar pedido de parar (${N1})` }),
    );
    const parar = within(secao).getByRole('group', { name: `Registrar pedido de parar (${N1})` });
    fireEvent.change(within(parar).getByRole('combobox'), { target: { value: 'phone' } });
    fireEvent.click(within(parar).getByRole('button', { name: 'Registrar o pedido' }));
    await waitFor(() =>
      expect(
        within(secao).queryByRole('button', { name: `Registrar pedido de parar (${N1})` }),
      ).toBeNull(),
    );
    // o N1 saiu da lista: a escolha não vale mais, e nada é concedido para ele
    const numero = within(secao).getByRole('combobox', { name: 'Número do consentimento' });
    expect(
      within(numero)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Número…', N3]);
    expect(numero).toHaveValue('');
    expect(within(secao).getByRole('button', { name: 'Registrar consentimento' })).toBeDisabled();
    expect(chamadas.some((c) => c.chave === `POST /api/contacts/${CT}/consents`)).toBe(false);
  });

  it('o 5xx também é indefinido: a repetição leva a mesma chave', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/consents`]: [
        { status: 503, body: { message: 'Serviço indisponível' } },
        { status: 201, body: consentimento({ id: 'c3', receipt: 'CON-000003' }) },
      ],
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await concederN1();
    fireEvent.click(await within(secao).findByRole('button', { name: 'Repetir o mesmo registro' }));
    expect(await within(secao).findByRole('status')).toHaveTextContent(
      'Consentimento registrado: CON-000003',
    );
    const registros = chamadas.filter((c) => c.chave === `POST /api/contacts/${CT}/consents`);
    expect(registros.map((r) => r.idempotencia)).toEqual([
      registros[0].idempotencia,
      registros[0].idempotencia,
    ]);
  });

  it('o 409 de domínio é definitivo: mostra o motivo, e a próxima tentativa nasce com outra chave', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/consents`]: [
        {
          status: 409,
          body: { message: 'Há um pedido de parar ativo para este número' },
        },
        { status: 201, body: consentimento({ id: 'c3', receipt: 'CON-000003' }) },
      ],
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await concederN1();
    expect(await within(secao).findByRole('alert')).toHaveTextContent(
      'Há um pedido de parar ativo para este número',
    );
    expect(within(secao).queryByRole('button', { name: 'Repetir o mesmo registro' })).toBeNull();
    await concederN1();
    await within(secao).findByRole('status');
    const registros = chamadas.filter((c) => c.chave === `POST /api/contacts/${CT}/consents`);
    expect(registros).toHaveLength(2);
    expect(registros[1].idempotencia).not.toBe(registros[0].idempotencia);
  });

  it('a chave expirada não se repete: o registro incerto vira definitivo, e o próximo nasce com outra chave', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/consents`]: [
        { falha: true },
        {
          status: 409,
          body: {
            message: 'Chave de idempotência expirada: confira o estado antes de enviar de novo',
            code: 'idempotency_expired',
          },
        },
        { status: 201, body: consentimento({ id: 'c3', receipt: 'CON-000003' }) },
      ],
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await concederN1();
    fireEvent.click(await within(secao).findByRole('button', { name: 'Repetir o mesmo registro' }));
    expect(
      await within(secao).findByText(
        'Consentimento: a tentativa anterior expirou sem resultado confirmado. Confira a seção antes de registrar de novo.',
      ),
    ).toBeInTheDocument();
    expect(within(secao).queryByRole('button', { name: 'Repetir o mesmo registro' })).toBeNull();
    await concederN1();
    await within(secao).findByRole('status');
    const registros = chamadas.filter((c) => c.chave === `POST /api/contacts/${CT}/consents`);
    expect(registros).toHaveLength(3);
    expect(registros[1].idempotencia).toBe(registros[0].idempotencia);
    expect(registros[2].idempotencia).not.toBe(registros[0].idempotencia);
  });

  it('parar, retirar e revogar pedem a origem da lista fechada; o desbloqueio diz que nada volta', async () => {
    const chamadas = mockApi({
      ...doContato(TUDO),
      [`POST /api/contacts/${CT}/stop`]: { status: 201, body: bloqueio({ number: N1 }) },
      [`POST /api/contacts/${CT}/stop/lift`]: {
        status: 201,
        body: bloqueio({ liftReceipt: 'DES-000001' }),
      },
      [`POST /api/contacts/${CT}/consents/${C1}/revoke`]: {
        status: 201,
        body: consentimento({ revokedAt: '2030-11-02T12:00:00.000Z' }),
      },
    });
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await screen.findByTestId('consentimentos-do-contato');

    fireEvent.click(
      await within(secao).findByRole('button', { name: `Registrar pedido de parar (${N1})` }),
    );
    const parar = within(secao).getByRole('group', { name: `Registrar pedido de parar (${N1})` });
    expect(within(parar).getByRole('button', { name: 'Registrar o pedido' })).toBeDisabled();
    fireEvent.change(within(parar).getByRole('combobox'), { target: { value: 'phone' } });
    fireEvent.click(within(parar).getByRole('button', { name: 'Registrar o pedido' }));
    expect(await within(secao).findByRole('status')).toHaveTextContent(
      'Pedido de parar registrado: PAR-000001',
    );

    fireEvent.click(within(secao).getByRole('button', { name: `Retirar o pedido (${N2})` }));
    const retirar = within(secao).getByRole('group', { name: `Retirar o pedido (${N2})` });
    expect(retirar).toHaveTextContent('Nenhum consentimento anterior volta');
    fireEvent.change(within(retirar).getByRole('combobox'), { target: { value: 'paper_form' } });
    fireEvent.click(within(retirar).getByRole('button', { name: 'Registrar a nova solicitação' }));
    await waitFor(() =>
      expect(within(secao).getByRole('status')).toHaveTextContent(
        'Pedido de parar retirado: DES-000001',
      ),
    );

    fireEvent.click(within(secao).getByRole('button', { name: 'Revogar (CON-000001)' }));
    const revogar = within(secao).getByRole('group', { name: 'Revogar (CON-000001)' });
    fireEvent.change(within(revogar).getByRole('combobox'), { target: { value: 'in_person' } });
    fireEvent.click(within(revogar).getByRole('button', { name: 'Revogar o consentimento' }));
    await waitFor(() =>
      expect(within(secao).getByRole('status')).toHaveTextContent(
        'Consentimento CON-000001 revogado',
      ),
    );

    const corpo = (chave: string) => chamadas.find((c) => c.chave === chave);
    expect(corpo(`POST /api/contacts/${CT}/stop`)?.corpo).toEqual({ number: N1, origin: 'phone' });
    expect(corpo(`POST /api/contacts/${CT}/stop/lift`)?.corpo).toEqual({
      number: N2,
      origin: 'paper_form',
    });
    expect(corpo(`POST /api/contacts/${CT}/consents/${C1}/revoke`)?.corpo).toEqual({
      origin: 'in_person',
    });
    for (const c of chamadas.filter((c) => c.chave.startsWith('POST'))) {
      expect(c.idempotencia).toMatch(UUID);
    }
  });

  it('as permissões: a leitura não oferece ação, sem desbloquear não retira, e sem a leitura nada é consultado', async () => {
    let chamadas = mockApi(doContato(LE));
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const secao = await screen.findByTestId('consentimentos-do-contato');
    await within(secao).findByText(/PAR-000001/);
    expect(within(secao).queryByRole('button')).toBeNull();
    expect(within(secao).queryByRole('group')).toBeNull();
    expect(chamadas.some((c) => c.chave === 'GET /api/consent-purposes')).toBe(false);
    vi.unstubAllGlobals();
    document.body.innerHTML = '';

    chamadas = mockApi(doContato(GERE));
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    const gere = await screen.findByTestId('consentimentos-do-contato');
    await within(gere).findByRole('button', { name: `Registrar pedido de parar (${N1})` });
    expect(within(gere).queryByRole('button', { name: `Retirar o pedido (${N2})` })).toBeNull();
    // quem concede lê as finalidades para escolher
    expect(chamadas.some((c) => c.chave === 'GET /api/consent-purposes')).toBe(true);
    vi.unstubAllGlobals();
    document.body.innerHTML = '';

    // sem consents:read: nada aparece e nada é consultado
    chamadas = mockApi(doContato(['contacts:read', 'consents:manage']));
    renderizar(<ConsentimentosDoContato contactId={CT} />);
    await depoisDaSessao();
    expect(screen.queryByTestId('consentimentos-do-contato')).toBeNull();
    expect(chamadas.filter((c) => c.chave !== 'GET /api/auth/me')).toEqual([]);
  });
});

const conversa = (extra: Partial<ConversationDto> = {}): ConversationDto =>
  ({
    id: CV,
    channelType: 'whatsapp',
    contactId: CT,
    contactName: 'Paciente Fictícia',
    senderStatus: 'identified',
    senderAddress: N1,
    senderIdentifiedByPerson: false,
    senderRelinkBlocked: false,
    subject: null,
    status: 'open',
    assigneeMembershipId: null,
    assigneeName: null,
    lastMessageAt: '2030-11-01T12:00:00.000Z',
    windowExpiresAt: null,
    ...extra,
  }) as ConversationDto;

describe('a conversa: consultar, parar e desbloquear pela rota da conversa', () => {
  it('o número como o servidor manda, o pedido pela conversa e o caminho para a ficha', async () => {
    const chamadas = mockApi({
      'GET /api/auth/me': { body: usuario([...TUDO, 'conversations:read']) },
      [`GET /api/conversations/${CV}/consents`]: {
        body: { number: N1, stopBlock: null, consents: [consentimento()] },
      },
      'GET /api/consent-channels': { body: [{ id: CH, name: 'WhatsApp da clínica' }] },
      [`POST /api/conversations/${CV}/stop`]: { status: 201, body: bloqueio({ number: N1 }) },
    });
    renderizar(<ConsentimentoDaConversa conversa={conversa()} />);
    const secao = await screen.findByTestId('consentimento-da-conversa');
    expect(await within(secao).findByText(N1)).toBeInTheDocument();
    expect(within(secao).getByText(/CON-000001/)).toBeInTheDocument();
    expect(
      within(secao).getByRole('link', {
        name: 'Registrar ou revogar consentimento na ficha do contato',
      }),
    ).toHaveAttribute('href', `/contacts?c=${CT}`);
    fireEvent.click(within(secao).getByRole('button', { name: 'Registrar pedido de parar' }));
    fireEvent.change(within(secao).getByRole('combobox'), { target: { value: 'phone' } });
    fireEvent.click(within(secao).getByRole('button', { name: 'Registrar o pedido' }));
    expect(await within(secao).findByRole('status')).toHaveTextContent(
      'Pedido de parar registrado: PAR-000001',
    );
    const pedido = chamadas.find((c) => c.chave === `POST /api/conversations/${CV}/stop`);
    // o número é o da conversa: o corpo leva só a origem
    expect(pedido?.corpo).toEqual({ origin: 'phone' });
    expect(pedido?.idempotencia).toMatch(UUID);
  });

  it('na RAI: sem contacts:write não consulta; com ela, mostra o número e não leva a ficha nenhuma', async () => {
    const rai = conversa({ senderStatus: 'unidentified', contactId: null, contactName: null });
    let chamadas = mockApi({
      'GET /api/auth/me': { body: usuario([...TUDO, 'conversations:read']) },
    });
    renderizar(<ConsentimentoDaConversa conversa={rai} />);
    await depoisDaSessao();
    expect(screen.getByText('Você não vê os consentimentos desta conversa.')).toBeInTheDocument();
    expect(chamadas.filter((c) => c.chave !== 'GET /api/auth/me')).toEqual([]);
    vi.unstubAllGlobals();
    document.body.innerHTML = '';

    chamadas = mockApi({
      'GET /api/auth/me': { body: usuario([...TUDO, 'conversations:read', 'contacts:write']) },
      [`GET /api/conversations/${CV}/consents`]: {
        body: { number: N1, stopBlock: bloqueio({ number: N1 }), consents: [] },
      },
      'GET /api/consent-channels': { body: [] },
    });
    renderizar(<ConsentimentoDaConversa conversa={rai} />);
    const secao = await screen.findByTestId('consentimento-da-conversa');
    expect(await within(secao).findByText(/Remetente a identificar/)).toBeInTheDocument();
    expect(within(secao).getByText('Pedido de parar ativo')).toBeInTheDocument();
    expect(within(secao).getByRole('button', { name: 'Retirar o pedido' })).toBeInTheDocument();
    expect(within(secao).queryByRole('link')).toBeNull();
    // a leitura é a da conversa: nenhuma rota do contato é consultada
    expect(chamadas.some((c) => c.chave === `GET /api/conversations/${CV}/consents`)).toBe(true);
    expect(chamadas.some((c) => c.chave.startsWith('GET /api/contacts/'))).toBe(false);
  });
});

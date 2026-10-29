import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { NavContributionsProvider } from '../../lib/nav';
import { criarQueryClient } from '../../lib/session-query';
import { ClinicsAgendaPage } from './AgendaPage';
import { ClinicsOutreachPage } from './envios/EnviosPage';
import { ClinicsOutreachMetricsPage, etapaLegivel } from './metricas/MetricasDoEnvioPage';
import { useClinicsNavGroups } from './nav';

/**
 * As telas do envio da clínica (F4.4; ADR-048 adendos 8 a 10). Dados
 * FICTÍCIOS. O que se prova: a prévia antes da aprovação, a mesma chave na
 * repetição incerta, o aviso do envio simulado, as permissões que escondem e
 * não consultam, e as etapas da métrica que nunca viram zero.
 */

/** `pendente`: a resposta nunca chega (para segurar uma aprovação em voo). */
type Resposta = { status?: number; body?: unknown; falha?: boolean; pendente?: boolean };
type Rota = Resposta | ((corpo: unknown) => Resposta);
type Chamada = { chave: string; corpo?: unknown; idempotencia: string | null };

/** fetch falso por rota ("GET /api/…", prefixo mais longo vence); registra toda chamada. */
function mockApi(rotas: Record<string, Rota>) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = new Headers(init?.headers);
      chamadas.push({ chave, corpo, idempotencia: headers.get('Idempotency-Key') });
      const rota = Object.keys(rotas)
        .sort((a, b) => b.length - a.length)
        .find((prefixo) => chave.startsWith(prefixo));
      const definida: Rota = rota
        ? rotas[rota]
        : { status: 404, body: { message: `sem mock: ${chave}` } };
      const resposta = typeof definida === 'function' ? definida(corpo) : definida;
      if (resposta.falha) throw new TypeError('Failed to fetch');
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

const LEITURA = ['clinics:catalog:read', 'clinics:schedule:read'];
/** vê os candidatos, mas não prepara nem aprova */
const VE_CANDIDATOS = [...LEITURA, 'contacts:read', 'consents:read'];
const ENVIA = [...VE_CANDIDATOS, 'clinics:schedule:write', 'conversations:write'];

const U = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e02';
const S1 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e01';
const ANA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e03';
const PAC = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05';
const AG = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e06';
const AG2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e07';
const CT = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e09';
const CH = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31';
const TV = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e32';
const PU = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e33';
const RQ = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e41';
const DEAL = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e51';
const DEAL2 = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e52';
const PIPE = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e61';
const HASH = 'a'.repeat(64);
const QUANDO = '04/11/2030 09:00';

const base: Record<string, Rota> = {
  'GET /api/clinics/status': { body: { active: true } },
  'GET /api/clinics/units': {
    body: [{ id: U, name: 'Unidade principal', timezone: 'America/Sao_Paulo' }],
  },
};

const candidato = (extra: Record<string, unknown> = {}) => ({
  kind: 'confirmation',
  appointmentId: AG,
  returnId: null,
  startsAt: '2030-11-04T12:00:00.000Z',
  localDate: '2030-11-04',
  localStart: '09:00',
  dueDate: null,
  patientId: PAC,
  patientName: 'Paciente Fictícia',
  contactId: CT,
  numbers: ['+5511900000001', '+5511900000002'],
  blocked: null,
  request: null,
  ...extra,
});

const opcao = {
  channelId: CH,
  channelName: 'WhatsApp da clínica',
  templateVersionId: TV,
  name: 'confirmacao_horario',
  language: 'pt_BR',
  version: 1,
  purposeId: PU,
  purposeVersion: 1,
  purposeDescription: 'Confirmação de horário',
};

const pedido = (extra: Record<string, unknown> = {}) => ({
  id: RQ,
  kind: 'confirmation',
  appointmentId: AG,
  startsAt: '2030-11-04T12:00:00.000Z',
  returnId: null,
  state: 'draft',
  text: null,
  number: null,
  reason: null,
  createdAt: '2030-11-01T12:00:00.000Z',
  ...extra,
});

const TEXTO = 'Olá, Paciente! Confirma o horário de 04/11 às 09:00?';

/** O caminho feliz até a prévia: candidatos, opção, pedido e prévia. */
const ateAPrevia = (simulado: boolean): Record<string, Rota> => ({
  ...base,
  'GET /api/auth/me': { body: usuario(ENVIA) },
  'GET /api/clinics/outreach/transport': { body: { simulated: simulado } },
  'GET /api/clinics/outreach/candidates': { body: [candidato()] },
  'GET /api/clinics/outreach/options': { body: [opcao] },
  'POST /api/clinics/outreach/requests': {
    body: { items: [{ index: 0, ok: true, request: pedido() }] },
  },
  'POST /api/clinics/outreach/preview': {
    body: {
      items: [
        {
          index: 0,
          ok: true,
          text: TEXTO,
          values: {},
          expiresAt: '2030-11-01T13:00:00.000Z',
          approvalHash: HASH,
        },
      ],
    },
  },
});

function renderizar(ui: ReactNode, caminho: string) {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[caminho]}>
        <NavContributionsProvider value={useClinicsNavGroups}>{ui}</NavContributionsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function prepararAPrevia() {
  fireEvent.click(
    await screen.findByRole('checkbox', { name: `Escolher Paciente Fictícia, ${QUANDO}` }),
  );
  // o número exato: quem prepara escolhe entre os do contato
  fireEvent.change(screen.getByRole('combobox', { name: 'Número de Paciente Fictícia' }), {
    target: { value: '+5511900000002' },
  });
  const template = await screen.findByRole('combobox', { name: 'Template revisado' });
  await within(template).findByRole('option', { name: /confirmacao_horario/ });
  fireEvent.change(template, { target: { value: `${TV}:${PU}` } });
  fireEvent.click(screen.getByRole('button', { name: 'Preparar e ver a prévia (1)' }));
  return screen.findByTestId('previa-da-clinica');
}

describe('envios: candidatos, prévia e aprovação', () => {
  it('prepara o pedido, mostra o texto exato e aprova com o hash da prévia; o simulado é dito', async () => {
    const chamadas = mockApi({
      ...ateAPrevia(true),
      'POST /api/clinics/outreach/approve': {
        body: {
          items: [{ index: 0, requestId: RQ, state: 'approved', messageId: 'm1', reason: null }],
        },
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    expect(await screen.findByTestId('envio-simulado')).toHaveTextContent(
      'Envio simulado. Nesta demonstração nada sai para o WhatsApp',
    );
    const previa = await prepararAPrevia();
    expect(within(previa).getByText(TEXTO)).toBeInTheDocument();
    expect(chamadas.find((c) => c.chave === 'POST /api/clinics/outreach/requests')?.corpo).toEqual({
      kind: 'confirmation',
      targets: [{ appointmentId: AG }],
    });
    expect(chamadas.find((c) => c.chave === 'POST /api/clinics/outreach/preview')?.corpo).toEqual({
      items: [
        {
          requestId: RQ,
          channelId: CH,
          number: '+5511900000002',
          templateVersionId: TV,
          purposeId: PU,
        },
      ],
    });
    // nada é aprovado antes do clique
    expect(chamadas.some((c) => c.chave.includes('/approve'))).toBe(false);

    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(
      await screen.findByText(/Paciente Fictícia: Aprovado: o envio simulado é registrado/),
    ).toBeInTheDocument();
    const aprovacao = chamadas.find((c) => c.chave === 'POST /api/clinics/outreach/approve');
    expect(aprovacao?.idempotencia).toMatch(/^[0-9a-f-]{36}$/);
    expect(aprovacao?.corpo).toEqual({
      items: [
        {
          requestId: RQ,
          channelId: CH,
          number: '+5511900000002',
          templateVersionId: TV,
          purposeId: PU,
          expiresAt: '2030-11-01T13:00:00.000Z',
          approvalHash: HASH,
        },
      ],
    });
  });

  it('a aprovação sem resposta definitiva só deixa repetir A MESMA, com a mesma chave', async () => {
    let tentativas = 0;
    const chamadas = mockApi({
      ...ateAPrevia(false),
      'POST /api/clinics/outreach/approve': () => {
        tentativas += 1;
        return tentativas === 1
          ? { falha: true }
          : {
              body: {
                items: [
                  { index: 0, requestId: RQ, state: 'approved', messageId: 'm1', reason: null },
                ],
              },
            };
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(await screen.findByText(/O resultado da aprovação não chegou/)).toBeInTheDocument();
    // nada que gere outra prévia: descartar, trocar o template ou a escolha
    expect(within(previa).getByRole('button', { name: 'Descartar a prévia' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Template revisado' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Tipo de envio' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Número de Paciente Fictícia' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Dias' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: `Escolher Paciente Fictícia, ${QUANDO}` }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Preparar e ver a prévia/ })).toBeDisabled();

    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(
      await screen.findByText(/Paciente Fictícia: Aprovado: o envio sai em instantes/),
    ).toBeInTheDocument();
    const aprovacoes = chamadas.filter((c) => c.chave === 'POST /api/clinics/outreach/approve');
    expect(aprovacoes).toHaveLength(2);
    expect(aprovacoes[1].idempotencia).toBe(aprovacoes[0].idempotencia);
    expect(screen.queryByTestId('envio-simulado')).toBeNull();
  });

  it('com a aprovação em voo, nada troca a prévia nem gera outra', async () => {
    mockApi({ ...ateAPrevia(false), 'POST /api/clinics/outreach/approve': { pendente: true } });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    await waitFor(() =>
      expect(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: /^Preparar e ver a prévia/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Template revisado' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Número de Paciente Fictícia' })).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: `Escolher Paciente Fictícia, ${QUANDO}` }),
    ).toBeDisabled();
    expect(within(previa).getByRole('button', { name: 'Descartar a prévia' })).toBeDisabled();
  });

  it('gerando outra prévia, a de antes não é aprovada nem descartada no meio', async () => {
    let previas = 0;
    const rotas = ateAPrevia(false);
    const primeira = rotas['POST /api/clinics/outreach/preview'] as Resposta;
    mockApi({
      ...rotas,
      'POST /api/clinics/outreach/preview': () => {
        previas += 1;
        return previas === 1 ? primeira : { pendente: true };
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(screen.getByRole('button', { name: /^Preparar e ver a prévia/ }));
    await waitFor(() =>
      expect(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' })).toBeDisabled(),
    );
    expect(within(previa).getByRole('button', { name: 'Descartar a prévia' })).toBeDisabled();
  });

  it('trocar o filtro limpa a escolha: a lista nova não herda a de antes', async () => {
    mockApi(ateAPrevia(false));
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const caixa = await screen.findByRole('checkbox', {
      name: `Escolher Paciente Fictícia, ${QUANDO}`,
    });
    fireEvent.click(caixa);
    expect(screen.getByRole('button', { name: 'Preparar e ver a prévia (1)' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Dias' }), { target: { value: '7' } });
    expect(
      await screen.findByRole('button', { name: 'Preparar e ver a prévia (0)' }),
    ).toBeInTheDocument();
  });

  it('a recusa da prévia aparece com o motivo, e o item recusado não vai para a aprovação', async () => {
    mockApi({
      ...ateAPrevia(false),
      'POST /api/clinics/outreach/preview': {
        body: { items: [{ index: 0, ok: false, reason: 'consent_revoked' }] },
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    expect(within(previa).getByText(/Não sai: sem consentimento vigente/)).toBeInTheDocument();
    expect(within(previa).getByRole('button', { name: 'Aprovar e enviar (0)' })).toBeDisabled();
  });

  it('o candidato bloqueado não é escolhido, e o pedido existente abre o acompanhamento com o que o servidor manda', async () => {
    const chamadas = mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario(ENVIA) },
      'GET /api/clinics/outreach/transport': { body: { simulated: true } },
      'GET /api/clinics/outreach/candidates': {
        body: [
          candidato({ blocked: 'request_exists', request: { id: RQ, state: 'sent' } }),
          candidato({
            appointmentId: AG2,
            patientName: 'Outra Fictícia',
            blocked: 'starts_too_soon',
          }),
        ],
      },
      'GET /api/clinics/outreach/options': { body: [opcao] },
      // o desfecho terminal apagou o texto; o número aparece como o servidor o manda
      [`GET /api/clinics/outreach/requests/${RQ}`]: {
        body: pedido({ state: 'sent', number: '•••0002' }),
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    expect(
      await screen.findByRole('checkbox', { name: `Escolher Paciente Fictícia, ${QUANDO}` }),
    ).toBeDisabled();
    expect(
      screen.getByRole('checkbox', { name: `Escolher Outra Fictícia, ${QUANDO}` }),
    ).toBeDisabled();
    expect(screen.getByText(/Faltam duas horas ou menos/)).toBeInTheDocument();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Acompanhar o pedido de Paciente Fictícia' }),
    );
    const detalhe = await screen.findByTestId('detalhe-do-pedido');
    expect(within(detalhe).getByText('Enviado (simulado)')).toBeInTheDocument();
    expect(within(detalhe).getByText('•••0002')).toBeInTheDocument();
    expect(within(detalhe).getByText(/Sem texto guardado/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.chave.startsWith('POST'))).toBe(false);
  });

  it('o estado incerto diz que pode ter saído e que nunca é reenviado; o motivo é o do despacho', async () => {
    mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario(ENVIA) },
      'GET /api/clinics/outreach/transport': { body: { simulated: false } },
      'GET /api/clinics/outreach/candidates': {
        body: [candidato({ blocked: 'request_exists', request: { id: RQ, state: 'uncertain' } })],
      },
      'GET /api/clinics/outreach/options': { body: [opcao] },
      [`GET /api/clinics/outreach/requests/${RQ}`]: {
        body: pedido({ state: 'uncertain', reason: 'lease_expired_in_flight' }),
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const acompanhar = await screen.findByRole('button', {
      name: 'Acompanhar o pedido de Paciente Fictícia',
    });
    expect(acompanhar).toHaveTextContent('Incerto: pode ter saído, e nunca é reenviado');
    fireEvent.click(acompanhar);
    const detalhe = await screen.findByTestId('detalhe-do-pedido');
    expect(within(detalhe).getByText('resultado não confirmado pelo provedor')).toBeInTheDocument();
    expect(within(detalhe).queryByText('recusado')).toBeNull();
  });

  it('com o transporte desconhecido (erro), o enviado não é afirmado como real', async () => {
    mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario(ENVIA) },
      'GET /api/clinics/outreach/transport': { status: 500, body: { message: 'falhou' } },
      'GET /api/clinics/outreach/candidates': {
        body: [candidato({ blocked: 'request_exists', request: { id: RQ, state: 'sent' } })],
      },
      'GET /api/clinics/outreach/options': { body: [opcao] },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    expect(
      await screen.findByRole('button', { name: 'Acompanhar o pedido de Paciente Fictícia' }),
    ).toHaveTextContent(/^Registrado como enviado$/);
  });
});

describe('envios: a recusa conciliada com o acompanhamento (adendo 12)', () => {
  const recusado = {
    body: {
      items: [
        {
          index: 0,
          requestId: RQ,
          state: 'refused',
          messageId: null,
          reason: 'catalog_name_in_text',
        },
      ],
    },
  };

  it('o item já aprovado nunca aparece como recusado: vale o acompanhamento do pedido', async () => {
    const chamadas = mockApi({
      ...ateAPrevia(false),
      'POST /api/clinics/outreach/approve': recusado,
      [`GET /api/clinics/outreach/requests/${RQ}`]: { body: pedido({ state: 'pending' }) },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(
      await screen.findByText(
        'Paciente Fictícia: Aprovado: aguardando o envio (conforme o acompanhamento do pedido)',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Recusado/)).toBeNull();
    expect(chamadas.some((c) => c.chave === `GET /api/clinics/outreach/requests/${RQ}`)).toBe(true);
    // conciliado: a tentativa terminou, e a tela volta ao normal
    expect(screen.queryByTestId('previa-da-clinica')).toBeNull();
  });

  it('o pedido ainda em rascunho: a recusa vale, com o motivo', async () => {
    mockApi({
      ...ateAPrevia(false),
      'POST /api/clinics/outreach/approve': recusado,
      [`GET /api/clinics/outreach/requests/${RQ}`]: { body: pedido({ state: 'draft' }) },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(
      await screen.findByText(
        'Paciente Fictícia: Recusado: o texto contém o nome de um serviço ou profissional do catálogo: revise o template',
      ),
    ).toBeInTheDocument();
  });

  it('sem confirmar no acompanhamento: a incerteza aparece, e a tentativa original fica, travada', async () => {
    const chamadas = mockApi({
      ...ateAPrevia(false),
      'POST /api/clinics/outreach/approve': recusado,
      [`GET /api/clinics/outreach/requests/${RQ}`]: { status: 503, body: { message: 'fora' } },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    const previa = await prepararAPrevia();
    fireEvent.click(within(previa).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    expect(
      await screen.findByText(
        'Paciente Fictícia: Não foi possível confirmar no acompanhamento do pedido',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Recusado/)).toBeNull();
    expect(
      screen.getByText(/A tentativa original fica preservada, sem nova prévia nem novo envio/),
    ).toBeInTheDocument();
    // a prévia da tentativa continua, e nada gera outra
    const mesma = screen.getByTestId('previa-da-clinica');
    expect(within(mesma).getByRole('button', { name: 'Descartar a prévia' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Preparar e ver a prévia/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Template revisado' })).toBeDisabled();
    // só a MESMA aprovação, com a mesma chave
    fireEvent.click(within(mesma).getByRole('button', { name: 'Aprovar e enviar (1)' }));
    await waitFor(() =>
      expect(chamadas.filter((c) => c.chave === 'POST /api/clinics/outreach/approve')).toHaveLength(
        2,
      ),
    );
    const aprovacoes = chamadas.filter((c) => c.chave === 'POST /api/clinics/outreach/approve');
    expect(aprovacoes[1].idempotencia).toBe(aprovacoes[0].idempotencia);
    expect(aprovacoes[1].corpo).toEqual(aprovacoes[0].corpo);
  });
});

describe('envios: permissões escondem e não consultam', () => {
  it('sem contatos e consentimentos: nenhum candidato é consultado', async () => {
    const chamadas = mockApi({ ...base, 'GET /api/auth/me': { body: usuario(LEITURA) } });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    expect(await screen.findByText(/Os envios mostram o número do paciente/)).toBeInTheDocument();
    expect(chamadas.some((c) => c.chave.includes('/outreach/'))).toBe(false);
    expect(chamadas.some((c) => c.chave.includes('/business-outbound/'))).toBe(false);
  });

  it('só leitura: vê os candidatos e o simulado, sem escolha e sem templates', async () => {
    const chamadas = mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario(VE_CANDIDATOS) },
      'GET /api/clinics/outreach/transport': { body: { simulated: true } },
      'GET /api/clinics/outreach/candidates': {
        body: [candidato({ blocked: 'request_exists', request: { id: RQ, state: 'sent' } })],
      },
    });
    renderizar(<ClinicsOutreachPage />, '/clinics/outreach');
    expect(
      await screen.findByRole('row', { name: `Candidato Paciente Fictícia, ${QUANDO}` }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/Preparar e aprovar envios exige também/)).toBeInTheDocument();
    // sem escrever nas conversas, o simulado chega pela rota do vertical
    expect(await screen.findByTestId('envio-simulado')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Acompanhar o pedido de Paciente Fictícia' }),
    ).toHaveTextContent('Enviado (simulado)');
    expect(chamadas.some((c) => c.chave.includes('/outreach/options'))).toBe(false);
    expect(chamadas.some((c) => c.chave.includes('/business-outbound/'))).toBe(false);
  });
});

const etapa = (extra: Record<string, unknown>) => ({
  status: 'complete',
  count: 0,
  known: 0,
  total: 0,
  reason: null,
  ...extra,
});
const grupo = (attended: number, noShow: number) => ({
  attended,
  noShow,
  rate: attended + noShow === 0 ? null : noShow / (attended + noShow),
});
const funil = {
  from: '2030-10-06',
  to: '2030-11-05',
  unitId: U,
  base: 10,
  canceled: 2,
  sent: 4,
  sentForEarlierSlot: 1,
  pending: 1,
  uncertain: 1,
  // o transporte falso: nenhum recibo do provedor
  delivered: etapa({
    status: 'no_data',
    count: null,
    total: 4,
    reason: 'no_provider_confirmation',
  }),
  responded: etapa({
    status: 'partial',
    count: 1,
    known: 2,
    total: 4,
    reason: 'no_provider_confirmation',
  }),
  confirmedByTeam: etapa({ status: 'complete', count: 0, known: 4, total: 4 }),
  noShowBySendGroup: { sent: grupo(3, 1), uncertain: grupo(0, 0), notSent: grupo(2, 0) },
};
const reativacao = {
  from: '2030-10-06',
  to: '2030-11-05',
  unitId: U,
  windowDays: 60,
  base: 0,
  uncertain: 1,
  returned: 0,
  rate: null,
  status: 'open',
};

describe('métricas do envio: nada de ausência como zero', () => {
  it('etapaLegivel: completa, parcial, sem dados e omitida', () => {
    expect(etapaLegivel(etapa({ count: 0, known: 4, total: 4 }) as never).valor).toBe('0 de 4');
    expect(etapaLegivel(etapa({ count: 0, known: 4, total: 4 }) as never).nota).toBe('0 %');
    const parcial = etapaLegivel(
      etapa({
        status: 'partial',
        count: 1,
        known: 2,
        total: 4,
        reason: 'confirmation_time_unknown',
      }) as never,
    );
    expect(parcial.valor).toBe('1 de 2 apurados');
    expect(parcial.nota).toMatch(
      /Cobertura parcial: 2 de 4 .*sem horário registrado.*não é de todos/,
    );
    expect(
      etapaLegivel(etapa({ status: 'no_data', count: null, reason: 'empty_base' }) as never),
    ).toEqual({ valor: 'Sem dados', nota: 'Sem dados: base vazia.' });
    expect(
      etapaLegivel(
        etapa({
          status: 'omitted',
          count: null,
          total: 4,
          reason: 'no_conversation_access',
        }) as never,
      ),
    ).toEqual({ valor: 'Omitida', nota: 'Contagem omitida: exige ler as conversas da contagem.' });
  });

  it('o funil mostra os grupos à parte, as etapas pelo status e o aviso do simulado', async () => {
    mockApi({
      ...base,
      // quem só lê a agenda também vê o simulado (pela rota do vertical)
      'GET /api/auth/me': { body: usuario(LEITURA) },
      'GET /api/clinics/outreach/transport': { body: { simulated: true } },
      'GET /api/clinics/metrics/confirmation': { body: funil },
      'GET /api/clinics/metrics/reactivation': { body: reativacao },
    });
    renderizar(<ClinicsOutreachMetricsPage />, '/clinics/outreach-metrics');
    const bloco = await screen.findByRole('region', { name: 'Funil da confirmação' });
    await within(bloco).findByText('Entregues');
    const entregues = within(bloco).getByText('Entregues').closest('[data-status]') as HTMLElement;
    expect(entregues.dataset.status).toBe('no_data');
    expect(within(entregues).getByText('Sem dados')).toBeInTheDocument();
    expect(within(entregues).getByText(/sem confirmação do provedor/)).toBeInTheDocument();
    expect(
      within(entregues).getByText(
        /No envio simulado, o provedor não confirma entrega nem resposta/,
      ),
    ).toBeInTheDocument();
    const resposta = within(bloco)
      .getByText('Com resposta atribuível ao paciente')
      .closest('[data-status]') as HTMLElement;
    expect(within(resposta).getByText('1 de 2 apurados')).toBeInTheDocument();
    expect(
      within(resposta).getByText(
        /sem resposta atribuível ao paciente segundo os critérios da métrica/,
      ),
    ).toBeInTheDocument();
    // a falta do grupo sem dados não é 0 %; o 0 % legítimo continua 0 %
    expect(within(bloco).getByText('Faltas nos incertos').nextSibling).toHaveTextContent(
      /^Sem dados$/,
    );
    expect(within(bloco).getByText('Faltas sem envio').nextSibling).toHaveTextContent(
      '0 % (0 em 2)',
    );
    expect(within(bloco).getByText('Sem envio', { selector: 'dt' }).nextSibling).toHaveTextContent(
      '3',
    );
    expect(screen.getByTestId('envio-simulado')).toBeInTheDocument();
    // a contagem do envio também diz que é simulado
    expect(within(bloco).getByText('Enviados (simulado) para o horário final')).toBeInTheDocument();
    // a reativação sem base: "Sem dados", e os incertos à parte
    const reat = screen.getByRole('region', { name: 'Retorno depois da reativação' });
    expect(within(reat).getByText('Sem dados')).toBeInTheDocument();
    expect(within(reat).getByTestId('situacao-da-reativacao')).toHaveTextContent('Em apuração');
  });

  it('a resposta omitida sem ler conversas; a conversão sem pipelines não é consultada', async () => {
    const chamadas = mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario(LEITURA) },
      'GET /api/clinics/metrics/confirmation': {
        body: {
          ...funil,
          responded: etapa({
            status: 'omitted',
            count: null,
            total: 4,
            reason: 'no_conversation_access',
          }),
        },
      },
      'GET /api/clinics/metrics/reactivation': { body: reativacao },
    });
    renderizar(<ClinicsOutreachMetricsPage />, '/clinics/outreach-metrics');
    const bloco = await screen.findByRole('region', { name: 'Funil da confirmação' });
    const resposta = (
      await within(bloco).findByText('Com resposta atribuível ao paciente')
    ).closest('[data-status]') as HTMLElement;
    expect(within(resposta).getByText('Omitida')).toBeInTheDocument();
    expect(within(resposta).queryByText(/^0/)).toBeNull();
    expect(screen.getByTestId('conversao-sem-acesso')).toHaveTextContent(
      'A conversão exige ler os pipelines.',
    );
    expect(chamadas.some((c) => c.chave.includes('/metrics/conversion'))).toBe(false);
    expect(chamadas.some((c) => c.chave.includes('/api/pipelines'))).toBe(false);
    expect(chamadas.some((c) => c.chave.includes('/business-outbound/'))).toBe(false);
  });

  it('a conversão usa o pipeline padrão e diz que a janela encerrada ainda pode mudar', async () => {
    const chamadas = mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario([...LEITURA, 'pipelines:read']) },
      'GET /api/pipelines': {
        body: [
          {
            id: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e62',
            name: 'Outro',
            isDefault: false,
            stages: [],
          },
          { id: PIPE, name: 'Comercial', isDefault: true, stages: [] },
        ],
      },
      'GET /api/clinics/metrics/confirmation': { body: funil },
      'GET /api/clinics/metrics/reactivation': { body: reativacao },
      'GET /api/clinics/metrics/conversion': {
        body: {
          from: '2030-10-06',
          to: '2030-11-05',
          unitId: U,
          pipelineId: PIPE,
          windowDays: 90,
          base: 3,
          converted: 1,
          rate: 1 / 3,
          status: 'window_closed',
        },
      },
    });
    renderizar(<ClinicsOutreachMetricsPage />, '/clinics/outreach-metrics');
    expect(await screen.findByTestId('situacao-da-conversao')).toHaveTextContent(
      'recalculado pelo estado atual e ainda pode mudar',
    );
    expect(screen.getByText('1 de 3 oportunidades')).toBeInTheDocument();
    expect(
      chamadas.find((c) => c.chave.startsWith('GET /api/clinics/metrics/conversion'))?.chave,
    ).toContain(`pipelineId=${PIPE}`);
  });

  it('a conversão sem oportunidades no período é "Sem dados", e a definição não depende do estado do deal', async () => {
    mockApi({
      ...base,
      'GET /api/auth/me': { body: usuario([...LEITURA, 'pipelines:read']) },
      'GET /api/pipelines': {
        body: [{ id: PIPE, name: 'Comercial', isDefault: true, stages: [] }],
      },
      'GET /api/clinics/metrics/confirmation': { body: funil },
      'GET /api/clinics/metrics/reactivation': { body: reativacao },
      'GET /api/clinics/metrics/conversion': {
        body: {
          from: '2030-10-06',
          to: '2030-11-05',
          unitId: U,
          pipelineId: PIPE,
          windowDays: 90,
          base: 0,
          converted: 0,
          rate: null,
          status: 'open',
        },
      },
    });
    renderizar(<ClinicsOutreachMetricsPage />, '/clinics/outreach-metrics');
    const bloco = await screen.findByRole('region', { name: 'Conversão' });
    expect(
      await within(bloco).findByText('Nenhuma oportunidade criada no período neste pipeline.'),
    ).toBeInTheDocument();
    expect(within(bloco).getByText('Taxa').nextSibling).toHaveTextContent('Sem dados');
    expect(within(bloco).getByText(/não muda a conta/)).toBeInTheDocument();
    expect(within(bloco).queryByText(/ganha na janela/)).toBeNull();
  });
});

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
  localDate: '2030-11-04',
  localStart: '09:00',
  localEnd: '10:00',
  status: 'confirmed',
  cancelReason: null,
  ...extra,
});
const agenda: Record<string, Rota> = {
  ...base,
  'GET /api/clinics/services': {
    body: [
      {
        id: S1,
        name: 'Limpeza',
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
        workingHours: [],
        archivedAt: null,
      },
    ],
  },
};
const QUEM = '09:00 Paciente Fictícia (Ana Fictícia)';

describe('vínculo do agendamento com a oportunidade', () => {
  it('troca o vínculo sem efeito; a oportunidade de outro contato é dita, não escondida', async () => {
    const chamadas = mockApi({
      ...agenda,
      'GET /api/auth/me': {
        body: usuario([...LEITURA, 'clinics:schedule:write', 'pipelines:read']),
      },
      'GET /api/clinics/appointments': { body: [agendamento()] },
      [`GET /api/clinics/appointments/${AG}/deal-options`]: {
        body: [
          {
            id: DEAL2,
            title: 'Pacote facial',
            pipelineId: PIPE,
            createdAt: '2030-10-01T12:00:00.000Z',
          },
        ],
      },
      [`GET /api/clinics/appointments/${AG}/deal`]: {
        // o servidor não manda o título da oportunidade que deixou de ser do contato
        body: { appointmentId: AG, dealId: DEAL, dealTitle: null, valid: false },
      },
      [`PUT /api/clinics/appointments/${AG}/deal`]: {
        body: { appointmentId: AG, dealId: DEAL2, dealTitle: 'Pacote facial', valid: true },
      },
    });
    renderizar(<ClinicsAgendaPage />, '/clinics/agenda?dia=2030-11-04');
    fireEvent.click(await screen.findByRole('button', { name: `Oportunidade: ${QUEM}` }));
    const painel = await screen.findByTestId('vinculo-com-oportunidade');
    expect(within(painel).getByText('Oportunidade de outro contato')).toBeInTheDocument();
    expect(within(painel).getByRole('note')).toHaveTextContent('Vínculo sem efeito');
    const escolha = within(painel).getByRole('combobox', { name: 'Trocar por' });
    await within(escolha).findByRole('option', { name: /Pacote facial/ });
    fireEvent.change(escolha, { target: { value: DEAL2 } });
    fireEvent.click(within(painel).getByRole('button', { name: 'Trocar' }));
    expect(await within(painel).findByText('Pacote facial')).toBeInTheDocument();
    expect(within(painel).queryByRole('note')).toBeNull();
    expect(chamadas.find((c) => c.chave.startsWith('PUT'))?.corpo).toEqual({ dealId: DEAL2 });
  });

  it('depois do atendimento, só a leitura; sem pipelines, nem o botão', async () => {
    const chamadas = mockApi({
      ...agenda,
      'GET /api/auth/me': {
        body: usuario([...LEITURA, 'clinics:schedule:write', 'pipelines:read']),
      },
      'GET /api/clinics/appointments': { body: [agendamento({ status: 'attended' })] },
      [`GET /api/clinics/appointments/${AG}/deal`]: {
        body: { appointmentId: AG, dealId: null, dealTitle: null, valid: null },
      },
    });
    renderizar(<ClinicsAgendaPage />, '/clinics/agenda?dia=2030-11-04');
    fireEvent.click(await screen.findByRole('button', { name: `Oportunidade: ${QUEM}` }));
    const painel = await screen.findByTestId('vinculo-com-oportunidade');
    expect(within(painel).getByText('Nenhuma.')).toBeInTheDocument();
    expect(
      within(painel).getByText(/Depois do atendimento, o vínculo não muda mais/),
    ).toBeInTheDocument();
    expect(within(painel).queryByRole('combobox')).toBeNull();
    expect(chamadas.some((c) => c.chave.includes('deal-options'))).toBe(false);
  });

  it('sem pipelines:read, o cartão não oferece a oportunidade', async () => {
    const chamadas = mockApi({
      ...agenda,
      'GET /api/auth/me': { body: usuario([...LEITURA, 'clinics:schedule:write']) },
      'GET /api/clinics/appointments': { body: [agendamento()] },
    });
    renderizar(<ClinicsAgendaPage />, '/clinics/agenda?dia=2030-11-04');
    await screen.findByRole('article', { name: `Agendamento ${QUEM}` });
    expect(screen.queryByRole('button', { name: `Oportunidade: ${QUEM}` })).toBeNull();
    await waitFor(() => expect(chamadas.some((c) => c.chave.includes('/deal'))).toBe(false));
  });
});

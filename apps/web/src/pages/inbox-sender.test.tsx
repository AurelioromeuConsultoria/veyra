import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { criarQueryClient } from '../lib/session-query';
import { SenderPanel } from './InboxSender';

/**
 * O painel do remetente (ADR-052 item 2). Dados FICTÍCIOS. O que se prova: a
 * escolha é sempre de uma pessoa, entre os candidatos ou com um contato novo; o
 * rejeitar diz o que acontece sem tirar o número; a recusa do servidor (o
 * legado) aparece como veio.
 */

const CONVERSA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31';
const ANA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e32';
const BIA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e33';

const conversa = (extra: Partial<ConversationDto> = {}): ConversationDto => ({
  id: CONVERSA,
  channelType: 'whatsapp',
  contactId: null,
  contactName: null,
  senderStatus: 'unidentified',
  senderAddress: '+5511987654321',
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: null,
  status: 'open',
  assigneeMembershipId: null,
  assigneeName: null,
  lastMessageAt: '2030-11-04T12:00:00.000Z',
  windowExpiresAt: null,
  createdAt: '2030-11-04T12:00:00.000Z',
  ...extra,
});

type Resposta = { status?: number; body?: unknown };

function mockApi(rotas: Record<string, Resposta>) {
  const chamadas: { chave: string; corpo?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      chamadas.push({ chave, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
      const resposta = rotas[chave] ?? { status: 404, body: { message: `sem mock: ${chave}` } };
      return new Response(JSON.stringify(resposta.body ?? {}), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

function renderizar(c: ConversationDto, onChanged = vi.fn()) {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <SenderPanel conversation={c} onChanged={onChanged} />
    </QueryClientProvider>,
  );
  return onChanged;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o remetente a identificar', () => {
  it('lista os candidatos, exato e possível, e identifica pela escolha da pessoa', async () => {
    const chamadas = mockApi({
      [`GET /api/conversations/${CONVERSA}/sender/candidates`]: {
        body: [
          { contactId: ANA, name: 'Ana Fictícia', match: 'exact' },
          { contactId: BIA, name: 'Bia Fictícia', match: 'possible' },
        ],
      },
      [`POST /api/conversations/${CONVERSA}/sender/identify`]: { body: conversa() },
    });
    const onChanged = renderizar(conversa());
    const lista = await screen.findByRole('list', { name: 'Candidatos a remetente' });
    expect(within(lista).getByText('(número exato)')).toBeInTheDocument();
    expect(within(lista).getByText(/número possível/)).toBeInTheDocument();
    // a RAI não recebe resposta, e identificar um possível não a libera sozinho
    expect(within(lista).getByText(/responder exigirá o número exato/)).toBeInTheDocument();
    expect(
      screen.getByText(/Para responder, identifique primeiro quem escreveu/),
    ).toBeInTheDocument();
    // a regra de que vale só para esta conversa está dita
    expect(screen.getByText(/vale só para esta conversa/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Identificar como Bia Fictícia' }));
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: `POST /api/conversations/${CONVERSA}/sender/identify`,
        corpo: { contactId: BIA },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('cria um contato novo que recebe o número, só com nome digitado', async () => {
    const chamadas = mockApi({
      [`GET /api/conversations/${CONVERSA}/sender/candidates`]: { body: [] },
      [`POST /api/conversations/${CONVERSA}/sender/identify`]: { body: conversa() },
    });
    renderizar(conversa());
    const criar = await screen.findByRole('button', { name: 'Criar e identificar' });
    expect(criar).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Nome do contato novo'), {
      target: { value: '  Cora Fictícia ' },
    });
    fireEvent.click(criar);
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: `POST /api/conversations/${CONVERSA}/sender/identify`,
        corpo: { newContact: { name: 'Cora Fictícia' } },
      }),
    );
  });

  it('a recusa do servidor aparece como veio (a conversa com legado)', async () => {
    mockApi({
      [`GET /api/conversations/${CONVERSA}/sender/candidates`]: {
        body: [{ contactId: ANA, name: 'Ana Fictícia', match: 'exact' }],
      },
      [`POST /api/conversations/${CONVERSA}/sender/identify`]: {
        status: 409,
        body: {
          message:
            'Esta conversa tem mensagens anteriores à atualização, ligadas ao contato. Corrigir o remetente dela ainda não é possível.',
        },
      },
    });
    renderizar(conversa());
    fireEvent.click(await screen.findByRole('button', { name: 'Identificar como Ana Fictícia' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /mensagens anteriores à atualização/,
    );
  });
});

describe('o remetente identificado', () => {
  const identificada = (extra: Partial<ConversationDto> = {}) =>
    conversa({ senderStatus: 'identified', contactId: ANA, contactName: 'Ana Fictícia', ...extra });

  it('desfazer só aparece na identificação feita por uma pessoa', async () => {
    const chamadas = mockApi({
      [`POST /api/conversations/${CONVERSA}/sender/unidentify`]: { body: conversa() },
    });
    renderizar(identificada({ senderIdentifiedByPerson: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Desfazer identificação' }));
    await waitFor(() =>
      expect(chamadas.map((c) => c.chave)).toContain(
        `POST /api/conversations/${CONVERSA}/sender/unidentify`,
      ),
    );
  });

  it('a conversa do LEGADO não oferece ato nenhum: o servidor recusaria, e a tela diz por quê', () => {
    mockApi({});
    renderizar(identificada({ senderRelinkBlocked: true, senderIdentifiedByPerson: true }));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/mensagens anteriores à atualização/)).toBeInTheDocument();
  });

  it('a atribuída pela ingestão não oferece desfazer, só "o remetente não é este contato"', () => {
    mockApi({});
    renderizar(identificada());
    expect(screen.queryByRole('button', { name: 'Desfazer identificação' })).toBeNull();
    expect(screen.getByRole('button', { name: 'O remetente não é este contato' })).toBeEnabled();
  });

  it('rejeitar diz o que acontece sem tirar o número, e manda a escolha feita', async () => {
    const chamadas = mockApi({
      [`POST /api/conversations/${CONVERSA}/sender/reject`]: { body: conversa() },
    });
    renderizar(identificada());
    fireEvent.click(screen.getByRole('button', { name: 'O remetente não é este contato' }));
    expect(screen.getByText(/volta a cair neste contato/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Tirar este número do cadastro do contato/));
    expect(screen.queryByText(/volta a cair neste contato/)).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Confirmar: o remetente não é este contato' }),
    );
    await waitFor(() =>
      expect(chamadas).toContainEqual({
        chave: `POST /api/conversations/${CONVERSA}/sender/reject`,
        corpo: { removeNumber: true },
      }),
    );
  });
});

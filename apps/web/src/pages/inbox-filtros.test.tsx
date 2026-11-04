import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUserDto, ConversationDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { crmExperience } from '../experiences/crm';
import { ExperienceProvider } from '../lib/experience';
import { ME_KEY } from '../lib/session';
import { InboxPage } from './Inbox';

/**
 * Os recortes da lista de conversas (ADR-062, adendo 1, item 3). Dados
 * FICTÍCIOS. O que se prova: a primeira pílula é o status escolhido, com a
 * contagem da lista dele; "Minhas" pede o responsável = a membership ATIVA;
 * "A identificar" pede `senderStatus=unidentified` e só aparece para quem
 * decide o remetente; o select "Filtrar por status" continua e combina com o
 * recorte.
 */

const MEMBERSHIP = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e61';

const conversa = (id: string, extra: Partial<ConversationDto> = {}): ConversationDto => ({
  id,
  channelType: 'internal',
  contactId: null,
  contactName: null,
  senderStatus: 'identified',
  senderAddress: null,
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: `Assunto ${id}`,
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
    name: 'Atendente Fictícia',
    email: 'atendente@empresa.test',
    activeMembership: {
      membershipId: MEMBERSHIP,
      workspaceId: 'w1',
      workspaceName: 'Empresa',
      workspaceSlug: 'empresa',
      roleName: 'Member',
      roleSystemKey: 'member',
      status: 'active',
    },
    permissions,
    memberships: [],
    experience: { key: 'crm', status: 'ready' },
  }) as unknown as AuthUserDto;

const DECIDE_REMETENTE = [
  'conversations:read',
  'conversations:write',
  'contacts:read',
  'contacts:write',
];

/** a lista responde pelo pedido: cada recorte, um conjunto distinto */
function mockApi() {
  const pedidos: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
      if (url.pathname !== '/api/conversations') {
        return new Response(JSON.stringify({ message: `sem mock: ${url}` }), { status: 404 });
      }
      const q = url.searchParams;
      pedidos.push(q);
      const items = q.get('senderStatus')
        ? [
            conversa('rai', {
              senderStatus: 'unidentified',
              subject: null,
              channelType: 'whatsapp',
            }),
          ]
        : q.get('assigneeMembershipId')
          ? [conversa('minha', { assigneeMembershipId: MEMBERSHIP })]
          : q.get('status') === 'closed'
            ? [conversa('fechada', { status: 'closed' })]
            : [conversa('a'), conversa('b'), conversa('minha')];
      return new Response(JSON.stringify({ items, nextCursor: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return pedidos;
}

function renderizar(permissions: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(ME_KEY, usuario(permissions));
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExperienceProvider value={crmExperience}>
          <InboxPage />
        </ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole('group', { name: 'Recorte da lista' });
}

/** os parâmetros de cada pedido da lista (a contagem do status é um pedido à parte) */
const pedidosFeitos = (pedidos: URLSearchParams[]) =>
  pedidos.map((q) => Object.fromEntries(q.entries()));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Inbox — recortes da lista', () => {
  it('Abertas · N por padrão; Minhas e A identificar estreitam o pedido', async () => {
    const pedidos = mockApi();
    const recorte = renderizar(DECIDE_REMETENTE);
    const abertas = await within(recorte).findByRole('button', { name: 'Abertas · 3' });
    expect(abertas).toHaveAttribute('aria-pressed', 'true');
    expect(pedidosFeitos(pedidos)).toContainEqual({ status: 'open', limit: '50' });

    fireEvent.click(within(recorte).getByRole('button', { name: 'Minhas' }));
    await screen.findByRole('button', { name: /Assunto minha/ });
    expect(pedidosFeitos(pedidos)).toContainEqual({
      status: 'open',
      limit: '50',
      assigneeMembershipId: MEMBERSHIP,
    });
    expect(within(recorte).getByRole('button', { name: 'Minhas' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // a contagem da primeira pílula continua a do status, sem o recorte
    expect(within(recorte).getByRole('button', { name: 'Abertas · 3' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(within(recorte).getByRole('button', { name: 'A identificar' }));
    await screen.findByRole('button', { name: /Remetente a identificar/ });
    expect(pedidosFeitos(pedidos)).toContainEqual({
      status: 'open',
      limit: '50',
      senderStatus: 'unidentified',
    });
    expect(screen.queryByRole('button', { name: /Assunto a\b/ })).toBeNull();
  });

  it('o select de status continua e combina com o recorte; a primeira pílula segue o status', async () => {
    const pedidos = mockApi();
    const recorte = renderizar(DECIDE_REMETENTE);
    await within(recorte).findByRole('button', { name: 'Abertas · 3' });
    fireEvent.click(within(recorte).getByRole('button', { name: 'A identificar' }));
    fireEvent.change(screen.getByLabelText('Filtrar por status'), {
      target: { value: 'closed' },
    });
    await waitFor(() =>
      expect(pedidosFeitos(pedidos)).toContainEqual({
        status: 'closed',
        limit: '50',
        senderStatus: 'unidentified',
      }),
    );
    // de volta a todas as do status: a pílula diz "Fechadas"
    fireEvent.click(await within(recorte).findByRole('button', { name: 'Fechadas · 1' }));
    await screen.findByRole('button', { name: /Assunto fechada/ });
    expect(pedidosFeitos(pedidos)).toContainEqual({ status: 'closed', limit: '50' });
  });

  it('sem poder decidir o remetente, "A identificar" não aparece; "Minhas" sim', async () => {
    const pedidos = mockApi();
    const recorte = renderizar(['conversations:read', 'contacts:read']);
    await within(recorte).findByRole('button', { name: 'Abertas · 3' });
    expect(within(recorte).getByRole('button', { name: 'Minhas' })).toBeInTheDocument();
    expect(within(recorte).queryByRole('button', { name: 'A identificar' })).toBeNull();
    expect(pedidos.some((q) => q.has('senderStatus'))).toBe(false);
  });
});

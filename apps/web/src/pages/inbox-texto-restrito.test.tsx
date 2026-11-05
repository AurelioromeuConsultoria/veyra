import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUserDto, ConversationDto, MessageDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { crmExperience } from '../experiences/crm';
import { ExperienceProvider } from '../lib/experience';
import { ME_KEY } from '../lib/session';
import { InboxPage } from './Inbox';

/**
 * O texto restrito das conversas (ADR-061, adendo 9, item 8). Dados FICTÍCIOS.
 * O que se prova: a tela só reflete o servidor — o assunto e o corpo chegam
 * como "Conteúdo restrito", com a marca `textRestricted`, e aparecem com o
 * mesmo aviso em toda conversa com pessoa; a contagem de mensagens é a que
 * veio; o compositor some (quem não lê não escreve), e a mudança de status
 * continua; a conversa sem a marca é a de sempre.
 */

const RESTRITO = 'Conteúdo restrito';
const MEMBERSHIP = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e71';

const conversa = (id: string, extra: Partial<ConversationDto> = {}): ConversationDto => ({
  id,
  channelType: 'internal',
  contactId: `contato-${id}`,
  contactName: `Pessoa ${id}`,
  senderStatus: 'identified',
  senderAddress: null,
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: RESTRITO,
  textRestricted: true,
  status: 'open',
  assigneeMembershipId: null,
  assigneeName: null,
  lastMessageAt: '2030-11-04T12:00:00.000Z',
  windowExpiresAt: null,
  createdAt: '2030-11-04T11:00:00.000Z',
  ...extra,
});

const mensagem = (id: string, extra: Partial<MessageDto> = {}): MessageDto => ({
  id,
  direction: 'inbound',
  authorType: 'contact',
  authorName: 'Pessoa',
  body: RESTRITO,
  attachments: [],
  dispatchState: null,
  dispatchError: null,
  deliveredAt: '2030-11-04T12:00:00.000Z',
  createdAt: '2030-11-04T12:00:00.000Z',
  textRestricted: true,
  ...extra,
});

const usuario = (permissions: string[]) =>
  ({
    id: 'u1',
    name: 'Operadora Fictícia',
    email: 'operadora@empresa.test',
    activeMembership: {
      membershipId: MEMBERSHIP,
      workspaceId: 'w1',
      workspaceName: 'Empresa',
      workspaceSlug: 'empresa',
      roleName: 'Conversas do CRM',
      status: 'active',
    },
    permissions,
    memberships: [],
    experience: { key: 'crm', status: 'ready' },
  }) as unknown as AuthUserDto;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://x');
      if (url.pathname === '/api/conversations') {
        return json({
          items: [
            conversa('a'),
            conversa('b'),
            conversa('livre', {
              contactId: null,
              contactName: null,
              subject: 'Reunião interna',
              textRestricted: undefined,
            }),
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === '/api/conversations/a/messages') {
        return json({
          items: [
            mensagem('m3', { direction: 'outbound', authorType: 'user', authorName: 'Equipe' }),
            mensagem('m2'),
            mensagem('m1', { attachments: [{ restricted: true }] }),
          ],
          nextCursor: null,
        });
      }
      if (url.pathname === '/api/conversations/livre/messages') {
        return json({
          items: [mensagem('l1', { body: 'Pauta da semana', textRestricted: undefined })],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith('/send-policy')) {
        const restrita = !url.pathname.includes('/livre/');
        return json({
          channelType: 'internal',
          mode: restrita ? 'blocked' : 'free_form',
          reason: restrita ? RESTRITO : null,
          windowExpiresAt: null,
          consentStatus: null,
          templates: [],
        });
      }
      return new Response(JSON.stringify({ message: `sem mock: ${url}` }), { status: 404 });
    }),
  );
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
}

beforeEach(() => {
  // o jsdom não rola: a conversa ancora as mensagens embaixo com `scrollTo`
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Inbox — o texto restrito das conversas (ADR-061, adendo 9, item 8)', () => {
  it('a lista mostra o mesmo aviso no lugar do assunto, em toda conversa com pessoa', async () => {
    mockApi();
    renderizar(['conversations:read', 'conversations:write', 'contacts:read']);
    const a = await screen.findByRole('button', { name: /^Pessoa a/ });
    const b = screen.getByRole('button', { name: /^Pessoa b/ });
    for (const linha of [a, b]) {
      const aviso = within(linha).getByText(RESTRITO);
      expect(aviso).toHaveClass('italic');
    }
    // a conversa sem pessoa: o assunto de sempre, sem o aviso
    const livre = screen.getByRole('button', { name: /Reunião interna/ });
    expect(within(livre).queryByText(RESTRITO)).toBeNull();
  });

  it('as mensagens chegam com o aviso, na contagem do servidor; o compositor some e o status fica', async () => {
    mockApi();
    renderizar(['conversations:read', 'conversations:write', 'contacts:read']);
    fireEvent.click(await screen.findByRole('button', { name: /^Pessoa a/ }));
    // as três mensagens, cada uma com o mesmo aviso (e o anexo restrito como
    // sempre), mais as duas legendas da lista: cinco parágrafos iguais
    await waitFor(() => expect(screen.getAllByText(RESTRITO, { selector: 'p' })).toHaveLength(5));
    expect(screen.getByText('Anexo restrito')).toBeInTheDocument();
    // quem não lê não escreve: sem o compositor, com o motivo
    expect(screen.getByTestId('composer-restrito')).toHaveTextContent(
      /Conteúdo restrito: o texto desta conversa não está disponível/,
    );
    expect(screen.queryByRole('textbox', { name: 'Corpo da mensagem' })).toBeNull();
    // a estrutura continua: o status da conversa se muda
    expect(screen.getByRole('combobox', { name: 'Status da conversa' })).toBeInTheDocument();
  });

  it('a conversa sem a marca é a de sempre: o texto e o compositor', async () => {
    mockApi();
    renderizar(['conversations:read', 'conversations:write', 'contacts:read']);
    fireEvent.click(await screen.findByRole('button', { name: /Reunião interna/ }));
    expect(await screen.findByText('Pauta da semana')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-restrito')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Corpo da mensagem' })).toBeInTheDocument();
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationDto } from '@veyra/contracts';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { WindowChip } from '../components/ui/window-meter';
import { crmExperience } from '../experiences/crm';
import { ExperienceProvider, type ContextoDaConversaProps } from '../lib/experience';
import { criarQueryClient } from '../lib/session-query';
import { ContextoDaConversa } from './InboxContexto';

/**
 * O painel de contexto das Conversas (ADR-062). Dados FICTÍCIOS. O que se
 * prova: a RAI não ganha nome nem rosto, só o número que a lista já mostra; o
 * link para a ficha é o do produto e depende de `contacts:read`; o painel não
 * carrega ação (ele some em tela estreita); e o chip do cabeçalho diz a janela
 * fechada por extenso.
 */

const CONVERSA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e41';
const CONTATO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e42';
const MEMBRO = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e43';

const conversa = (extra: Partial<ConversationDto> = {}): ConversationDto => ({
  id: CONVERSA,
  channelType: 'whatsapp',
  contactId: CONTATO,
  contactName: 'Pessoa Fictícia',
  senderStatus: 'identified',
  senderAddress: '+5511987654321',
  senderIdentifiedByPerson: false,
  senderRelinkBlocked: false,
  subject: 'Orçamento',
  status: 'open',
  assigneeMembershipId: MEMBRO,
  assigneeName: 'Atendente Fictícia',
  lastMessageAt: '2030-11-04T12:00:00.000Z',
  windowExpiresAt: null,
  createdAt: '2030-11-04T11:00:00.000Z',
  ...extra,
});

function sessao(permissions: string[], membershipId = 'outra') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url !== '/api/auth/me') {
        return new Response(JSON.stringify({ message: `sem mock: ${url}` }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: 'u1',
          name: 'Usuária Fictícia',
          email: 'usuaria@empresa.test',
          activeMembership: {
            membershipId,
            workspaceId: 'w1',
            workspaceName: 'Empresa',
            workspaceSlug: 'empresa',
            roleName: 'Owner',
            status: 'active',
          },
          permissions,
          memberships: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
}

function renderizar(ui: ReactNode, manifesto = crmExperience) {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExperienceProvider value={manifesto}>{ui}</ExperienceProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ContextoDaConversa', () => {
  it('a RAI mostra só o número: nem nome, nem rosto, nem a ficha', async () => {
    sessao(['contacts:read', 'conversations:read']);
    renderizar(
      <ContextoDaConversa
        conversa={conversa({
          senderStatus: 'unidentified',
          contactId: null,
          contactName: null,
        })}
        janelaExpiraEm={null}
      />,
    );
    const painel = screen.getByRole('complementary', { name: 'Contexto da conversa' });
    expect(within(painel).getByText('Remetente a identificar')).toBeInTheDocument();
    expect(within(painel).getByText('+5511987654321')).toBeInTheDocument();
    // a sessão chega e o link continua ausente: a RAI não aponta para contato
    await new Promise((r) => setTimeout(r, 20));
    expect(within(painel).queryByRole('link')).toBeNull();
    expect(within(painel).queryByText('Pessoa Fictícia')).toBeNull();
  });

  it('o contato identificado leva à ficha só com contacts:read', async () => {
    sessao(['contacts:read', 'conversations:read'], MEMBRO);
    renderizar(<ContextoDaConversa conversa={conversa()} janelaExpiraEm={null} />);
    const painel = screen.getByRole('complementary', { name: 'Contexto da conversa' });
    expect(within(painel).getByText('Pessoa Fictícia')).toBeInTheDocument();
    const link = await within(painel).findByRole('link', { name: /Abrir a ficha do contato/ });
    expect(link).toHaveAttribute('href', `/contacts?c=${CONTATO}`);
    // a membership desta sessão é a responsável
    expect(within(painel).getByText('você')).toBeInTheDocument();
    expect(within(painel).getByText('Orçamento')).toBeInTheDocument();
    expect(within(painel).getByText('WhatsApp')).toBeInTheDocument();
  });

  it('sem contacts:read, nenhum link; e o painel não carrega ação', async () => {
    sessao(['conversations:read'], MEMBRO);
    renderizar(<ContextoDaConversa conversa={conversa()} janelaExpiraEm={null} />);
    const painel = screen.getByRole('complementary', { name: 'Contexto da conversa' });
    // "você" só aparece com a sessão carregada: a ausência do link não é cedo demais
    expect(await within(painel).findByText('você')).toBeInTheDocument();
    expect(within(painel).queryByRole('link')).toBeNull();
    expect(within(painel).queryAllByRole('button')).toHaveLength(0);
  });

  it('o encaixe do produto é desenhado com o contato, e a RAI chega sem contato', () => {
    sessao(['conversations:read']);
    const recebido: ContextoDaConversaProps[] = [];
    // um encaixe qualquer: o painel não sabe o que ele mostra
    const Encaixe = (props: ContextoDaConversaProps) => {
      recebido.push(props);
      return <p>conteúdo do produto</p>;
    };
    const manifesto = { ...crmExperience, contextoDaConversa: Encaixe };
    renderizar(<ContextoDaConversa conversa={conversa()} janelaExpiraEm={null} />, manifesto);
    expect(screen.getByText('conteúdo do produto')).toBeInTheDocument();
    expect(recebido.at(-1)).toEqual({ contactId: CONTATO, conversationId: CONVERSA });

    // mesmo que o DTO trouxesse um contato, a RAI não o passa adiante
    renderizar(
      <ContextoDaConversa
        conversa={conversa({ senderStatus: 'unidentified', contactName: null })}
        janelaExpiraEm={null}
      />,
      manifesto,
    );
    expect(recebido.at(-1)).toEqual({ contactId: null, conversationId: CONVERSA });
  });

  it('sem encaixe no manifesto (o CRM), o painel é o de sempre', () => {
    sessao(['conversations:read']);
    renderizar(<ContextoDaConversa conversa={conversa()} janelaExpiraEm={null} />);
    expect(crmExperience.contextoDaConversa).toBeUndefined();
    expect(screen.getByRole('complementary', { name: 'Contexto da conversa' })).toBeInTheDocument();
  });

  it('o canal externo mostra o medidor da janela', () => {
    sessao(['conversations:read']);
    const daqui3h = new Date(Date.now() + 3 * 3_600_000 + 60_000).toISOString();
    renderizar(<ContextoDaConversa conversa={conversa()} janelaExpiraEm={daqui3h} />);
    expect(screen.getByRole('meter', { name: 'Janela de 24h do canal' })).toBeInTheDocument();
    expect(screen.getByText(/^3h0\d restantes$/)).toBeInTheDocument();
  });
});

describe('WindowChip no cabeçalho', () => {
  it('diz a janela fechada por extenso', () => {
    render(<WindowChip variant="header" expiresAt="2020-01-01T00:00:00.000Z" />);
    expect(screen.getByText('Janela fechada · só template')).toBeInTheDocument();
  });

  it('sem janela (canal sem contato ainda), nada', () => {
    const { container } = render(<WindowChip variant="header" expiresAt={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

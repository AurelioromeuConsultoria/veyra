import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Timeline } from './Timeline';

/**
 * A timeline diz que há conteúdo restrito quando o servidor tirou dela notas e
 * tarefas que o acesso não mostra (ADR-061, adendo 2), sem dizer qual.
 */
function comResposta(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Timeline contactId="0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e31" />
    </QueryClientProvider>,
  );
}

const criado = {
  id: 'a1',
  type: 'contact_created',
  actorName: 'Ana',
  payload: { name: 'Pessoa Fictícia' },
  occurredAt: '2030-01-02T12:00:00Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Timeline', () => {
  it('com restrictedContent: o aviso, junto com o que pode ser mostrado', async () => {
    comResposta({ items: [criado], nextCursor: null, restrictedContent: true });
    expect(await screen.findByText(/^Conteúdo restrito/)).toBeInTheDocument();
    expect(screen.getByText(/criou o contato Pessoa Fictícia/)).toBeInTheDocument();
  });

  it('só com conteúdo restrito: o aviso no lugar de "nada aconteceu"', async () => {
    comResposta({ items: [], nextCursor: null, restrictedContent: true });
    expect(await screen.findByText(/^Conteúdo restrito/)).toBeInTheDocument();
    expect(screen.queryByText('Nada aconteceu por aqui ainda.')).toBeNull();
  });

  it('sem a marca: a timeline de sempre, sem aviso', async () => {
    comResposta({ items: [criado], nextCursor: null });
    expect(await screen.findByText(/criou o contato Pessoa Fictícia/)).toBeInTheDocument();
    expect(screen.queryByText(/Conteúdo restrito/)).toBeNull();
  });
});

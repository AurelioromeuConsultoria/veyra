import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('sem sessão: renderiza a tela de login', async () => {
    // /auth/me responde 401 (sem sessão)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ message: 'Não autenticado' }), { status: 401 }),
      ),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/login']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.getByText('veyra')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

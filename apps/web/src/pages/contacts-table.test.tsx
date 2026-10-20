import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as TabelaReal from '@tanstack/react-table';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ContactsPage } from './Contacts';

/**
 * Regressão: a tabela de contatos congelava a aba quando se digitava na busca
 * antes da PRIMEIRA resposta da lista. O `data` da tabela era um `[]` novo a
 * cada render, e o TanStack Table entrava num laço de microtarefas.
 *
 * O teste confere a causa sem depender do laço: o array entregue à tabela
 * enquanto a lista carrega é SEMPRE o mesmo. A tabela real recebe um vazio
 * fixo, para o teste nunca travar o runner se o defeito voltar.
 */
const entregues = vi.hoisted(() => [] as unknown[]);
vi.mock('@tanstack/react-table', async (original) => {
  const real = await original<typeof TabelaReal>();
  const vazio: unknown[] = [];
  return {
    ...real,
    useReactTable: (options: Parameters<typeof real.useReactTable>[0]) => {
      entregues.push(options.data);
      return real.useReactTable({
        ...options,
        data: (options.data.length === 0 ? vazio : options.data) as typeof options.data,
      });
    },
  };
});

const usuario = {
  id: 'u1',
  name: 'Pessoa Fictícia',
  email: 'pessoa@teste.test',
  activeMembership: { membershipId: 'm1', workspaceId: 'w1', workspaceName: 'Teste' },
  permissions: ['contacts:read'],
  memberships: [],
};

beforeEach(() => {
  entregues.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

it('enquanto a lista carrega, a tabela recebe sempre o MESMO vazio — digitar na busca não muda a referência', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/me') return new Response(JSON.stringify(usuario), { status: 200 });
      // a lista de contatos nunca responde neste teste
      if (url.startsWith('/api/contacts')) return new Promise<Response>(() => undefined);
      return new Response('[]', { status: 200 });
    }),
  );
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/contacts']}>
        <ContactsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const busca = await screen.findByLabelText('Buscar contatos');
  for (const termo of ['A', 'An', 'Ana']) fireEvent.change(busca, { target: { value: termo } });
  expect(busca).toHaveValue('Ana');
  expect(entregues.length).toBeGreaterThan(3);
  expect(new Set(entregues).size).toBe(1);
});

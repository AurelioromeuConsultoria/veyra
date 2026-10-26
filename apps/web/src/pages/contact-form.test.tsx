import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContactDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ContactForm } from './Contacts';

/**
 * O formulário de contato edita o PRIMEIRO telefone e o PRIMEIRO e-mail, e os
 * outros ficam (revisão da F4.1a). Antes, salvar apagava o segundo número — e,
 * com a identidade de telefone (ADR-052), mudava para onde vão as mensagens
 * dele. Dados FICTÍCIOS.
 */
const CONTATO: ContactDto = {
  id: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e41',
  name: 'Ana Fictícia',
  emails: ['ana@ficticia.test', 'ana2@ficticia.test'],
  phones: ['+55 11 98765-4321', '+55 11 91234-5678'],
  status: 'active',
  companyId: null,
  companyName: null,
  ownerMembershipId: null,
  ownerName: null,
  source: null,
  tags: [],
  customFields: {},
  createdAt: '2030-11-04T12:00:00.000Z',
  updatedAt: '2030-11-04T12:00:00.000Z',
};

function corpos() {
  const enviados: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (corpo: unknown) =>
        new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      if (init?.method === 'PATCH') {
        enviados.push(JSON.parse(String(init.body)));
        return json(CONTATO);
      }
      // a timeline do contato, que o formulário também mostra
      if (url.startsWith('/api/activities')) return json({ items: [], nextCursor: null });
      return json([]);
    }),
  );
  return enviados;
}

function renderizar() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContactForm
        contact={CONTATO}
        tags={[]}
        companies={[]}
        members={[]}
        fieldDefs={[]}
        canWrite
        onDone={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

it('editar só o nome não manda telefone nem e-mail: nenhum número muda', async () => {
  const enviados = corpos();
  renderizar();
  expect(screen.getByText(/mais 1 telefone e mais 1 e-mail no cadastro/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Ana Fictícia Silva' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(enviados).toHaveLength(1));
  expect(enviados[0]).toMatchObject({ name: 'Ana Fictícia Silva' });
  expect(enviados[0]).not.toHaveProperty('phones');
  expect(enviados[0]).not.toHaveProperty('emails');
});

it('trocar o primeiro telefone mantém o segundo', async () => {
  const enviados = corpos();
  renderizar();
  fireEvent.change(screen.getByLabelText('Telefone'), { target: { value: '+55 21 99999-0000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(enviados).toHaveLength(1));
  expect(enviados[0]).toMatchObject({ phones: ['+55 21 99999-0000', '+55 11 91234-5678'] });
  expect(enviados[0]).not.toHaveProperty('emails');
});

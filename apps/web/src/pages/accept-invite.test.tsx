import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { criarQueryClient } from '../lib/session-query';
import { AcceptInvitePage } from './AcceptInvite';

/**
 * O aceite do convite (ADR-054 item 4). Dados FICTÍCIOS. O que se prova: o
 * token sai do fragmento e do endereço antes de qualquer requisição; cada forma
 * manda só o que a rota existente pede; a mensagem do servidor aparece como
 * veio; sem token, a página não fica parada.
 */

const TOKEN = 'token-ficticio-0123456789-0123456789-0123';
type Chamada = { chave: string; corpo?: unknown };

function mockApi(aceite: { status: number; body: unknown }) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      chamadas.push({ chave, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r =
        chave === 'POST /api/invites/accept'
          ? aceite
          : chave === 'GET /api/auth/me'
            ? { status: 401, body: { message: 'sem sessão' } }
            : { status: 404, body: {} };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

function renderizar() {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/convite']}>
        <Routes>
          <Route path="/convite" element={<AcceptInvitePage />} />
          <Route path="/login" element={<p>tela de login</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => window.history.replaceState(null, '', `/convite#${TOKEN}`));
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('o token sai do endereço logo depois do primeiro render', async () => {
  mockApi({ status: 400, body: {} });
  renderizar();
  await screen.findByRole('heading', { name: 'Aceitar o convite' });
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(window.location.href).not.toContain(TOKEN);
});

it('conta nova manda token, nome e senha', async () => {
  const chamadas = mockApi({ status: 400, body: { message: 'Convite inválido ou expirado' } });
  renderizar();
  fireEvent.change(await screen.findByLabelText('Seu nome'), {
    target: { value: 'Recepção Fictícia' },
  });
  fireEvent.change(screen.getByLabelText(/^Crie uma senha/), {
    target: { value: 'senha-forte-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Aceitar e entrar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Convite inválido ou expirado');
  expect(chamadas.find((c) => c.chave === 'POST /api/invites/accept')?.corpo).toEqual({
    token: TOKEN,
    name: 'Recepção Fictícia',
    password: 'senha-forte-1',
  });
});

it('conta existente manda só token e senha', async () => {
  const chamadas = mockApi({ status: 400, body: { message: 'Convite inválido ou expirado' } });
  renderizar();
  fireEvent.click(await screen.findByLabelText('Já tenho conta com o e-mail do convite'));
  expect(screen.queryByLabelText('Seu nome')).toBeNull();
  fireEvent.change(screen.getByLabelText(/^Senha da sua conta/), {
    target: { value: 'senha-da-conta-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Aceitar e entrar' }));
  await screen.findByRole('alert');
  expect(chamadas.find((c) => c.chave === 'POST /api/invites/accept')?.corpo).toEqual({
    token: TOKEN,
    password: 'senha-da-conta-1',
  });
});

it('senha curta não chega ao servidor', async () => {
  const chamadas = mockApi({ status: 400, body: {} });
  renderizar();
  fireEvent.change(await screen.findByLabelText('Seu nome'), { target: { value: 'Nome' } });
  fireEvent.change(screen.getByLabelText(/^Crie uma senha/), { target: { value: 'curta' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aceitar e entrar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('pelo menos 8 caracteres');
  expect(chamadas.some((c) => c.chave === 'POST /api/invites/accept')).toBe(false);
});

it('link sem token leva ao login, sem sessão', async () => {
  window.history.replaceState(null, '', '/convite');
  mockApi({ status: 400, body: {} });
  renderizar();
  expect(await screen.findByText('tela de login')).toBeInTheDocument();
});

it('token malformado avisa que o link está incompleto e não oferece o formulário', async () => {
  window.history.replaceState(null, '', '/convite#curto');
  mockApi({ status: 400, body: {} });
  renderizar();
  expect(await screen.findByRole('alert')).toHaveTextContent('link de convite está incompleto');
  expect(screen.queryByRole('button', { name: 'Aceitar e entrar' })).toBeNull();
});

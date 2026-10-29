import { QueryClientProvider } from '@tanstack/react-query';
import type { TemplateOptionDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { ME_KEY } from '../lib/session';
import { criarQueryClient } from '../lib/session-query';
import { TemplatePanel } from './InboxTemplate';

/**
 * O template com a janela fechada (F4.1c-3). Dados FICTÍCIOS. O que se prova:
 * a tela só oferece as opções do servidor e devolve o ALVO que veio delas; o
 * texto aprovado é o da prévia; a aprovação leva o hash e o prazo da prévia,
 * com a MESMA chave de idempotência na repetição; e a recusa aparece pelo
 * motivo, sem nada atualizado em silêncio.
 */

const CONVERSA = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e41';
const OPCAO: TemplateOptionDto = {
  target: {
    originRef: `conversation:${CONVERSA}`,
    channelId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e42',
    contactId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e43',
    number: '+5511988887777',
    templateVersionId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e44',
    purposeId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e45',
  },
  templateVersionId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e44',
  name: 'lembrete_horario',
  language: 'pt_BR',
  version: 1,
  category: 'utility',
  purposeId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e45',
  purposeKey: 'lembrete',
  purposeVersion: 1,
  purposeDescription: 'Lembretes de horário marcado',
};
const PREVIA = {
  index: 0,
  ok: true,
  text: 'Ola Ana Ficticia, seu horario esta confirmado.\n\nClinica Ficticia',
  values: { 'body.1': 'Ana Ficticia' },
  expiresAt: '2030-11-04T13:00:00.000Z',
  approvalHash: 'a'.repeat(64),
};

type Resposta = { status?: number; body?: unknown };

function mockApi(rotas: Record<string, Resposta | Resposta[]>) {
  const chamadas: { chave: string; corpo?: unknown; idempotencia: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      const cabecalhos = (init?.headers ?? {}) as Record<string, string>;
      chamadas.push({
        chave,
        corpo: init?.body ? JSON.parse(String(init.body)) : undefined,
        idempotencia: cabecalhos['Idempotency-Key'] ?? null,
      });
      const rota = rotas[chave];
      const resposta = (Array.isArray(rota) ? rota.shift() : rota) ?? {
        status: 404,
        body: { message: `sem mock: ${chave}` },
      };
      return new Response(JSON.stringify(resposta.body ?? {}), {
        status: resposta.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

function renderizar(podeVer = true, onSent = vi.fn()) {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <TemplatePanel conversationId={CONVERSA} podeVer={podeVer} onSent={onSent} />
    </QueryClientProvider>,
  );
  return onSent;
}

const OPCOES = `GET /api/business-outbound/options?conversationId=${CONVERSA}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('o template com a janela fechada', () => {
  it('a prévia é do alvo que o servidor deu; a aprovação que falhou na rede repete com a MESMA chave', async () => {
    const chamadas = mockApi({
      [OPCOES]: { body: [OPCAO] },
      'POST /api/business-outbound/preview': { body: { items: [PREVIA] } },
      'POST /api/business-outbound': [
        // a rede caiu na primeira: a repetição é da MESMA prévia
        { status: 503, body: { message: 'Serviço indisponível' } },
        { body: { items: [{ index: 0, state: 'approved', messageId: 'm1', reason: null }] } },
      ],
    });
    const onSent = renderizar();
    // a opção precisa ter chegado: ninguém escolhe o que ainda não está na lista
    await screen.findByRole('option', { name: /lembrete_horario/ });
    fireEvent.change(screen.getByLabelText('Template revisado'), {
      target: { value: `${OPCAO.templateVersionId}:${OPCAO.purposeId}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver prévia' }));
    expect(await screen.findByTestId('template-preview')).toHaveTextContent(
      'Ola Ana Ficticia, seu horario esta confirmado.',
    );
    expect(
      chamadas.find((c) => c.chave.startsWith('POST /api/business-outbound/preview'))?.corpo,
    ).toEqual({ items: [OPCAO.target] });

    fireEvent.click(screen.getByRole('button', { name: 'Aprovar e enviar' }));
    expect(await screen.findByText(/O resultado da aprovação não chegou/)).toBeInTheDocument();
    // o desfecho é incerto: nada de prévia nova (outro hash, outra chave), só repetir
    expect(screen.getByRole('button', { name: 'Ver prévia' })).toBeDisabled();
    expect(screen.getByLabelText('Template revisado')).toBeDisabled();
    // o incerto recarregou a conversa, para a pessoa ver se saiu
    expect(onSent).toHaveBeenCalledTimes(1);
    // a mesma prévia continua na tela: aprovar de novo usa a MESMA chave
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar e enviar' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
    const aprovacoes = chamadas.filter((c) => c.chave === 'POST /api/business-outbound');
    expect(aprovacoes).toHaveLength(2);
    expect(aprovacoes[0].idempotencia).toMatch(/^[0-9a-f-]{36}$/);
    expect(aprovacoes[1].idempotencia).toBe(aprovacoes[0].idempotencia);
  });

  it('aprovar leva o alvo, o hash e o prazo da prévia; o aprovado avisa e chama o recarregamento', async () => {
    const chamadas = mockApi({
      [OPCOES]: { body: [OPCAO] },
      'POST /api/business-outbound/preview': { body: { items: [PREVIA] } },
      'POST /api/business-outbound': {
        body: { items: [{ index: 0, state: 'approved', messageId: 'm1', reason: null }] },
      },
    });
    const onSent = renderizar();
    // a opção precisa ter chegado: ninguém escolhe o que ainda não está na lista
    await screen.findByRole('option', { name: /lembrete_horario/ });
    fireEvent.change(screen.getByLabelText('Template revisado'), {
      target: { value: `${OPCAO.templateVersionId}:${OPCAO.purposeId}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver prévia' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar e enviar' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    const aprovacao = chamadas.find((c) => c.chave === 'POST /api/business-outbound');
    expect(aprovacao?.corpo).toEqual({
      items: [{ ...OPCAO.target, expiresAt: PREVIA.expiresAt, approvalHash: PREVIA.approvalHash }],
    });
    expect(aprovacao?.idempotencia).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole('status')).toHaveTextContent(/Aprovado/);
  });

  it('a recusa aparece pelo motivo, e nada é enviado; sem opção, a tela diz por quê', async () => {
    mockApi({
      [OPCOES]: { body: [OPCAO] },
      'POST /api/business-outbound/preview': { body: { items: [PREVIA] } },
      'POST /api/business-outbound': {
        body: {
          items: [{ index: 0, state: 'refused', messageId: null, reason: 'approval_stale' }],
        },
      },
    });
    const onSent = renderizar();
    // a opção precisa ter chegado: ninguém escolhe o que ainda não está na lista
    await screen.findByRole('option', { name: /lembrete_horario/ });
    fireEvent.change(screen.getByLabelText('Template revisado'), {
      target: { value: `${OPCAO.templateVersionId}:${OPCAO.purposeId}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver prévia' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar e enviar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/algo mudou desde a prévia/);
    expect(onSent).not.toHaveBeenCalled();
    expect(screen.queryByTestId('template-preview')).toBeNull();
  });

  it('sem opções revisadas e consentidas, explica; sem ver contatos e consentimentos, nem consulta', async () => {
    const chamadas = mockApi({ [OPCOES]: { body: [] } });
    renderizar();
    expect(
      await screen.findByText(/Nenhum template revisado para uma finalidade/),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
    const outras = mockApi({});
    renderizar(false);
    expect(screen.getAllByText(/a prévia exige ver o contato/).length).toBeGreaterThan(0);
    // nenhuma consulta de dados: só a sessão, que na aplicação já está no cache
    expect(outras.filter((c) => c.chave !== 'GET /api/auth/me')).toEqual([]);
    // as opções uma vez (a sessão é do aviso do envio simulado, F4.4)
    expect(chamadas.filter((c) => c.chave === OPCOES)).toHaveLength(1);
    expect(chamadas.every((c) => c.chave.startsWith('GET '))).toBe(true);
  });

  it('sem escrever nas conversas, o transporte nem é consultado (F4.4)', async () => {
    const chamadas = mockApi({ [OPCOES]: { body: [] } });
    const client = criarQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    client.setQueryData(ME_KEY, {
      id: 'u1',
      name: 'Pessoa Fictícia',
      email: 'pessoa@clinica.test',
      activeMembership: { membershipId: 'm1' },
      permissions: ['contacts:read', 'consents:read'],
      memberships: [],
    });
    render(
      <QueryClientProvider client={client}>
        <TemplatePanel conversationId={CONVERSA} podeVer onSent={vi.fn()} />
      </QueryClientProvider>,
    );
    await screen.findByText(/Nenhum template revisado para uma finalidade/);
    expect(chamadas.some((c) => c.chave.includes('/transport'))).toBe(false);
    expect(screen.queryByTestId('envio-simulado')).toBeNull();
  });

  it('o transporte falso aparece como envio simulado no composer (F4.4)', async () => {
    mockApi({
      [OPCOES]: { body: [] },
      'GET /api/business-outbound/transport': { body: { simulated: true } },
    });
    const client = criarQueryClient();
    client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
    client.setQueryData(ME_KEY, {
      id: 'u1',
      name: 'Pessoa Fictícia',
      email: 'pessoa@clinica.test',
      activeMembership: { membershipId: 'm1' },
      permissions: ['conversations:write', 'contacts:read', 'consents:read'],
      memberships: [],
    });
    render(
      <QueryClientProvider client={client}>
        <TemplatePanel conversationId={CONVERSA} podeVer onSent={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId('envio-simulado')).toHaveTextContent(
      'entrega e resposta não são confirmadas pelo provedor',
    );
  });

  it('a recusa TRANSITÓRIA mantém a mesma prévia, com chave nova; a definitiva pede outra prévia', async () => {
    const chamadas = mockApi({
      [OPCOES]: { body: [OPCAO] },
      'POST /api/business-outbound/preview': { body: { items: [PREVIA] } },
      'POST /api/business-outbound': [
        { body: { items: [{ index: 0, state: 'refused', messageId: null, reason: 'busy' }] } },
        { body: { items: [{ index: 0, state: 'approved', messageId: 'm1', reason: null }] } },
      ],
    });
    const onSent = renderizar();
    await screen.findByRole('option', { name: /lembrete_horario/ });
    fireEvent.change(screen.getByLabelText('Template revisado'), {
      target: { value: `${OPCAO.templateVersionId}:${OPCAO.purposeId}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver prévia' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aprovar e enviar' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/mudança deste contato/);
    // a prévia continua: a mesma, com o mesmo hash
    expect(screen.getByTestId('template-preview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar e enviar' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    const aprovacoes = chamadas.filter((c) => c.chave === 'POST /api/business-outbound');
    expect(aprovacoes).toHaveLength(2);
    expect(aprovacoes[1].corpo).toEqual(aprovacoes[0].corpo);
    expect(aprovacoes[1].idempotencia).not.toBe(aprovacoes[0].idempotencia);
  });
});

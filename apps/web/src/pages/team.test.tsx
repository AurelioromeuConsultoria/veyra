import { QueryClientProvider } from '@tanstack/react-query';
import type { InviteDto, MemberDto, RoleDto } from '@veyra/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { useSession } from '../lib/session';
import { criarQueryClient } from '../lib/session-query';
import { TeamPage, administra, diferenca, linkDoConvite } from './Team';

/**
 * A tela de equipe (ADR-054, F5.1a). Dados FICTÍCIOS. O que se prova: a tela
 * oferece só os papéis que a pessoa administra, pela comparação de permissões;
 * a própria linha e a de papel acima não têm ações; o efeito aparece antes da
 * confirmação; o link do convite leva o token no fragmento e aparece uma vez;
 * quem só lê não vê ações nem consulta convites.
 */

type Resposta = { status?: number; body?: unknown };
type Chamada = { chave: string; corpo?: unknown };

function mockApi(rotas: Record<string, Resposta>) {
  const chamadas: Chamada[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const chave = `${init?.method ?? 'GET'} ${url}`;
      chamadas.push({ chave, corpo: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = rotas[chave] ?? { status: 404, body: { message: `sem mock: ${chave}` } };
      return new Response(JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

const DESC: Record<string, string> = {
  'members:read': 'Ver membros e equipes',
  'members:manage': 'Convidar, remover e alterar membros e equipes',
  'contacts:read': 'Ver contatos e empresas',
  'billing:manage': 'Gerir plano, assinatura e limites',
};
const papel = (id: string, name: string, permissions: string[]): RoleDto => ({
  id,
  name,
  description: null,
  isSystem: true,
  permissions,
  permissionDescriptions: Object.fromEntries(permissions.map((p) => [p, DESC[p]])),
});
const OWNER = papel('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f01', 'Owner', [
  'members:read',
  'members:manage',
  'contacts:read',
  'billing:manage',
]);
const ADMIN = papel('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f02', 'Admin', [
  'members:read',
  'members:manage',
  'contacts:read',
]);
const MEMBRO = papel('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f03', 'Member', [
  'members:read',
  'contacts:read',
]);
const CONVIDADO = papel('0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f04', 'Guest', ['contacts:read']);
const PAPEIS = [OWNER, ADMIN, MEMBRO, CONVIDADO];

const membro = (id: string, name: string, r: RoleDto): MemberDto => ({
  membershipId: id,
  userId: `u-${id}`,
  name,
  email: `${id}@clinica.test`,
  roleId: r.id,
  roleName: r.name,
  status: 'active',
  createdAt: '2030-11-01T12:00:00.000Z',
});
const EU = membro('m1', 'Pessoa Fictícia', ADMIN);
const DONA = membro('m2', 'Dona Fictícia', OWNER);
const CARLA = membro('m3', 'Carla Fictícia', MEMBRO);

const convite = (id: string, email: string, r: RoleDto, expiresAt: string): InviteDto => ({
  id,
  email,
  roleId: r.id,
  roleName: r.name,
  expiresAt,
  acceptedAt: null,
  createdAt: '2030-11-01T12:00:00.000Z',
  createdByMembershipId: 'm2',
  issuedByProvisioning: false,
});

const usuario = (permissions: string[]) => ({
  id: 'u1',
  name: 'Pessoa Fictícia',
  email: 'm1@clinica.test',
  activeMembership: {
    membershipId: 'm1',
    workspaceId: 'w1',
    workspaceName: 'Clínica Fictícia',
    workspaceSlug: 'clinica',
    roleName: 'Admin',
    status: 'active',
  },
  permissions,
  memberships: [],
});

const rotas = (permissoes: string[]): Record<string, Resposta> => ({
  'GET /api/auth/me': { body: usuario(permissoes) },
  'GET /api/members': { body: [EU, DONA, CARLA] },
  'GET /api/roles': { body: PAPEIS },
  'GET /api/invites': {
    body: [
      convite('i1', 'nova@clinica.test', MEMBRO, '2999-01-01T12:00:00.000Z'),
      convite('i2', 'socia@clinica.test', OWNER, '2000-01-01T12:00:00.000Z'),
    ],
  },
});

function SessaoCarregada() {
  const { data } = useSession();
  return data ? <span data-testid="sessao-carregada" hidden /> : null;
}

function renderizar() {
  const client = criarQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessaoCarregada />
        <TeamPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const linha = async (nome: string) => (await screen.findByText(nome)).closest('tr') as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('regras puras da tela', () => {
  it('administra = as permissões do papel cabem nas de quem opera', () => {
    expect(administra(ADMIN.permissions, MEMBRO)).toBe(true);
    expect(administra(ADMIN.permissions, ADMIN)).toBe(true);
    expect(administra(ADMIN.permissions, OWNER)).toBe(false);
    expect(administra([], CONVIDADO)).toBe(false);
  });

  it('diferenca lista o que se ganha e o que se perde, pelas descrições', () => {
    expect(diferenca(MEMBRO, CONVIDADO)).toEqual({ ganha: [], perde: ['Ver membros e equipes'] });
    expect(diferenca(CONVIDADO, MEMBRO)).toEqual({ ganha: ['Ver membros e equipes'], perde: [] });
  });

  it('o link do convite leva o token no fragmento, nunca na query string', () => {
    const link = linkDoConvite('tok-ficticio', 'https://veyra.test');
    expect(link).toBe('https://veyra.test/convite#tok-ficticio');
    expect(new URL(link).search).toBe('');
  });
});

describe('quem administra a equipe', () => {
  const ADMIN_PERMS = ADMIN.permissions;

  it('a própria linha e a de papel acima não têm ações; a de papel abaixo tem', async () => {
    mockApi(rotas(ADMIN_PERMS));
    renderizar();
    const eu = await linha('Pessoa Fictícia');
    expect(within(eu).getByText('(você)')).toBeInTheDocument();
    expect(within(eu).queryByRole('button')).toBeNull();
    expect(within(eu).getByText('Seu acesso é alterado por outra pessoa')).toBeInTheDocument();

    const dona = await linha('Dona Fictícia');
    expect(within(dona).queryByRole('button')).toBeNull();
    expect(within(dona).getByText('Papel acima das suas permissões')).toBeInTheDocument();

    const carla = await linha('Carla Fictícia');
    expect(within(carla).getByRole('button', { name: 'Trocar o papel de Carla Fictícia' }));
    expect(
      within(carla).getByRole('button', {
        name: 'Remover o acesso de Carla Fictícia ao workspace',
      }),
    );
  });

  it('o convite oferece só os papéis que a pessoa administra', async () => {
    mockApi(rotas(ADMIN_PERMS));
    renderizar();
    const select = await screen.findByLabelText('Papel do convite');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(4));
    const nomes = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(nomes).toEqual(['Escolha o papel…', 'Admin', 'Member', 'Guest']);
  });

  it('trocar papel mostra o que muda antes de confirmar e manda só o papel escolhido', async () => {
    const chamadas = mockApi({
      ...rotas(ADMIN_PERMS),
      'PATCH /api/members/m3/role': { body: { ok: true } },
    });
    renderizar();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Trocar o papel de Carla Fictícia' }),
    );
    const novo = await screen.findByLabelText('Novo papel');
    // o papel atual não é oferecido, e o de cima também não
    const nomes = within(novo)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(nomes).toEqual(['Escolha o papel…', 'Admin', 'Guest']);
    expect(screen.getByRole('button', { name: 'Confirmar a troca' })).toBeDisabled();

    fireEvent.change(novo, { target: { value: CONVIDADO.id } });
    const efeito = screen.getByTestId('efeito-da-troca');
    expect(within(efeito).getByText('Deixa de poder')).toBeInTheDocument();
    expect(within(efeito).getByText('Ver membros e equipes')).toBeInTheDocument();
    expect(efeito).toHaveTextContent(
      'Na próxima ação de Carla Fictícia, o acesso emitido com o papel antigo deixa de valer',
    );
    expect(efeito).toHaveTextContent('que o novo papel não autoriza são revogados junto');

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar a troca' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Carla Fictícia agora tem o papel Guest. O acesso emitido com o papel anterior deixou de valer.',
    );
    const patch = chamadas.filter((c) => c.chave === 'PATCH /api/members/m3/role');
    expect(patch).toEqual([
      {
        chave: 'PATCH /api/members/m3/role',
        corpo: { roleId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f04' },
      },
    ]);
  });

  it('a recusa do servidor aparece como veio, e nada é dado como feito', async () => {
    // o ator foi rebaixado noutra aba: a tela ainda oferece, o servidor recusa
    mockApi({
      ...rotas(ADMIN_PERMS),
      'DELETE /api/members/m3': {
        status: 403,
        body: { message: 'Ação exige permissões que você não possui' },
      },
    });
    renderizar();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remover o acesso de Carla Fictícia ao workspace',
      }),
    );
    const efeito = screen.getByTestId('efeito-da-remocao');
    expect(efeito).toHaveTextContent(
      'O acesso acaba na próxima requisição dessa pessoa, inclusive nas sessões já abertas.',
    );
    // remover o acesso não é suspender nem excluir a conta
    expect(efeito).toHaveTextContent('A conta da pessoa no Veyra não é excluída');
    expect(efeito).toHaveTextContent('e os que ela emitiu, são revogados junto');
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Remover acesso ao workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar a remoção do acesso' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ação exige permissões que você não possui',
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('o convite criado mostra o link uma vez, com o token no fragmento', async () => {
    const chamadas = mockApi({
      ...rotas(ADMIN_PERMS),
      'POST /api/invites': {
        status: 201,
        body: {
          ...convite('i3', 'recepcao@clinica.test', MEMBRO, '2999-01-01T12:00:00.000Z'),
          token: 'token-ficticio-0123456789-0123456789-0123',
        },
      },
    });
    renderizar();
    fireEvent.change(await screen.findByLabelText('E-mail do convite'), {
      target: { value: 'recepcao@clinica.test' },
    });
    const select = screen.getByLabelText('Papel do convite');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(4));
    fireEvent.change(select, { target: { value: MEMBRO.id } });
    fireEvent.click(screen.getByRole('button', { name: /Criar convite/ }));

    const painel = await screen.findByTestId('link-do-convite');
    expect(painel).toHaveTextContent(
      `${window.location.origin}/convite#token-ficticio-0123456789-0123456789-0123`,
    );
    expect(painel).toHaveTextContent('O Veyra não envia o convite.');
    expect(chamadas.find((c) => c.chave === 'POST /api/invites')?.corpo).toEqual({
      email: 'recepcao@clinica.test',
      roleId: '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5f03',
    });

    fireEvent.click(within(painel).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByTestId('link-do-convite')).toBeNull();
    expect(document.body.textContent).not.toContain('token-ficticio');
  });

  it('não convida quem já é membro: nem chega ao servidor', async () => {
    const chamadas = mockApi(rotas(ADMIN_PERMS));
    renderizar();
    await screen.findByText('Carla Fictícia');
    fireEvent.change(screen.getByLabelText('E-mail do convite'), {
      target: { value: 'M3@clinica.test' },
    });
    const select = screen.getByLabelText('Papel do convite');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(4));
    fireEvent.change(select, { target: { value: MEMBRO.id } });
    fireEvent.click(screen.getByRole('button', { name: /Criar convite/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('já é membro deste workspace');
    expect(chamadas.some((c) => c.chave === 'POST /api/invites')).toBe(false);
  });

  it('convites: o de papel acima não se revoga; o outro mostra o efeito e revoga', async () => {
    const chamadas = mockApi({
      ...rotas(ADMIN_PERMS),
      'DELETE /api/invites/i1': { body: { ok: true } },
    });
    renderizar();
    const socia = await linha('socia@clinica.test');
    expect(within(socia).getByText(/Expirou em/)).toBeInTheDocument();
    expect(within(socia).queryByRole('button')).toBeNull();

    const nova = await linha('nova@clinica.test');
    expect(within(nova).getByText(/Aguardando aceite até/)).toBeInTheDocument();
    // quem convidou aparece pelo nome do membro
    expect(within(nova).getByText('Dona Fictícia')).toBeInTheDocument();
    fireEvent.click(
      within(nova).getByRole('button', { name: 'Revogar o convite de nova@clinica.test' }),
    );
    expect(await screen.findByText('O link enviado deixa de funcionar.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar a revogação' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'O convite de nova@clinica.test foi revogado.',
    );
    expect(chamadas.filter((c) => c.chave === 'DELETE /api/invites/i1')).toHaveLength(1);
  });
});

describe('sem os papéis', () => {
  it('a falha dos papéis aparece e nenhuma linha diz "acima das suas permissões"', async () => {
    mockApi({
      ...rotas(ADMIN.permissions),
      'GET /api/roles': { status: 500, body: { message: 'Falha temporária' } },
    });
    renderizar();
    const carla = await linha('Carla Fictícia');
    expect(await screen.findByText(/Sem eles, nenhuma ação é oferecida/)).toBeInTheDocument();
    expect(within(carla).queryByRole('button')).toBeNull();
    expect(screen.queryByText('Papel acima das suas permissões')).toBeNull();
  });
});

describe('quem só lê a equipe', () => {
  it('vê membros e papéis, sem ações, sem convite e sem consultar convites', async () => {
    const chamadas = mockApi(rotas(['members:read', 'contacts:read']));
    renderizar();
    await screen.findByTestId('sessao-carregada');
    const carla = await linha('Carla Fictícia');
    expect(within(carla).queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('E-mail do convite')).toBeNull();
    expect(screen.queryByText('Convites em aberto')).toBeNull();
    expect(screen.getByText('Papéis e permissões')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(chamadas.some((c) => c.chave === 'GET /api/invites')).toBe(false);
  });
});

import { INestApplication } from '@nestjs/common';
import { SESSION_ISSUED_HEADER } from '@veyra/contracts';
// o default é o objeto REAL do módulo (o `import *` do esModuleInterop é uma
// cópia, e o espião não veria as chamadas do serviço)
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { preFiltroDoEmail } from './mesmo-email';
import { ProvisioningService } from './provisioning.service';
import { createTestApp } from '../../test/integration/app';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import { esperarBloqueadosPor } from '../../test/integration/locks';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

describe('Invites — emissão, revogação e aceite transacional (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let workspaceId: string;
  let roles: Record<string, string>;

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const fixture = await createWorkspaceFixture(prisma, 'acme');
    workspaceId = fixture.workspaceId;
    roles = fixture.roles;
    const ownerId = await createUserFixture(prisma, 'owner@veyra.test');
    await createMembershipFixture(prisma, workspaceId, ownerId, roles.owner);
  });

  async function loginAs(email: string) {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    const csrf = /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
    return { cookieHeader, csrf };
  }

  async function createInvite(email: string, roleId: string): Promise<string> {
    const session = await loginAs('owner@veyra.test');
    const res = await request(http)
      .post('/api/invites')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ email, roleId })
      .expect(201);
    return res.body.token;
  }

  function accept(body: Record<string, unknown>) {
    return request(http).post('/api/invites/accept').set('Origin', ORIGIN).send(body);
  }

  it('cria convite: token retorna UMA vez; banco e listagem só têm o hash/metadados', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    expect(token.length).toBeGreaterThan(32);
    const row = await prisma.raw.invite.findFirst({ where: { email: 'nova@veyra.test' } });
    expect(row?.tokenHash).not.toBe(token);

    const session = await loginAs('owner@veyra.test');
    const list = await request(http)
      .get('/api/invites')
      .set('Cookie', session.cookieHeader)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token);
  });

  it('convite não escala privilégio: admin não convida Owner (ajuste #6)', async () => {
    const adminId = await createUserFixture(prisma, 'admin@veyra.test');
    await createMembershipFixture(prisma, workspaceId, adminId, roles.admin);
    const session = await loginAs('admin@veyra.test');
    await request(http)
      .post('/api/invites')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ email: 'x@veyra.test', roleId: roles.owner })
      .expect(403);
  });

  it('aceite com e-mail novo cria conta + membership e emite sessão (auto-login)', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    const res = await accept({ token, name: 'Nova Pessoa', password: 'senha-forte-123' }).expect(
      201,
    );
    expect(res.body.email).toBe('nova@veyra.test');
    expect(res.body.activeMembership.workspaceId).toBe(workspaceId);
    expect(res.body.activeMembership.roleName).toBe('Member');
    // a resposta marca que emitiu sessão: o web troca de sessão por ela (ADR-050)
    expect(res.headers[SESSION_ISSUED_HEADER]).toBe('1');
    // sessão emitida no aceite funciona
    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    await request(http).get('/api/auth/me').set('Cookie', cookieHeader).expect(200);
  });

  it('aceite com conta existente EXIGE a senha da conta (P0: token não basta)', async () => {
    await createUserFixture(prisma, 'ja-existe@veyra.test'); // senha = TEST_PASSWORD
    const token = await createInvite('ja-existe@veyra.test', roles.guest);
    // token sozinho não autentica
    await accept({ token }).expect(400);
    // senha errada = mensagem genérica de convite inválido
    await accept({ token, password: 'senha-errada-999' }).expect(400);
    // senha correta vincula a membership
    const res = await accept({ token, password: TEST_PASSWORD }).expect(201);
    expect(res.body.activeMembership.roleName).toBe('Guest');
  });

  it('P0: quem cria o convite NÃO assume a conta de um usuário existente de outro workspace', async () => {
    // vítima é Owner do workspace beta
    const beta = await createWorkspaceFixture(prisma, 'beta');
    const victimId = await createUserFixture(prisma, 'victima@veyra.test');
    await createMembershipFixture(prisma, beta.workspaceId, victimId, beta.roles.owner);

    // owner do acme convida o e-mail da vítima como Guest e pega o token
    const token = await createInvite('victima@veyra.test', roles.guest);
    // sem a senha da vítima, o aceite falha — nada de takeover nem pivô cross-tenant
    await accept({ token }).expect(400);
    await accept({ token, name: 'X', password: 'chute-qualquer-123' }).expect(400);
  });

  it('e-mail novo sem nome/senha: a MESMA mensagem, SEM queimar o convite (ADR-054 item 4)', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    const res = await accept({ token, password: 'senha-qualquer-1' }).expect(400);
    // a resposta não separa "o e-mail não tem conta" de "senha errada"
    expect(res.body.message).toBe('Convite inválido ou expirado');
    // convite continua válido
    await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(201);
  });

  it('mensagem ÚNICA para token inválido, expirado ou reutilizado (ajuste #4)', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(201);
    const reused = await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);

    const invalid = await accept({
      token: 'token-completamente-invalido-mas-longo-o-suficiente',
      name: 'X',
      password: 'senha-forte-123',
    }).expect(400);

    const expiredToken = await createInvite('expirada@veyra.test', roles.member);
    await prisma.raw.invite.updateMany({
      where: { email: 'expirada@veyra.test' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await accept({
      token: expiredToken,
      name: 'X',
      password: 'senha-forte-123',
    }).expect(400);

    expect(new Set([reused.body.message, invalid.body.message, expired.body.message]).size).toBe(1);
  });

  it('quem virou membro depois do convite recebe a MESMA mensagem genérica, e o papel não muda', async () => {
    // a criação já recusa convite para membro (ADR-054 item 10); o aceite segue
    // protegido para quem entrou por outro caminho com o convite em aberto
    const memberId = await createUserFixture(prisma, 'membro@veyra.test');
    const token = await createInvite('membro@veyra.test', roles.admin);
    const membership = await createMembershipFixture(prisma, workspaceId, memberId, roles.member);
    const res = await accept({ token, password: TEST_PASSWORD }).expect(400);
    expect(res.body.message).toBe('Convite inválido ou expirado');
    const depois = await prisma.raw.membership.findFirst({ where: { id: membership } });
    expect(depois?.roleId).toBe(roles.member);
  });

  it('ex-membro (removed) reconvidado é reativado com o papel do convite', async () => {
    const exId = await createUserFixture(prisma, 'ex@veyra.test');
    const exMembership = await createMembershipFixture(prisma, workspaceId, exId, roles.member);
    await prisma.raw.membership.update({
      where: { id: exMembership },
      data: { status: 'removed', tokenVersion: { increment: 1 } },
    });
    const token = await createInvite('ex@veyra.test', roles.guest);
    // ex-membro tem conta → aceite exige a senha (P0)
    const res = await accept({ token, password: TEST_PASSWORD }).expect(201);
    expect(res.body.activeMembership.roleName).toBe('Guest');
    const reactivated = await prisma.raw.membership.findFirst({ where: { id: exMembership } });
    expect(reactivated?.status).toBe('active');
    expect(reactivated?.roleId).toBe(roles.guest);
  });

  it('convite revogado não pode ser aceito', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    const session = await loginAs('owner@veyra.test');
    const list = await request(http)
      .get('/api/invites')
      .set('Cookie', session.cookieHeader)
      .expect(200);
    await request(http)
      .delete(`/api/invites/${list.body[0].id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(200);
    await accept({ token, name: 'X', password: 'senha-forte-123' }).expect(400);
  });

  // ── ADR-054: auditoria dos convites e a regra da revogação ─────────────────

  async function trilha(action: string) {
    return prisma.raw.auditLog.findMany({ where: { workspaceId, action } });
  }

  it('criar e revogar convite ficam na trilha com e-mail e papel — nunca o token nem o hash', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    const row = await prisma.raw.invite.findFirst({ where: { email: 'nova@veyra.test' } });
    const criados = await trilha('invite.created');
    expect(criados).toHaveLength(1);
    expect(criados[0]).toMatchObject({
      entityType: 'invite',
      entityId: row?.id,
      actorType: 'user',
      after: { email: 'nova@veyra.test', roleId: roles.member },
    });

    const session = await loginAs('owner@veyra.test');
    await request(http)
      .delete(`/api/invites/${row?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(200);
    const revogados = await trilha('invite.revoked');
    expect(revogados).toHaveLength(1);
    // o e-mail fica só na criação; a revogação se liga a ela pelo id
    expect(revogados[0]).toMatchObject({ entityId: row?.id, before: { roleId: roles.member } });
    expect(JSON.stringify(revogados[0])).not.toContain('nova@veyra.test');

    const tudo = JSON.stringify(await prisma.raw.auditLog.findMany({ where: { workspaceId } }));
    expect(tudo).not.toContain(token);
    expect(tudo).not.toContain(row?.tokenHash);
  });

  it('o aceite registra a entrada (member.joined), com a própria membership como ator', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    await accept({ token, name: 'Nova Fictícia', password: 'senha-forte-123' }).expect(201);
    const row = await prisma.raw.invite.findFirst({ where: { email: 'nova@veyra.test' } });
    const membership = await prisma.raw.membership.findFirst({
      where: { workspaceId, user: { email: 'nova@veyra.test' } },
    });
    const entradas = await trilha('member.joined');
    expect(entradas).toHaveLength(1);
    expect(entradas[0]).toMatchObject({
      entityType: 'membership',
      entityId: membership?.id,
      actorType: 'user',
      actorMembershipId: membership?.id,
      before: null,
      after: { roleId: roles.member, status: 'active', inviteId: row?.id },
    });
    expect(JSON.stringify(entradas)).not.toContain(token);
  });

  it('a reativação de ex-membro registra o estado anterior (removed)', async () => {
    const exId = await createUserFixture(prisma, 'ex@veyra.test');
    const exMembership = await createMembershipFixture(prisma, workspaceId, exId, roles.member);
    await prisma.raw.membership.update({
      where: { id: exMembership },
      data: { status: 'removed', tokenVersion: { increment: 1 } },
    });
    const token = await createInvite('ex@veyra.test', roles.guest);
    await accept({ token, password: TEST_PASSWORD }).expect(201);
    const entradas = await trilha('member.joined');
    expect(entradas).toHaveLength(1);
    expect(entradas[0]).toMatchObject({
      entityId: exMembership,
      before: { roleId: roles.member, status: 'removed' },
      after: { roleId: roles.guest, status: 'active' },
    });
  });

  it('recusa antes de qualquer escrita: nenhuma entrada na trilha (fumaça)', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    await accept({ token }).expect(400); // conta nova sem nome e senha
    expect(await trilha('member.joined')).toHaveLength(0);
  });

  it('conta suspensa não aceita, com a mensagem única, e o convite não é consumido', async () => {
    const userId = await createUserFixture(prisma, 'suspensa@veyra.test');
    await prisma.raw.user.update({ where: { id: userId }, data: { status: 'suspended' } });
    const token = await createInvite('suspensa@veyra.test', roles.member);
    const res = await accept({ token, password: TEST_PASSWORD }).expect(400);
    expect(res.body.message).toBe('Convite inválido ou expirado');
    expect(await prisma.raw.membership.count({ where: { workspaceId, userId } })).toBe(0);
    expect(await trilha('member.joined')).toHaveLength(0);
    const convite = await prisma.raw.invite.findFirst({ where: { email: 'suspensa@veyra.test' } });
    expect(convite?.acceptedAt).toBeNull();
  });

  it('o e-mail do convite com outra caixa usa a conta existente: exige a senha dela, sem segunda conta', async () => {
    const userId = await createUserFixture(prisma, 'maria@veyra.test');
    const token = await createInvite('Maria@veyra.test', roles.member);
    // o portador não cria uma conta paralela com nome e senha novos
    await accept({ token, name: 'Outra Maria', password: 'senha-nova-123' }).expect(400);
    expect(
      await prisma.raw.user.count({
        where: { email: { equals: 'maria@veyra.test', mode: 'insensitive' } },
      }),
    ).toBe(1);
    // com a senha da conta, entra nela
    await accept({ token, password: TEST_PASSWORD }).expect(201);
    expect(
      await prisma.raw.membership.count({ where: { workspaceId, userId, status: 'active' } }),
    ).toBe(1);
  });

  it('workspace desativado não recebe ninguém pelo convite', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    await prisma.raw.workspace.update({
      where: { id: workspaceId },
      data: { status: 'suspended' },
    });
    await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
    expect(await prisma.raw.user.count({ where: { email: 'nova@veyra.test' } })).toBe(0);
  });

  it('convite para quem já é membro ativo é recusado no servidor (409), sem trilha', async () => {
    const memberId = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, workspaceId, memberId, roles.member);
    const session = await loginAs('owner@veyra.test');
    const res = await request(http)
      .post('/api/invites')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ email: 'MEMBRO@veyra.test', roleId: roles.admin })
      .expect(409);
    expect(res.body.message).toMatch(/já é membro/);
    expect(await prisma.raw.invite.count({ where: { workspaceId } })).toBe(0);
    expect(await trilha('invite.created')).toHaveLength(0);
  });

  it('ser membro de OUTRO workspace não impede o convite (nada revela conta alheia)', async () => {
    const outro = await createWorkspaceFixture(prisma, 'beta');
    const alheioId = await createUserFixture(prisma, 'alheio@veyra.test');
    await createMembershipFixture(prisma, outro.workspaceId, alheioId, outro.roles.member);
    const token = await createInvite('alheio@veyra.test', roles.member);
    expect(token.length).toBeGreaterThan(32);
  });

  it('remover alguém revoga os convites em aberto para o e-mail dele, com trilha — e o link guardado não traz de volta', async () => {
    const carlaId = await createUserFixture(prisma, 'carla@veyra.test');
    const primeiro = await createInvite('carla@veyra.test', roles.member);
    const segundo = await createInvite('CARLA@veyra.test', roles.member);
    await accept({ token: primeiro, password: TEST_PASSWORD }).expect(201);
    const carla = await prisma.raw.membership.findFirst({
      where: { workspaceId, userId: carlaId },
    });
    // o segundo link continua em aberto enquanto ela é membro
    expect(await prisma.raw.invite.count({ where: { workspaceId, acceptedAt: null } })).toBe(1);

    const owner = await loginAs('owner@veyra.test');
    await request(http)
      .delete(`/api/members/${carla?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', owner.cookieHeader)
      .set('x-csrf-token', owner.csrf)
      .expect(200);

    expect(await prisma.raw.invite.count({ where: { workspaceId, acceptedAt: null } })).toBe(0);
    const revogados = await trilha('invite.revoked');
    expect(revogados).toHaveLength(1);
    expect(revogados[0]).toMatchObject({ actorType: 'user', before: { roleId: roles.member } });
    await accept({ token: segundo, password: TEST_PASSWORD }).expect(400);
    const depois = await prisma.raw.membership.findFirst({ where: { id: carla?.id } });
    expect(depois?.status).toBe('removed');
  });

  it('remover alguém não toca nos convites de outros e-mails', async () => {
    const carlaId = await createUserFixture(prisma, 'carla@veyra.test');
    await createMembershipFixture(prisma, workspaceId, carlaId, roles.member);
    await createInvite('outra@veyra.test', roles.member);
    const carla = await prisma.raw.membership.findFirst({
      where: { workspaceId, userId: carlaId },
    });
    const owner = await loginAs('owner@veyra.test');
    await request(http)
      .delete(`/api/members/${carla?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', owner.cookieHeader)
      .set('x-csrf-token', owner.csrf)
      .expect(200);
    expect(
      await prisma.raw.invite.count({ where: { workspaceId, email: 'outra@veyra.test' } }),
    ).toBe(1);
    expect(await trilha('invite.revoked')).toHaveLength(0);
  });

  it('revogar convite de papel acima do ator é recusado (ADR-054 item 6) — o convite e a trilha ficam', async () => {
    await createInvite('dono@veyra.test', roles.owner);
    const convite = await prisma.raw.invite.findFirst({ where: { email: 'dono@veyra.test' } });
    const adminId = await createUserFixture(prisma, 'admin@veyra.test');
    await createMembershipFixture(prisma, workspaceId, adminId, roles.admin);
    const admin = await loginAs('admin@veyra.test');
    await request(http)
      .delete(`/api/invites/${convite?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', admin.cookieHeader)
      .set('x-csrf-token', admin.csrf)
      .expect(403);
    expect(await prisma.raw.invite.count({ where: { id: convite?.id } })).toBe(1);
    expect(await trilha('invite.revoked')).toHaveLength(0);

    // o mesmo Admin revoga o convite de um papel que ele administra
    await createInvite('membro-novo@veyra.test', roles.member);
    const doMembro = await prisma.raw.invite.findFirst({
      where: { email: 'membro-novo@veyra.test' },
    });
    await request(http)
      .delete(`/api/invites/${doMembro?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', admin.cookieHeader)
      .set('x-csrf-token', admin.csrf)
      .expect(200);
  });

  it('convite de outro workspace não é revogado nem listado (404)', async () => {
    const outro = await createWorkspaceFixture(prisma, 'beta');
    const outroOwner = await createUserFixture(prisma, 'owner-beta@veyra.test');
    await createMembershipFixture(prisma, outro.workspaceId, outroOwner, outro.roles.owner);
    const sessaoBeta = await loginAs('owner-beta@veyra.test');
    await request(http)
      .post('/api/invites')
      .set('Origin', ORIGIN)
      .set('Cookie', sessaoBeta.cookieHeader)
      .set('x-csrf-token', sessaoBeta.csrf)
      .send({ email: 'alguem@veyra.test', roleId: outro.roles.member })
      .expect(201);
    const doBeta = await prisma.raw.invite.findFirst({ where: { email: 'alguem@veyra.test' } });

    const owner = await loginAs('owner@veyra.test');
    const lista = await request(http)
      .get('/api/invites')
      .set('Cookie', owner.cookieHeader)
      .expect(200);
    expect(lista.body).toHaveLength(0);
    await request(http)
      .delete(`/api/invites/${doBeta?.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', owner.cookieHeader)
      .set('x-csrf-token', owner.csrf)
      .expect(404);
    expect(await prisma.raw.invite.count({ where: { id: doBeta?.id } })).toBe(1);
  });

  // ── ADR-054 item 12: a autoridade de quem convidou ─────────────────────────

  describe('a autoridade de quem convidou', () => {
    let adminMembership: string;

    beforeEach(async () => {
      const adminId = await createUserFixture(prisma, 'admin@veyra.test');
      adminMembership = await createMembershipFixture(prisma, workspaceId, adminId, roles.admin);
    });

    async function convidarComo(ator: string, email: string, roleId: string, extra = {}) {
      const session = await loginAs(ator);
      const res = await request(http)
        .post('/api/invites')
        .set('Origin', ORIGIN)
        .set('Cookie', session.cookieHeader)
        .set('x-csrf-token', session.csrf)
        .send({ email, roleId, ...extra })
        .expect(201);
      return res.body as { id: string; token: string };
    }

    async function comoOwner(
      metodo: 'patch' | 'delete',
      caminho: string,
      status: number,
      corpo?: object,
    ) {
      const owner = await loginAs('owner@veyra.test');
      const req = request(http)
        [metodo](caminho)
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .set('x-csrf-token', owner.csrf);
      return (corpo ? req.send(corpo) : req).expect(status);
    }

    /** a trava dos membros, segurada por fora: as corridas ficam determinísticas */
    async function segurarTrava(): Promise<Client> {
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      await trava.query('BEGIN');
      await trava.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        'veyra_members',
        workspaceId,
      ]);
      return trava;
    }

    it('o convite guarda a membership AUTENTICADA de quem criou — a origem enviada pelo cliente é ignorada', async () => {
      // a rota comum não aceita do cliente nem o criador nem a marca do
      // provisionamento, e a marca não substitui quem convida
      const convite = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.member, {
        createdByMembershipId: '00000000-0000-4000-8000-000000000001',
        issuedByProvisioning: true,
      });
      const linha = await prisma.raw.invite.findFirst({ where: { id: convite.id } });
      expect(linha?.createdByMembershipId).toBe(adminMembership);
      expect(linha?.issuedByProvisioning).toBe(false);
    });

    it('autor removido antes do aceite: o convite dele cai na remoção, com trilha, e o aceite é recusado', async () => {
      const { id, token } = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.member);
      await comoOwner('delete', `/api/members/${adminMembership}`, 200);
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      const revogados = await trilha('invite.revoked');
      expect(revogados.map((r) => r.entityId)).toEqual([id]);
      const res = await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
      expect(res.body.message).toBe('Convite inválido ou expirado');
      expect(await prisma.raw.user.count({ where: { email: 'nova@veyra.test' } })).toBe(0);
    });

    it('autor rebaixado sem autoridade para o papel: o convite cai na troca e o aceite é recusado', async () => {
      const { id, token } = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.admin);
      await comoOwner('patch', `/api/members/${adminMembership}/role`, 200, {
        roleId: roles.member,
      });
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      expect((await trilha('invite.revoked')).map((r) => r.entityId)).toEqual([id]);
      await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
    });

    it('autor rebaixado sem `members:manage`, mesmo com permissões que cobrem o papel: o convite cai', async () => {
      // Member contém todas as permissões de Guest, mas não pode convidar: a
      // autoridade exige as DUAS condições
      const { id, token } = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.guest);
      await comoOwner('patch', `/api/members/${adminMembership}/role`, 200, {
        roleId: roles.member,
      });
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      expect((await trilha('invite.revoked')).map((r) => r.entityId)).toEqual([id]);
      await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
    });

    it('autor rebaixado que AINDA pode conceder o papel: o convite continua valendo', async () => {
      const owner2Id = await createUserFixture(prisma, 'owner2@veyra.test');
      const owner2 = await createMembershipFixture(prisma, workspaceId, owner2Id, roles.owner);
      const { token } = await convidarComo('owner2@veyra.test', 'nova@veyra.test', roles.member);
      await comoOwner('patch', `/api/members/${owner2}/role`, 200, { roleId: roles.admin });
      expect(await trilha('invite.revoked')).toHaveLength(0);
      const res = await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(201);
      expect(res.body.activeMembership.roleName).toBe('Member');
    });

    it('autoridade perdida por fora dos caminhos da tela: o aceite invalida DE VEZ, e devolver a autoridade não ressuscita', async () => {
      const { id, token } = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.member);
      // a conta de quem convidou suspensa globalmente (fora da gestão de equipe)
      const admin = await prisma.raw.user.findFirst({ where: { email: 'admin@veyra.test' } });
      await prisma.raw.user.update({ where: { id: admin!.id }, data: { status: 'suspended' } });
      const res = await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
      expect(res.body.message).toBe('Convite inválido ou expirado');
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      const invalidados = await trilha('invite.invalidated');
      expect(invalidados).toHaveLength(1);
      expect(invalidados[0]).toMatchObject({
        entityId: id,
        actorType: 'system',
        actorId: 'invite-accept',
        before: { roleId: roles.member },
      });
      expect(JSON.stringify(invalidados)).not.toContain('nova@veyra.test');

      // a autoridade volta: o convite não. O banco, depois da nova resposta,
      // continua sem o convite, com a MESMA trilha e sem conta criada
      await prisma.raw.user.update({ where: { id: admin!.id }, data: { status: 'active' } });
      const de_novo = await accept({ token, name: 'Nova', password: 'senha-forte-123' }).expect(
        400,
      );
      expect(de_novo.body.message).toBe('Convite inválido ou expirado');
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      expect(await trilha('invite.invalidated')).toHaveLength(1);
      expect(await prisma.raw.user.count({ where: { email: 'nova@veyra.test' } })).toBe(0);
    });

    it('autor removido e readmitido: o convite antigo continua morto', async () => {
      const antigo = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.member);
      await comoOwner('delete', `/api/members/${adminMembership}`, 200);
      // readmitido por um convite novo do Owner, com o mesmo papel de antes
      const volta = await convidarComo('owner@veyra.test', 'admin@veyra.test', roles.admin);
      await accept({ token: volta.token, password: TEST_PASSWORD }).expect(201);
      const readmitido = await prisma.raw.membership.findFirst({ where: { id: adminMembership } });
      expect(readmitido?.status).toBe('active');
      await accept({ token: antigo.token, name: 'Nova', password: 'senha-forte-123' }).expect(400);
    });

    it('corrida: o aceite espera a trava e lê a autoridade DEPOIS dela', async () => {
      const { id, token } = await convidarComo('admin@veyra.test', 'nova@veyra.test', roles.admin);
      const trava = await segurarTrava();
      let pedido: Promise<request.Response> | null = null;
      try {
        const responderam: number[] = [];
        pedido = accept({ token, name: 'Nova', password: 'senha-forte-123' }).then((r) => {
          responderam.push(r.status);
          return r;
        });
        await esperarBloqueadosPor(trava, 1, {
          descricao: 'aceite parado na trava dos membros',
          aCadaTentativa: () => {
            if (responderam.length > 0)
              throw new Error(`o aceite respondeu ${responderam[0]} sem esperar a trava`);
          },
        });
        // enquanto o aceite espera, quem convidou perde a autoridade para Admin
        await trava.query('UPDATE "Membership" SET "roleId" = $1 WHERE "id" = $2', [
          roles.member,
          adminMembership,
        ]);
        await trava.query('COMMIT');
        const res = await pedido;
        expect(res.status).toBe(400);
      } finally {
        await trava.end();
        if (pedido) await Promise.allSettled([pedido]);
      }
      expect(await prisma.raw.invite.count({ where: { id } })).toBe(0);
      expect(await trilha('invite.invalidated')).toHaveLength(1);
      expect(await prisma.raw.user.count({ where: { email: 'nova@veyra.test' } })).toBe(0);
    });

    it('corrida com a remoção de quem convidou: a que chega primeiro à trava decide', async () => {
      // remoção primeiro: o aceite encontra o convite já revogado
      const um = await convidarComo('admin@veyra.test', 'um@veyra.test', roles.member);
      const ownerSessao = await loginAs('owner@veyra.test');
      let trava = await segurarTrava();
      let pedidos: Promise<request.Response>[] = [];
      try {
        pedidos.push(
          request(http)
            .delete(`/api/members/${adminMembership}`)
            .set('Origin', ORIGIN)
            .set('Cookie', ownerSessao.cookieHeader)
            .set('x-csrf-token', ownerSessao.csrf)
            .then((r) => r),
        );
        await esperarBloqueadosPor(trava, 1, { descricao: 'a remoção na trava' });
        pedidos.push(
          accept({ token: um.token, name: 'Um', password: 'senha-forte-123' }).then((r) => r),
        );
        await esperarBloqueadosPor(trava, 2, { descricao: 'a remoção e o aceite na trava' });
        await trava.query('COMMIT');
        const [remocao, aceite] = await Promise.all(pedidos);
        expect(remocao.status).toBe(200);
        expect(aceite.status).toBe(400);
      } finally {
        await trava.end();
        await Promise.allSettled(pedidos);
      }
      expect(await prisma.raw.user.count({ where: { email: 'um@veyra.test' } })).toBe(0);
      // o aceite releu o convite DEPOIS da trava e o achou revogado pela remoção:
      // nenhuma invalidação espúria sobre um convite que já tinha saído
      expect((await trilha('invite.revoked')).map((r) => r.entityId)).toContain(um.id);
      expect(await trilha('invite.invalidated')).toHaveLength(0);

      // aceite primeiro: entra, e a remoção que vem depois não o desfaz
      await prisma.raw.membership.update({
        where: { id: adminMembership },
        data: { status: 'active' },
      });
      const dois = await convidarComo('admin@veyra.test', 'dois@veyra.test', roles.member);
      trava = await segurarTrava();
      pedidos = [];
      try {
        pedidos.push(
          accept({ token: dois.token, name: 'Dois', password: 'senha-forte-123' }).then((r) => r),
        );
        await esperarBloqueadosPor(trava, 1, { descricao: 'o aceite na trava' });
        pedidos.push(
          request(http)
            .delete(`/api/members/${adminMembership}`)
            .set('Origin', ORIGIN)
            .set('Cookie', ownerSessao.cookieHeader)
            .set('x-csrf-token', ownerSessao.csrf)
            .then((r) => r),
        );
        await esperarBloqueadosPor(trava, 2, { descricao: 'o aceite e a remoção na trava' });
        await trava.query('COMMIT');
        const [aceite, remocao] = await Promise.all(pedidos);
        expect(aceite.status).toBe(201);
        expect(remocao.status).toBe(200);
      } finally {
        await trava.end();
        await Promise.allSettled(pedidos);
      }
      const dois_ = await prisma.raw.membership.findFirst({
        where: { workspaceId, user: { email: 'dois@veyra.test' } },
      });
      expect(dois_?.status).toBe('active');
    });

    it('corrida: quem perde `members:manage` enquanto espera a trava não convida', async () => {
      const admin = await loginAs('admin@veyra.test');
      const trava = await segurarTrava();
      let pedido: Promise<request.Response> | null = null;
      try {
        pedido = request(http)
          .post('/api/invites')
          .set('Origin', ORIGIN)
          .set('Cookie', admin.cookieHeader)
          .set('x-csrf-token', admin.csrf)
          .send({ email: 'nova@veyra.test', roleId: roles.guest })
          .then((r) => r);
        await esperarBloqueadosPor(trava, 1, { descricao: 'a criação na trava' });
        await trava.query('UPDATE "Membership" SET "roleId" = $1 WHERE "id" = $2', [
          roles.guest,
          adminMembership,
        ]);
        await trava.query('COMMIT');
        expect((await pedido).status).toBe(403);
      } finally {
        await trava.end();
        if (pedido) await Promise.allSettled([pedido]);
      }
      expect(await prisma.raw.invite.count({ where: { workspaceId } })).toBe(0);
    });

    it('o convite do provisionamento vale pela operação, sem membership de origem', async () => {
      const resultado = await app.get(ProvisioningService).provision({
        name: 'Nova Clínica Fictícia',
        slug: 'nova-ficticia',
        ownerEmail: 'dona-nova@veyra.test',
      });
      if (resultado.owner !== 'invite') throw new Error('esperava convite de Owner');
      const linha = await prisma.raw.invite.findFirst({ where: { id: resultado.inviteId } });
      expect(linha).toMatchObject({ issuedByProvisioning: true, createdByMembershipId: null });
      const res = await accept({
        token: resultado.inviteToken,
        name: 'Dona Nova',
        password: 'senha-forte-123',
      }).expect(201);
      expect(res.body.activeMembership.roleName).toBe('Owner');
    });

    it('banco: convite pendente sem origem, ou com as duas, é recusado; quem convida é do MESMO workspace', async () => {
      const base = {
        workspaceId,
        email: 'x@veyra.test',
        roleId: roles.member,
        expiresAt: new Date(Date.now() + 86_400_000),
      };
      await expect(
        prisma.raw.invite.create({ data: { ...base, tokenHash: 'h-sem-origem' } }),
      ).rejects.toThrow(/Invite_autoridade_conhecida/);
      await expect(
        prisma.raw.invite.create({
          data: {
            ...base,
            tokenHash: 'h-duas',
            createdByMembershipId: adminMembership,
            issuedByProvisioning: true,
          },
        }),
      ).rejects.toThrow(/Invite_autoridade_conhecida/);
      const outro = await createWorkspaceFixture(prisma, 'beta');
      const alheioId = await createUserFixture(prisma, 'alheio@veyra.test');
      const alheio = await createMembershipFixture(
        prisma,
        outro.workspaceId,
        alheioId,
        outro.roles.admin,
      );
      await expect(
        prisma.raw.invite.create({
          data: { ...base, tokenHash: 'h-alheio', createdByMembershipId: alheio },
        }),
      ).rejects.toThrow(/Invite_workspaceId_createdByMembershipId_fkey|Foreign key/i);
    });

    it('o critério de e-mail trata `_` literalmente no aceite: `a_b@` não é a conta `axb@`', async () => {
      await createUserFixture(prisma, 'axb@veyra.test');
      // a premissa: o pré-filtro (ILIKE) traz a conta `axb@` para o padrão `a_b@`
      expect(
        await prisma.raw.user.count({ where: { email: preFiltroDoEmail('a_b@veyra.test') } }),
      ).toBe(1);
      const { token } = await convidarComo('owner@veyra.test', 'a_b@veyra.test', roles.member);
      // `a_b@` não tem conta: o aceite cria uma, sem pedir a senha de `axb@`
      await accept({ token, name: 'Ab', password: 'senha-forte-123' }).expect(201);
      expect(await prisma.raw.user.count({ where: { email: 'a_b@veyra.test' } })).toBe(1);
      const axb = await prisma.raw.user.findFirst({ where: { email: 'axb@veyra.test' } });
      expect(await prisma.raw.membership.count({ where: { userId: axb!.id } })).toBe(0);
    });

    it('o critério de e-mail trata `%` literalmente na remoção: só o convite do mesmo endereço cai', async () => {
      // `%` não passa pelo contrato do convite, mas pode estar numa conta já gravada
      const pctId = await createUserFixture(prisma, 'a%c@veyra.test');
      const pct = await createMembershipFixture(prisma, workspaceId, pctId, roles.member);
      const owner = await prisma.raw.membership.findFirst({
        where: { workspaceId, user: { email: 'owner@veyra.test' } },
      });
      const base = {
        workspaceId,
        roleId: roles.member,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdByMembershipId: owner!.id,
      };
      const doMesmo = await prisma.raw.invite.create({
        data: { ...base, email: 'A%C@veyra.test', tokenHash: 'h-pct-1' },
      });
      const doOutro = await prisma.raw.invite.create({
        data: { ...base, email: 'abbbc@veyra.test', tokenHash: 'h-pct-2' },
      });
      // a premissa: o pré-filtro traz os dois para o padrão `a%c@`
      expect(
        await prisma.raw.invite.count({ where: { email: preFiltroDoEmail('a%c@veyra.test') } }),
      ).toBe(2);
      await comoOwner('delete', `/api/members/${pct}`, 200);
      expect(await prisma.raw.invite.count({ where: { id: doMesmo.id } })).toBe(0);
      expect(await prisma.raw.invite.count({ where: { id: doOutro.id } })).toBe(1);
    });

    it('todo aceite com token válido gasta EXATAMENTE um bcrypt — com conta, sem conta ou ambígua', async () => {
      await createUserFixture(prisma, 'existe@veyra.test');
      await createUserFixture(prisma, 'Dupla@veyra.test');
      await createUserFixture(prisma, 'dupla@veyra.test');
      const casos = {
        comConta: (await convidarComo('owner@veyra.test', 'existe@veyra.test', roles.member)).token,
        semConta: (await convidarComo('owner@veyra.test', 'ninguem@veyra.test', roles.member))
          .token,
        ambigua: (await convidarComo('owner@veyra.test', 'dupla@veyra.test', roles.member)).token,
      };
      const contagem: Record<string, number> = {};
      for (const [caso, token] of Object.entries(casos)) {
        const espia = jest.spyOn(bcrypt, 'compare');
        try {
          // a senha errada em todos: nenhum aceite passa, e a resposta é a mesma
          const res = await accept({ token, password: 'senha-errada-999' }).expect(400);
          expect(res.body.message).toBe('Convite inválido ou expirado');
          contagem[caso] = espia.mock.calls.length;
        } finally {
          espia.mockRestore();
        }
      }
      expect(contagem).toEqual({ comConta: 1, semConta: 1, ambigua: 1 });
    });

    it('identidade ambígua (duas contas que só diferem na caixa): o aceite recusa, sem escolher uma', async () => {
      await createUserFixture(prisma, 'Ana@veyra.test');
      await createUserFixture(prisma, 'ana@veyra.test');
      const { id, token } = await convidarComo('owner@veyra.test', 'ana@veyra.test', roles.member);
      const res = await accept({ token, password: TEST_PASSWORD }).expect(400);
      expect(res.body.message).toBe('Convite inválido ou expirado');
      expect(
        await prisma.raw.membership.count({
          where: { workspaceId, user: { email: { in: ['Ana@veyra.test', 'ana@veyra.test'] } } },
        }),
      ).toBe(0);
      // a recusa não consome o convite: a resolução das contas vem antes
      expect((await prisma.raw.invite.findFirst({ where: { id } }))?.acceptedAt).toBeNull();
    });

    it('a criação reconhece o membro pelo mesmo critério, com a caixa trocada', async () => {
      const session = await loginAs('owner@veyra.test');
      await request(http)
        .post('/api/invites')
        .set('Origin', ORIGIN)
        .set('Cookie', session.cookieHeader)
        .set('x-csrf-token', session.csrf)
        .send({ email: 'ADMIN@veyra.test', roleId: roles.member })
        .expect(409);
    });
  });
});

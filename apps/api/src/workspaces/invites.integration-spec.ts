import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
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

  it('e-mail novo sem nome/senha: pede os dados SEM queimar o convite', async () => {
    const token = await createInvite('nova@veyra.test', roles.member);
    const res = await accept({ token }).expect(400);
    expect(res.body.message).toMatch(/nome e senha/i);
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

  it('membro ativo reconvidado recebe a MESMA mensagem genérica', async () => {
    const memberId = await createUserFixture(prisma, 'membro@veyra.test');
    await createMembershipFixture(prisma, workspaceId, memberId, roles.member);
    const token = await createInvite('membro@veyra.test', roles.admin);
    const res = await accept({ token }).expect(400);
    expect(res.body.message).toMatch(/inválido ou expirado/i);
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
});

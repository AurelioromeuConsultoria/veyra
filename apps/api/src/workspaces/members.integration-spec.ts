import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { sha256 } from '../auth/tokens';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

describe('Workspaces — membros, roles e provisionamento (integração)', () => {
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
  let ownerMembershipId: string;
  let memberUserId: string;
  let memberMembershipId: string;

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const fixture = await createWorkspaceFixture(prisma, 'acme');
    workspaceId = fixture.workspaceId;
    roles = fixture.roles;
    const ownerId = await createUserFixture(prisma, 'owner@veyra.test');
    ownerMembershipId = await createMembershipFixture(prisma, workspaceId, ownerId, roles.owner);
    memberUserId = await createUserFixture(prisma, 'member@veyra.test');
    memberMembershipId = await createMembershipFixture(
      prisma,
      workspaceId,
      memberUserId,
      roles.member,
    );
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

  it('lista membros do workspace com nome/e-mail — e nada de outro workspace', async () => {
    const other = await createWorkspaceFixture(prisma, 'beta');
    const intruderId = await createUserFixture(prisma, 'intruso@veyra.test');
    await createMembershipFixture(prisma, other.workspaceId, intruderId, other.roles.member);

    const session = await loginAs('owner@veyra.test');
    const res = await request(http)
      .get('/api/members')
      .set('Cookie', session.cookieHeader)
      .expect(200);
    const emails = res.body.map((m: { email: string }) => m.email).sort();
    expect(emails).toEqual(['member@veyra.test', 'owner@veyra.test']);
  });

  it('member (sem members:manage) não gerencia; leitura de roles ok', async () => {
    const session = await loginAs('member@veyra.test');
    await request(http).get('/api/roles').set('Cookie', session.cookieHeader).expect(200);
    await request(http)
      .patch(`/api/members/${ownerMembershipId}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ roleId: roles.guest })
      .expect(403);
  });

  it('trocar role incrementa tokenVersion (sessão do alvo cai) — e funciona', async () => {
    const memberSession = await loginAs('member@veyra.test');
    await request(http).get('/api/auth/me').set('Cookie', memberSession.cookieHeader).expect(200);

    const ownerSession = await loginAs('owner@veyra.test');
    await request(http)
      .patch(`/api/members/${memberMembershipId}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', ownerSession.cookieHeader)
      .set('x-csrf-token', ownerSession.csrf)
      .send({ roleId: roles.admin })
      .expect(200);

    const updated = await prisma.raw.membership.findFirst({
      where: { id: memberMembershipId },
    });
    expect(updated?.roleId).toBe(roles.admin);
    expect(updated?.tokenVersion).toBe(1);
    // sessão antiga do alvo cai na request seguinte (ADR-009)
    await request(http).get('/api/auth/me').set('Cookie', memberSession.cookieHeader).expect(401);
  });

  it('ninguém altera a própria função nem remove a si mesmo (ajuste #6)', async () => {
    const session = await loginAs('owner@veyra.test');
    await request(http)
      .patch(`/api/members/${ownerMembershipId}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ roleId: roles.admin })
      .expect(403);
    await request(http)
      .delete(`/api/members/${ownerMembershipId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(403);
  });

  it('anti-autoelevação: admin não atribui papel com permissões que não possui', async () => {
    const adminId = await createUserFixture(prisma, 'admin@veyra.test');
    await createMembershipFixture(prisma, workspaceId, adminId, roles.admin);
    const session = await loginAs('admin@veyra.test');
    // Owner tem billing:manage, que o Admin não tem → superset → 403
    await request(http)
      .patch(`/api/members/${memberMembershipId}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ roleId: roles.owner })
      .expect(403);
  });

  it('último Owner ativo não pode ser rebaixado nem removido; com 2 Owners pode', async () => {
    const admin2Id = await createUserFixture(prisma, 'admin2@veyra.test');
    await createMembershipFixture(prisma, workspaceId, admin2Id, roles.admin);
    // admin2 tem members:manage mas NÃO consegue rebaixar o único Owner
    const adminSession = await loginAs('admin2@veyra.test');
    await request(http)
      .patch(`/api/members/${ownerMembershipId}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', adminSession.cookieHeader)
      .set('x-csrf-token', adminSession.csrf)
      .send({ roleId: roles.guest })
      .expect(403);
    await request(http)
      .delete(`/api/members/${ownerMembershipId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', adminSession.cookieHeader)
      .set('x-csrf-token', adminSession.csrf)
      .expect(403);

    // segundo Owner entra → aí o primeiro pode ser removido (por um Owner)
    const owner2Id = await createUserFixture(prisma, 'owner2@veyra.test');
    await createMembershipFixture(prisma, workspaceId, owner2Id, roles.owner);
    const owner2Session = await loginAs('owner2@veyra.test');
    await request(http)
      .delete(`/api/members/${ownerMembershipId}`)
      .set('Origin', ORIGIN)
      .set('Cookie', owner2Session.cookieHeader)
      .set('x-csrf-token', owner2Session.csrf)
      .expect(200);
  });

  it('Admin não mexe em Owner mesmo com 2+ Owners (P1-5: papel do alvo é checado)', async () => {
    // dois Owners para o invariante de último Owner não interferir
    const owner2Id = await createUserFixture(prisma, 'owner2@veyra.test');
    await createMembershipFixture(prisma, workspaceId, owner2Id, roles.owner);
    const adminId = await createUserFixture(prisma, 'admin@veyra.test');
    await createMembershipFixture(prisma, workspaceId, adminId, roles.admin);

    const session = await loginAs('admin@veyra.test');
    const ownerMembership = await prisma.raw.membership.findFirst({
      where: { userId: owner2Id },
    });
    // Admin (sem billing:manage) não pode rebaixar nem remover um Owner
    await request(http)
      .patch(`/api/members/${ownerMembership!.id}/role`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ roleId: roles.member })
      .expect(403);
    await request(http)
      .delete(`/api/members/${ownerMembership!.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(403);
  });

  it('corrida: dois Owners removendo um ao outro deixa exatamente um (TOCTOU fechado)', async () => {
    const owner2Id = await createUserFixture(prisma, 'owner2@veyra.test');
    const owner2Membership = await createMembershipFixture(
      prisma,
      workspaceId,
      owner2Id,
      roles.owner,
    );
    const s1 = await loginAs('owner@veyra.test');
    const s2 = await loginAs('owner2@veyra.test');
    // owner remove owner2 e owner2 remove owner AO MESMO TEMPO: sem serialização
    // ambos leriam count=2 e zerariam os Owners. O advisory lock garante 1 e 403.
    const [r1, r2] = await Promise.all([
      request(http)
        .delete(`/api/members/${owner2Membership}`)
        .set('Origin', ORIGIN)
        .set('Cookie', s1.cookieHeader)
        .set('x-csrf-token', s1.csrf),
      request(http)
        .delete(`/api/members/${ownerMembershipId}`)
        .set('Origin', ORIGIN)
        .set('Cookie', s2.cookieHeader)
        .set('x-csrf-token', s2.csrf),
    ]);
    // o perdedor toma 403 (invariante do último Owner) ou 401 (foi removido
    // antes de passar no guard — revogação imediata); nunca dois 200
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 403]).toContain(statuses[1]);
    const remaining = await prisma.raw.membership.count({
      where: { workspaceId, status: 'active', role: { systemKey: 'owner' } },
    });
    expect(remaining).toBe(1);
  });

  describe('ProvisioningService (rotina administrativa)', () => {
    it('owner com conta existente → membership Owner; roles de sistema semeados', async () => {
      await createUserFixture(prisma, 'dona@nova.test');
      const provisioning = app.get(ProvisioningService);
      const result = await provisioning.provision({
        name: 'Nova',
        slug: 'nova',
        ownerEmail: 'dona@nova.test',
      });
      expect(result.owner).toBe('membership');
      const seeded = await prisma.raw.role.findMany({
        where: { workspaceId: result.workspaceId },
      });
      expect(seeded.map((r) => r.systemKey).sort()).toEqual(['admin', 'guest', 'member', 'owner']);
      expect(seeded.every((r) => r.isSystem)).toBe(true);
    });

    it('owner sem conta → Invite Owner (nunca User incompleto); só o hash persiste (ajuste #3)', async () => {
      const provisioning = app.get(ProvisioningService);
      const result = await provisioning.provision({
        name: 'Sem Dono',
        slug: 'sem-dono',
        ownerEmail: 'futura@dona.test',
      });
      if (result.owner !== 'invite') throw new Error('esperava invite');
      // nenhum user foi criado
      expect(await prisma.raw.user.findUnique({ where: { email: 'futura@dona.test' } })).toBeNull();
      // o banco só tem o hash do token
      const invite = await prisma.raw.invite.findFirst({ where: { id: result.inviteId } });
      expect(invite?.tokenHash).toBe(sha256(result.inviteToken));
      expect(invite?.tokenHash).not.toBe(result.inviteToken);
      expect(invite?.acceptedAt).toBeNull();
    });

    it('slug duplicado é recusado', async () => {
      const provisioning = app.get(ProvisioningService);
      await expect(
        provisioning.provision({ name: 'X', slug: 'acme', ownerEmail: 'x@x.test' }),
      ).rejects.toThrow(/slug/i);
    });
  });
});

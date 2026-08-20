import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AuthenticatedOnly, RequirePermissions } from '../common/decorators';
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

/** Rotas de teste para provar o default-deny (ADR-016) contra o app real. */
@Controller('_test')
class DefaultDenyProbeController {
  @Get('undecorated')
  undecorated() {
    return { leaked: true };
  }

  @AuthenticatedOnly()
  @Get('authonly')
  authonly() {
    return { ok: true };
  }

  @RequirePermissions('contacts:read')
  @Get('readable')
  readable() {
    return { ok: true };
  }

  @RequirePermissions('members:manage')
  @Post('managed')
  managed() {
    return { ok: true };
  }
}

interface Session {
  cookieHeader: string;
  csrf: string;
}

function extractSession(res: request.Response): Session {
  const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
  const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
  const csrf = /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '';
  return { cookieHeader, csrf };
}

describe('Auth — fluxo completo (integração HTTP)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp([DefaultDenyProbeController]);
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let workspaceId: string;
  let roles: Record<string, string>;
  let ownerMembershipId: string;
  const OWNER_EMAIL = 'owner@veyra.test';

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const fixture = await createWorkspaceFixture(prisma, 'acme');
    workspaceId = fixture.workspaceId;
    roles = fixture.roles;
    const ownerId = await createUserFixture(prisma, OWNER_EMAIL);
    ownerMembershipId = await createMembershipFixture(prisma, workspaceId, ownerId, roles.owner);
  });

  function login(email = OWNER_EMAIL, password = TEST_PASSWORD) {
    return request(http).post('/api/auth/login').set('Origin', ORIGIN).send({ email, password });
  }

  it('login ok: DTO sem segredos, cookies de sessão setados', async () => {
    const res = await login().expect(201);
    expect(res.body.email).toBe(OWNER_EMAIL);
    expect(res.body.activeMembership.workspaceId).toBe(workspaceId);
    expect(res.body.permissions).toContain('members:manage');
    expect(JSON.stringify(res.body)).not.toMatch(/hash|token/i);
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/veyra_access=[^;]+;.*HttpOnly/);
    expect(cookies).toMatch(/veyra_refresh=[^;]+;.*Path=\/api\/auth/);
    expect(cookies).toMatch(/veyra_csrf=/);
  });

  it('login inválido: 401 com mensagem única (não revela se o e-mail existe)', async () => {
    const wrongPassword = await login(OWNER_EMAIL, 'senha-errada-123').expect(401);
    const wrongEmail = await login('naoexiste@veyra.test', TEST_PASSWORD).expect(401);
    expect(wrongPassword.body.message).toBe(wrongEmail.body.message);
  });

  it('mutação sem Origin, com Origin errado ou sem CSRF → 403', async () => {
    const session = extractSession(await login().expect(201));
    await request(http).post('/api/_test/managed').set('Cookie', session.cookieHeader).expect(403);
    await request(http)
      .post('/api/_test/managed')
      .set('Origin', 'https://malicioso.example')
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(403);
    await request(http)
      .post('/api/_test/managed')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', 'csrf-forjado')
      .expect(403);
    await request(http)
      .post('/api/_test/managed')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(201);
  });

  it('login (mutação @Public com cookies) também exige Origin correto', async () => {
    await request(http)
      .post('/api/auth/login')
      .set('Origin', 'https://malicioso.example')
      .send({ email: OWNER_EMAIL, password: TEST_PASSWORD })
      .expect(403);
  });

  it('default-deny (ADR-016): rota sem decorator é negada mesmo autenticado', async () => {
    const session = extractSession(await login().expect(201));
    const res = await request(http)
      .get('/api/_test/undecorated')
      .set('Cookie', session.cookieHeader)
      .expect(403);
    expect(res.body.message).toMatch(/default-deny|ADR-016/);
    await request(http).get('/api/_test/authonly').set('Cookie', session.cookieHeader).expect(200);
    await request(http).get('/api/_test/readable').set('Cookie', session.cookieHeader).expect(200);
  });

  it('permissão insuficiente: Guest lê mas não gerencia', async () => {
    const guestId = await createUserFixture(prisma, 'guest@veyra.test');
    await createMembershipFixture(prisma, workspaceId, guestId, roles.guest);
    const session = extractSession(await login('guest@veyra.test').expect(201));
    await request(http).get('/api/_test/readable').set('Cookie', session.cookieHeader).expect(200);
    await request(http)
      .post('/api/_test/managed')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(403);
  });

  it('refresh rotaciona; REUSO do token antigo derruba todas as sessões (tokenVersion)', async () => {
    const first = extractSession(await login().expect(201));
    const refreshed = await request(http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookieHeader)
      .expect(201);
    const second = extractSession(refreshed);
    expect(second.cookieHeader).not.toBe(first.cookieHeader);
    // a sessão nova funciona
    await request(http).get('/api/auth/me').set('Cookie', second.cookieHeader).expect(200);
    // REUSO do refresh antigo (rotacionado) → 401 e derruba TUDO do usuário
    await request(http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', first.cookieHeader)
      .expect(401);
    // o access da sessão nova cai na request seguinte (tokenVersion divergente)
    await request(http).get('/api/auth/me').set('Cookie', second.cookieHeader).expect(401);
  });

  it('revogação imediata: membership suspensa derruba o access na request seguinte (ADR-009)', async () => {
    const session = extractSession(await login().expect(201));
    await request(http).get('/api/auth/me').set('Cookie', session.cookieHeader).expect(200);
    // simulação da remoção administrativa: suspende + incrementa tokenVersion
    await prisma.raw.membership.updateMany({
      where: { id: ownerMembershipId },
      data: { status: 'suspended', tokenVersion: { increment: 1 } },
    });
    await request(http).get('/api/auth/me').set('Cookie', session.cookieHeader).expect(401);
  });

  it('switch-workspace: só para membership ativa do PRÓPRIO usuário', async () => {
    // segundo workspace do owner
    const fixture2 = await createWorkspaceFixture(prisma, 'beta');
    const owner = await prisma.raw.user.findUnique({ where: { email: OWNER_EMAIL } });
    const membership2 = await createMembershipFixture(
      prisma,
      fixture2.workspaceId,
      owner!.id,
      fixture2.roles.member,
    );
    // membership de OUTRO usuário
    const otherId = await createUserFixture(prisma, 'other@veyra.test');
    const otherMembership = await createMembershipFixture(
      prisma,
      workspaceId,
      otherId,
      roles.member,
    );

    const session = extractSession(await login().expect(201));
    const switched = await request(http)
      .post('/api/auth/switch-workspace')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ membershipId: membership2 })
      .expect(201);
    expect(switched.body.activeMembership.workspaceId).toBe(fixture2.workspaceId);

    await request(http)
      .post('/api/auth/switch-workspace')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ membershipId: otherMembership })
      .expect(403);
  });

  it('FK composta: sessão não pode apontar para membership de outro usuário (ajuste #1)', async () => {
    const otherId = await createUserFixture(prisma, 'other@veyra.test');
    const otherMembership = await createMembershipFixture(
      prisma,
      workspaceId,
      otherId,
      roles.member,
    );
    const owner = await prisma.raw.user.findUnique({ where: { email: OWNER_EMAIL } });
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "RefreshToken" ("id", "userId", "tokenHash", "activeMembershipId", "expiresAt")
         VALUES (gen_random_uuid(), $1::uuid, 'hash-teste-fk', $2::uuid, now() + interval '1 day')`,
        owner!.id,
        otherMembership,
      ),
    ).rejects.toThrow(/foreign key|RefreshToken_userId_activeMembershipId_fkey/i);
  });

  it('logout revoga a sessão e limpa cookies; refresh posterior falha', async () => {
    const session = extractSession(await login().expect(201));
    const res = await request(http)
      .post('/api/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(201);
    const cleared = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cleared).toMatch(/veyra_access=;/);
    await request(http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .expect(401);
  });

  it('sem sessão: rotas privadas retornam 401', async () => {
    await request(http).get('/api/auth/me').expect(401);
    await request(http).get('/api/_test/readable').expect(401);
  });

  it('refresh concorrente do mesmo token: exatamente um vence; a família cai', async () => {
    const session = extractSession(await login().expect(201));
    const [a, b] = await Promise.all([
      request(http)
        .post('/api/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', session.cookieHeader),
      request(http)
        .post('/api/auth/refresh')
        .set('Origin', ORIGIN)
        .set('Cookie', session.cookieHeader),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 401]);
  });

  it('switch-workspace após logout falha (sessão morta não ressuscita via access token)', async () => {
    const session = extractSession(await login().expect(201));
    await request(http)
      .post('/api/auth/logout')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .expect(201);
    // access token antigo ainda no cookie, mas a sessão foi revogada
    await request(http)
      .post('/api/auth/switch-workspace')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf)
      .send({ membershipId: ownerMembershipId })
      .expect(401);
    await request(http).get('/api/auth/me').set('Cookie', session.cookieHeader).expect(401);
  });

  it('usuário suspenso: access token vivo e refresh param de funcionar na hora', async () => {
    const session = extractSession(await login().expect(201));
    const owner = await prisma.raw.user.findUnique({ where: { email: OWNER_EMAIL } });
    await prisma.raw.user.update({ where: { id: owner!.id }, data: { status: 'suspended' } });
    await request(http).get('/api/auth/me').set('Cookie', session.cookieHeader).expect(401);
    await request(http)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .expect(401);
  });

  it('workspace suspenso: a sessão perde acesso às rotas do workspace', async () => {
    const session = extractSession(await login().expect(201));
    await prisma.raw.workspace.update({
      where: { id: workspaceId },
      data: { status: 'suspended' },
    });
    await request(http).get('/api/auth/me').set('Cookie', session.cookieHeader).expect(401);
  });

  it('Referer malformado em mutação sem Origin → 403, não 500', async () => {
    await request(http)
      .post('/api/auth/login')
      .set('Referer', '::::')
      .send({ email: OWNER_EMAIL, password: TEST_PASSWORD })
      .expect(403);
  });

  it('token sem issuer/audience (assinado com o segredo certo) é rejeitado', async () => {
    const jwtService = app.get(JwtService);
    const noScope = await jwtService.signAsync(
      {
        sub: '00000000-0000-0000-0000-000000000000',
        email: 'x@x.test',
        membershipId: null,
        workspaceId: null,
        tokenVersion: null,
        sessionId: '00000000-0000-0000-0000-000000000000',
      },
      { expiresIn: 900 },
    );
    await request(http).get('/api/auth/me').set('Cookie', `veyra_access=${noScope}`).expect(401);
  });
});

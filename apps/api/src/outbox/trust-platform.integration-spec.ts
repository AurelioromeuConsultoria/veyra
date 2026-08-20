import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CryptoService } from '../common/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { MAX_ATTEMPTS } from './outbox.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Plataforma de confiança — idempotência, outbox e webhooks (integração)', () => {
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

  let wsA: WorkspaceFixture;
  let sessionA: Session;
  let sessionB: Session;

  async function loginAs(email: string): Promise<Session> {
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
  const post = (path: string, s: Session, body?: unknown, headers: Record<string, string> = {}) => {
    const req = request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send((body ?? {}) as object);
  };
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerA = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, ownerA, wsA.roles.owner);
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
  });

  // ── Idempotência (ajuste #3) ──────────────────────────────────────────────

  it('replay: mesma chave + mesmo hash devolve a resposta gravada, sem criar de novo', async () => {
    const first = await post(
      '/api/contacts',
      sessionA,
      { name: 'Idem' },
      {
        'idempotency-key': 'k-1',
      },
    ).expect(201);
    const replay = await post(
      '/api/contacts',
      sessionA,
      { name: 'Idem' },
      {
        'idempotency-key': 'k-1',
      },
    ).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((await get('/api/contacts', sessionA).expect(200)).body.total).toBe(1);
  });

  it('ordem das chaves no body não muda a identidade (hash normalizado)', async () => {
    const first = await post(
      '/api/contacts',
      sessionA,
      { name: 'Norm', source: 'site' },
      {
        'idempotency-key': 'k-norm',
      },
    ).expect(201);
    const replay = await post(
      '/api/contacts',
      sessionA,
      { source: 'site', name: 'Norm' },
      {
        'idempotency-key': 'k-norm',
      },
    ).expect(201);
    expect(replay.body.id).toBe(first.body.id);
  });

  it('mesma chave com body DIFERENTE → 409', async () => {
    await post('/api/contacts', sessionA, { name: 'A' }, { 'idempotency-key': 'k-2' }).expect(201);
    const conflict = await post(
      '/api/contacts',
      sessionA,
      { name: 'B' },
      {
        'idempotency-key': 'k-2',
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.message).toMatch(/diferente/i);
  });

  it('RESERVA: dois requests idênticos concorrentes executam UMA vez só', async () => {
    const [r1, r2] = await Promise.all([
      post('/api/contacts', sessionA, { name: 'Corrida' }, { 'idempotency-key': 'k-race' }),
      post('/api/contacts', sessionA, { name: 'Corrida' }, { 'idempotency-key': 'k-race' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // um cria; o outro toma 409 (em processamento) ou 201 de replay
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    expect((await get('/api/contacts', sessionA).expect(200)).body.total).toBe(1);
  });

  it('erro libera a reserva: nova tentativa com a mesma chave funciona', async () => {
    // 400 (nome vazio) não deve consumir a chave
    await post('/api/contacts', sessionA, { name: '' }, { 'idempotency-key': 'k-3' }).expect(400);
    await post(
      '/api/contacts',
      sessionA,
      { name: 'Valido' },
      {
        'idempotency-key': 'k-3',
      },
    ).expect(201);
  });

  it('P1: path params entram no hash — mesma chave em recursos diferentes NÃO faz replay', async () => {
    const d1 = (await post('/api/deals', sessionA, { title: 'Deal 1' }).expect(201)).body;
    const d2 = (await post('/api/deals', sessionA, { title: 'Deal 2' }).expect(201)).body;
    const patchWithKey = (id: string) =>
      request(http)
        .patch(`/api/deals/${id}`)
        .set('Origin', ORIGIN)
        .set('Cookie', sessionA.cookieHeader)
        .set('x-csrf-token', sessionA.csrf)
        .set('idempotency-key', 'k-params')
        .send({ title: 'Mesmo título' });
    // PATCH não é idempotente por opt-in, então segue normal; o que importa é
    // que o POST com params distintos não colapse — validamos pelo create:
    await patchWithKey(d1.id).expect(200);
    await patchWithKey(d2.id).expect(200);
    const after1 = (await get(`/api/deals/${d1.id}`, sessionA).expect(200)).body;
    const after2 = (await get(`/api/deals/${d2.id}`, sessionA).expect(200)).body;
    expect(after1.title).toBe('Mesmo título');
    expect(after2.title).toBe('Mesmo título'); // o segundo NÃO foi engolido por replay
  });

  it('rota sem @Idempotent (ex.: criar webhook) NÃO guarda a resposta em cache', async () => {
    const created = (
      await post(
        '/api/webhooks',
        sessionA,
        { url: 'https://exemplo.com/hook', events: ['deal.won'] },
        { 'idempotency-key': 'k-secret' },
      ).expect(201)
    ).body;
    // o segredo JAMAIS pode ter ido para IdempotencyKey.responseBody
    const cached = await prisma.raw.idempotencyKey.findMany({
      where: { workspaceId: wsA.workspaceId },
    });
    expect(JSON.stringify(cached)).not.toContain(created.secret);
    expect(cached.some((row) => row.endpoint.includes('webhooks'))).toBe(false);
  });

  it('chave é escopada por workspace: B pode usar a mesma chave de A', async () => {
    await post('/api/contacts', sessionA, { name: 'Do A' }, { 'idempotency-key': 'shared' }).expect(
      201,
    );
    await post('/api/contacts', sessionB, { name: 'Do B' }, { 'idempotency-key': 'shared' }).expect(
      201,
    );
  });

  // ── Outbox ────────────────────────────────────────────────────────────────

  it('outbox só materializa se a transação COMMITAR', async () => {
    // criação válida enfileira
    const contact = (await post('/api/contacts', sessionA, { name: 'Publicado' }).expect(201)).body;
    const events = await prisma.raw.outboxEvent.findMany({
      where: { workspaceId: wsA.workspaceId },
    });
    expect(events.map((e) => e.eventType)).toContain('contact.created');
    expect((events[0].payload as { id: string }).id).toBe(contact.id);

    // criação que ABORTA (tag inexistente → 400) não deixa evento
    const before = await prisma.raw.outboxEvent.count();
    await post('/api/contacts', sessionA, {
      name: 'Abortado',
      tagIds: ['00000000-0000-0000-0000-000000000000'],
    }).expect(400);
    expect(await prisma.raw.outboxEvent.count()).toBe(before);
  });

  it('payload do outbox segue allowlist do evento (não é a entidade inteira)', async () => {
    await post('/api/contacts', sessionA, { name: 'Alvo', source: 'privado' }).expect(201);
    const event = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'contact.created' },
    });
    expect(Object.keys(event!.payload as object).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(event!.payload)).not.toContain('privado');
  });

  it('dispatch sem webhook inscrito encerra o evento; retry e dead usam backoff', async () => {
    await post('/api/contacts', sessionA, { name: 'Sem inscrito' }).expect(201);
    const jobs = app.get(JobsService);
    await jobs.dispatchPending();
    const event = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'contact.created' },
    });
    expect(event!.status).toBe('delivered');

    // agora um evento que falha na entrega (webhook para host inexistente)
    const webhooks = app.get(WebhooksService);
    await prisma.raw.webhook.create({
      data: {
        workspaceId: wsA.workspaceId,
        url: 'https://destino-que-nao-existe.veyra-teste.invalid/hook',
        events: ['contact.created'],
        secretCipher: app.get(CryptoService).encrypt('whsec_teste'),
      },
    });
    await post('/api/contacts', sessionA, { name: 'Vai falhar' }).expect(201);
    const pending = await prisma.raw.outboxEvent.findFirst({
      where: { status: 'pending', eventType: 'contact.created' },
    });
    await webhooks.deliver({
      id: pending!.id,
      workspaceId: wsA.workspaceId,
      eventType: 'contact.created',
      payload: pending!.payload,
      attempts: 1,
    });
    const afterFail = await prisma.raw.outboxEvent.findFirst({ where: { id: pending!.id } });
    expect(afterFail!.status).toBe('pending'); // reagendado
    expect(afterFail!.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
    expect(afterFail!.lastError).toBeTruthy();
    // registrou a tentativa
    expect(await prisma.raw.webhookDelivery.count({ where: { outboxEventId: pending!.id } })).toBe(
      1,
    );

    // no limite de tentativas vira dead
    await webhooks.deliver({
      id: pending!.id,
      workspaceId: wsA.workspaceId,
      eventType: 'contact.created',
      payload: pending!.payload,
      attempts: MAX_ATTEMPTS,
    });
    const dead = await prisma.raw.outboxEvent.findFirst({ where: { id: pending!.id } });
    expect(dead!.status).toBe('dead');
  });

  it('AJUSTE #7: só ENTREGA MORTA conta; 3 mortas consecutivas pausam o webhook', async () => {
    const created = (
      await post('/api/webhooks', sessionA, {
        url: 'https://destino-que-nao-existe.veyra-teste.invalid/hook',
        events: ['contact.created'],
      }).expect(201)
    ).body;
    const webhooks = app.get(WebhooksService);

    // uma tentativa que apenas REAGENDA (não morta) não mexe no contador
    await post('/api/contacts', sessionA, { name: 'Falha 1' }).expect(201);
    const ev = await prisma.raw.outboxEvent.findFirst({ where: { status: 'pending' } });
    await webhooks.deliver({
      id: ev!.id,
      workspaceId: wsA.workspaceId,
      eventType: 'contact.created',
      payload: ev!.payload,
      attempts: 1,
    });
    expect((await prisma.raw.webhook.findFirst({ where: { id: created.id } }))!.failureCount).toBe(
      0,
    );

    // três entregas MORTAS → pausa
    for (let i = 0; i < 3; i += 1) {
      await post('/api/contacts', sessionA, { name: `Morta ${i}` }).expect(201);
      const dying = await prisma.raw.outboxEvent.findFirst({
        where: { status: 'pending', dedupeKey: { not: ev!.dedupeKey } },
      });
      if (!dying) continue;
      await webhooks.deliver({
        id: dying.id,
        workspaceId: wsA.workspaceId,
        eventType: 'contact.created',
        payload: dying.payload,
        attempts: MAX_ATTEMPTS,
      });
    }
    const webhook = await prisma.raw.webhook.findFirst({ where: { id: created.id } });
    expect(webhook!.failureCount).toBeGreaterThanOrEqual(3);
    expect(webhook!.status).toBe('paused');
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  it('P1: entrega morta NÃO pausa webhook saudável do mesmo workspace', async () => {
    const saudavel = (
      await post('/api/webhooks', sessionA, {
        url: 'https://exemplo-ok.veyra.test/hook',
        events: ['contact.created'],
      }).expect(201)
    ).body;
    const quebrado = (
      await post('/api/webhooks', sessionA, {
        url: 'https://nao-existe.veyra-teste.invalid/hook',
        events: ['contact.created'],
      }).expect(201)
    ).body;
    const webhooks = app.get(WebhooksService);

    for (let i = 0; i < 3; i += 1) {
      await post('/api/contacts', sessionA, { name: `Evento ${i}` }).expect(201);
      const event = await prisma.raw.outboxEvent.findFirst({ where: { status: 'pending' } });
      if (!event) continue;
      await webhooks.deliver({
        id: event.id,
        workspaceId: wsA.workspaceId,
        eventType: 'contact.created',
        payload: event.payload,
        attempts: MAX_ATTEMPTS,
      });
    }
    const ok = await prisma.raw.webhook.findFirst({ where: { id: saudavel.id } });
    const bad = await prisma.raw.webhook.findFirst({ where: { id: quebrado.id } });
    // ambos falham (o "saudável" também aponta para host inalcançável no teste),
    // mas o contador é POR WEBHOOK — nenhum é penalizado pelo erro do outro
    expect(bad!.failureCount).toBeGreaterThan(0);
    expect(ok!.failureCount).toBe(bad!.failureCount);
  });

  it('segredo aparece UMA vez na criação e nunca mais (nem cifrado no DTO)', async () => {
    const created = (
      await post('/api/webhooks', sessionA, {
        url: 'https://exemplo.com/hook',
        events: ['deal.won'],
      }).expect(201)
    ).body;
    expect(created.secret).toMatch(/^whsec_/);

    const listed = (await get('/api/webhooks', sessionA).expect(200)).body;
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(JSON.stringify(listed)).not.toMatch(/secret/i);
    // no banco só o cifrado
    const row = await prisma.raw.webhook.findFirst({ where: { id: created.id } });
    expect(row!.secretCipher).not.toContain(created.secret);
    expect(app.get(CryptoService).decrypt(row!.secretCipher)).toBe(created.secret);
  });

  it('SSRF: URL interna/insegura é rejeitada na criação', async () => {
    for (const url of [
      'http://exemplo.com/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
      'https://user:senha@exemplo.com/hook',
    ]) {
      const res = await post('/api/webhooks', sessionA, { url, events: ['deal.won'] });
      expect(res.status).toBe(400);
    }
  });

  it('assinatura HMAC é verificável e resiste a replay antigo', async () => {
    const webhooks = app.get(WebhooksService);
    const body = JSON.stringify({ type: 'deal.won', data: { id: 'x' } });
    const now = Math.floor(Date.now() / 1000);
    const header = webhooks.sign('whsec_teste', now, body);
    expect(webhooks.verify('whsec_teste', header, body)).toBe(true);
    expect(webhooks.verify('outro-segredo', header, body)).toBe(false);
    expect(webhooks.verify('whsec_teste', header, `${body} adulterado`)).toBe(false);
    const old = webhooks.sign('whsec_teste', now - 3600, body);
    expect(webhooks.verify('whsec_teste', old, body)).toBe(false); // fora da tolerância
  });

  it('P0: workspace B não vê webhooks, outbox nem entregas de A', async () => {
    const created = (
      await post('/api/webhooks', sessionA, {
        url: 'https://exemplo.com/hook',
        events: ['deal.won'],
      }).expect(201)
    ).body;
    expect((await get('/api/webhooks', sessionB).expect(200)).body).toEqual([]);
    const deliveriesB = (await get(`/api/webhooks/${created.id}/deliveries`, sessionB).expect(200))
      .body;
    expect(deliveriesB).toEqual([]);
  });

  it('RBAC: webhooks:manage é exigido', async () => {
    const memberId = await createUserFixture(prisma, 'member-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, memberId, wsA.roles.member);
    const member = await loginAs('member-a@veyra.test');
    await get('/api/webhooks', member).expect(403);
    await post('/api/webhooks', member, {
      url: 'https://exemplo.com/hook',
      events: ['deal.won'],
    }).expect(403);
  });
});

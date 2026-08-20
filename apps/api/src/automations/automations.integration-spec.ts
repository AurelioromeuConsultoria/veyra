import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CryptoService } from '../common/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_TRANSPORT } from '../webhooks/webhooks.service';
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
import { MAX_CHAIN_DEPTH } from './automations.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Automações (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const transportCalls: string[] = [];
  const fakeTransport = async (url: string) => {
    transportCalls.push(url);
    return { status: 200, durationMs: 2 };
  };

  beforeAll(async () => {
    app = await createTestApp([], [{ provide: WEBHOOK_TRANSPORT, useValue: fakeTransport }]);
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
  const post = (path: string, s: Session, body?: unknown) =>
    request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const del = (path: string, s: Session) =>
    request(http)
      .delete(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  const followUp = (extra: Record<string, unknown> = {}) => ({
    name: 'Follow-up de novo contato',
    trigger: 'contact.created',
    action: 'create_task',
    actionConfig: { title: 'Ligar para {{name}}', dueInDays: 1 },
    ...extra,
  });

  /** Roda o dispatcher até esvaziar a fila (a cadeia gera eventos novos). */
  const drain = async (max = 8) => {
    const jobs = app.get(JobsService);
    for (let i = 0; i < max; i += 1) {
      const { delivered } = await jobs.dispatchPending();
      if (delivered === 0) break;
    }
  };

  beforeEach(async () => {
    transportCalls.length = 0;
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

  // ── Caso ponta a ponta ────────────────────────────────────────────────────

  it('contato criado → tarefa de follow-up', async () => {
    await post('/api/automations', sessionA, followUp()).expect(201);
    await post('/api/contacts', sessionA, { name: 'Cliente Novo' }).expect(201);
    await drain();

    const tasks = await prisma.raw.task.findMany({ where: { workspaceId: wsA.workspaceId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Ligar para Cliente Novo');
    expect(tasks[0].dueAt).not.toBeNull();
    // a tarefa saiu de automação: o ator não é uma pessoa
    const activity = await prisma.raw.activity.findFirst({
      where: { taskId: tasks[0].id, type: 'task_created' },
    });
    expect(activity!.actorMembershipId).toBeNull();

    const execucoes = (await get('/api/automations/executions', sessionA).expect(200)).body;
    expect(execucoes).toHaveLength(1);
    expect(execucoes[0]).toMatchObject({ status: 'executed', automationName: followUp().name });
  });

  it('condição não atendida registra skipped e não cria tarefa', async () => {
    await post(
      '/api/automations',
      sessionA,
      followUp({ conditions: [{ field: 'name', op: 'contains', value: 'Premium' }] }),
    ).expect(201);
    await post('/api/contacts', sessionA, { name: 'Cliente Comum' }).expect(201);
    await drain();

    expect(await prisma.raw.task.count()).toBe(0);
    const execucoes = (await get('/api/automations/executions', sessionA).expect(200)).body;
    expect(execucoes[0]).toMatchObject({ status: 'skipped', reason: 'conditions_not_met' });
  });

  it('automação desabilitada não roda', async () => {
    await post('/api/automations', sessionA, followUp({ enabled: false })).expect(201);
    await post('/api/contacts', sessionA, { name: 'Ignorado' }).expect(201);
    await drain();
    expect(await prisma.raw.task.count()).toBe(0);
    expect(await prisma.raw.automationExecution.count()).toBe(0);
  });

  // ── Idempotência da reentrega ─────────────────────────────────────────────

  it('reentrega do outbox NÃO cria segunda tarefa', async () => {
    await post('/api/automations', sessionA, followUp()).expect(201);
    await post('/api/contacts', sessionA, { name: 'Reentrega' }).expect(201);
    await drain();
    expect(await prisma.raw.task.count()).toBe(1);

    // devolve o evento de contato para pending, como um retry faria
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'contact.created' },
      data: { status: 'pending', nextRetryAt: new Date(), claimToken: null, leaseExpiresAt: null },
    });
    await drain();

    // a execução é única por (automação, evento): nada rodou de novo
    expect(await prisma.raw.task.count()).toBe(1);
    expect(await prisma.raw.automationExecution.count()).toBe(1);
  });

  // ── Causalidade e laço ────────────────────────────────────────────────────

  it('causalidade fica em COLUNAS e não vaza no payload do webhook', async () => {
    await post('/api/automations', sessionA, followUp()).expect(201);
    await prisma.raw.webhook.create({
      data: {
        workspaceId: wsA.workspaceId,
        url: 'https://destino-ok.veyra.test/hook',
        events: ['task.created'],
        secretCipher: app.get(CryptoService).encrypt('whsec_teste'),
      },
    });
    await post('/api/contacts', sessionA, { name: 'Causal' }).expect(201);
    await drain();

    const evento = await prisma.raw.outboxEvent.findFirst({ where: { eventType: 'task.created' } });
    expect(evento!.depth).toBe(1);
    expect(evento!.chainId).toBeTruthy();
    expect(evento!.originAutomationId).toBeTruthy();
    // o payload entregue ao cliente não carrega topologia interna
    expect(Object.keys(evento!.payload as object).sort()).toEqual(['id', 'title']);

    const entrega = await prisma.raw.webhookDelivery.findFirst({
      where: { outboxEventId: evento!.id },
    });
    expect(entrega).toBeTruthy(); // o webhook recebeu
  });

  it('automação não reativa a si mesma', async () => {
    // gatilho e ação no MESMO tipo de evento: sem a guarda, laço infinito
    await post(
      '/api/automations',
      sessionA,
      followUp({
        name: 'Eco',
        trigger: 'task.created',
        actionConfig: { title: 'Eco de {{title}}', dueInDays: 1 },
      }),
    ).expect(201);
    await post('/api/tasks', sessionA, { title: 'Original' }).expect(201);
    await drain();

    // uma tarefa da automação sobre a original, e nada além disso
    const tasks = await prisma.raw.task.findMany({ orderBy: { createdAt: 'asc' } });
    expect(tasks.map((t) => t.title)).toEqual(['Original', 'Eco de Original']);
  });

  it(`duas automações em ping-pong param no teto de profundidade ${MAX_CHAIN_DEPTH}`, async () => {
    // A e B reagem ao mesmo evento e criam tarefas: cada uma reage ao evento da
    // OUTRA, então a guarda de auto-retrigger sozinha não conteria a cadeia
    for (const name of ['Ping', 'Pong']) {
      await post(
        '/api/automations',
        sessionA,
        followUp({
          name,
          trigger: 'task.created',
          actionConfig: { title: `${name} de {{title}}`, dueInDays: 1 },
        }),
      ).expect(201);
    }
    await post('/api/tasks', sessionA, { title: 'Semente' }).expect(201);
    await drain(12);

    const eventos = await prisma.raw.outboxEvent.findMany({ where: { eventType: 'task.created' } });
    // nenhum evento passa do teto…
    expect(Math.max(...eventos.map((e) => e.depth))).toBeLessThanOrEqual(MAX_CHAIN_DEPTH);
    // …e o corte deixou rastro na auditoria
    const corte = await prisma.raw.auditLog.findFirst({
      where: { action: 'automation.chain_capped' },
    });
    expect(corte).toBeTruthy();
    expect(corte!.actorType).toBe('system');
  });

  // ── P0: isolamento e RBAC ─────────────────────────────────────────────────

  it('P0: automação de um workspace não reage a evento do outro', async () => {
    await post('/api/automations', sessionA, followUp()).expect(201);
    await post('/api/contacts', sessionB, { name: 'Contato de B' }).expect(201);
    await drain();

    expect(await prisma.raw.task.count()).toBe(0);
    expect(await prisma.raw.automationExecution.count()).toBe(0);
  });

  it('P0: automação de A é invisível e inalcançável de B', async () => {
    const criada = (await post('/api/automations', sessionA, followUp()).expect(201)).body;
    expect((await get('/api/automations', sessionB).expect(200)).body).toEqual([]);
    await del(`/api/automations/${criada.id}`, sessionB).expect(404);
    await get('/api/automations/executions', sessionB).expect(200);
  });

  it('excluir automação preserva os eventos que ela originou', async () => {
    const criada = (await post('/api/automations', sessionA, followUp()).expect(201)).body;
    await post('/api/contacts', sessionA, { name: 'Antes da exclusão' }).expect(201);
    await drain();
    const antes = await prisma.raw.outboxEvent.count();

    await del(`/api/automations/${criada.id}`, sessionA).expect(200);
    // eventos continuam lá, só sem a referência
    expect(await prisma.raw.outboxEvent.count()).toBe(antes);
    const orfaos = await prisma.raw.outboxEvent.findMany({
      where: { eventType: 'task.created' },
    });
    expect(orfaos.every((e) => e.originAutomationId === null)).toBe(true);
  });

  it('RBAC: sem automations:manage não configura nem vê execuções', async () => {
    const memberId = await createUserFixture(prisma, 'member-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, memberId, wsA.roles.member);
    const member = await loginAs('member-a@veyra.test');

    await get('/api/automations', member).expect(403);
    await get('/api/automations/executions', member).expect(403);
    await post('/api/automations', member, followUp()).expect(403);
  });

  it('catálogo é FECHADO: gatilho e ação fora da lista são recusados', async () => {
    await post('/api/automations', sessionA, followUp({ trigger: 'contact.deleted' })).expect(400);
    await post('/api/automations', sessionA, followUp({ action: 'send_email' })).expect(400);
    // e nada de expressão arbitrária na condição
    await post(
      '/api/automations',
      sessionA,
      followUp({ conditions: [{ field: 'name', op: 'eval', value: 'x' }] }),
    ).expect(400);
  });
});

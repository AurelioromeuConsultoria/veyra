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
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Trabalho — tarefas, notas e timeline (integração)', () => {
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
  let guestA: Session;

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
  const patch = (path: string, s: Session, body: unknown) =>
    request(http)
      .patch(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send(body as object);
  const del = (path: string, s: Session) =>
    request(http)
      .delete(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
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
    const guestId = await createUserFixture(prisma, 'guest-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, guestId, wsA.roles.guest);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    guestA = await loginAs('guest-a@veyra.test');
  });

  it('tarefa: criar, listar por status, concluir (com Activity) e excluir', async () => {
    const deal = (await post('/api/deals', sessionA, { title: 'Deal com tarefa' }).expect(201))
      .body;
    const task = (
      await post('/api/tasks', sessionA, {
        title: 'Ligar para o cliente',
        dealId: deal.id,
        priority: 'high',
      }).expect(201)
    ).body;
    expect(task.status).toBe('open');

    expect((await get('/api/tasks', sessionA).expect(200)).body.total).toBe(1);
    expect((await get('/api/tasks?status=done', sessionA).expect(200)).body.total).toBe(0);

    const done = (await patch(`/api/tasks/${task.id}`, sessionA, { status: 'done' }).expect(200))
      .body;
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();

    const timeline = (await get(`/api/activities?dealId=${deal.id}`, sessionA).expect(200)).body;
    const types = timeline.items.map((a: { type: string }) => a.type);
    expect(types).toContain('task_created');
    expect(types).toContain('task_completed');

    await del(`/api/tasks/${task.id}`, sessionA).expect(200);
    expect((await get('/api/tasks?status=all', sessionA).expect(200)).body.total).toBe(0);
  });

  it('AJUSTE #6: nota emite note_added e note_deleted, SEM corpo no payload', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Alvo' }).expect(201)).body;
    const note = (
      await post('/api/notes', sessionA, {
        body: 'SEGREDO COMERCIAL que não pode vazar na timeline',
        contactId: contact.id,
      }).expect(201)
    ).body;
    expect(note.authorName).toBe('owner-a');

    let timeline = (await get(`/api/activities?contactId=${contact.id}`, sessionA).expect(200))
      .body;
    const added = timeline.items.find((a: { type: string }) => a.type === 'note_added');
    expect(added).toBeDefined();
    expect(added.payload).toEqual({});
    expect(JSON.stringify(timeline)).not.toContain('SEGREDO');

    await del(`/api/notes/${note.id}`, sessionA).expect(200);
    timeline = (await get(`/api/activities?contactId=${contact.id}`, sessionA).expect(200)).body;
    expect(timeline.items.some((a: { type: string }) => a.type === 'note_deleted')).toBe(true);
  });

  it('AJUSTE #6: contact_created é emitido de fato pelo service de contatos', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Novo lead' }).expect(201)).body;
    const timeline = (await get(`/api/activities?contactId=${contact.id}`, sessionA).expect(200))
      .body;
    expect(timeline.items).toHaveLength(1);
    expect(timeline.items[0].type).toBe('contact_created');
    expect(timeline.items[0].payload).toEqual({ name: 'Novo lead' });
  });

  it('nota exige exatamente um alvo; alvo cross-workspace é rejeitado', async () => {
    await post('/api/notes', sessionA, { body: 'sem alvo' }).expect(400);
    const contactB = (await post('/api/contacts', sessionB, { name: 'De B' }).expect(201)).body;
    await post('/api/notes', sessionA, { body: 'x', contactId: contactB.id }).expect(400);
    await get('/api/notes', sessionA).expect(400); // list também exige um alvo
  });

  it('RBAC: guest lê tarefas/notas mas não escreve', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Alvo' }).expect(201)).body;
    await get(`/api/notes?contactId=${contact.id}`, guestA).expect(200);
    await get('/api/tasks', guestA).expect(200);
    await post('/api/tasks', guestA, { title: 'Nope' }).expect(403);
    await post('/api/notes', guestA, { body: 'Nope', contactId: contact.id }).expect(403);
  });

  it('P0: workspace B não vê tarefas nem notas de A', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Do A' }).expect(201)).body;
    const task = (await post('/api/tasks', sessionA, { title: 'Tarefa de A' }).expect(201)).body;
    await post('/api/notes', sessionA, { body: 'Nota de A', contactId: contact.id }).expect(201);

    expect((await get('/api/tasks?status=all', sessionB).expect(200)).body.total).toBe(0);
    await patch(`/api/tasks/${task.id}`, sessionB, { title: 'invadida' }).expect(404);
    expect((await get(`/api/notes?contactId=${contact.id}`, sessionB).expect(200)).body).toEqual(
      [],
    );
  });
});

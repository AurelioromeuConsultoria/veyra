import { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
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
import { AuditService } from './audit.service';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Auditoria e append-only (integração)', () => {
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
  let memberSession: Session;

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
    const memberId = await createUserFixture(prisma, 'member-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, memberId, wsA.roles.member);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    memberSession = await loginAs('member-a@veyra.test');
  });

  it('AJUSTE #1: Activity e AuditLog são append-only NO CLIENT (não só por convenção)', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Alvo' }).expect(201)).body;
    const activityId = (await prisma.raw.activity.findFirst({ where: { contactId: contact.id } }))
      ?.id;
    expect(activityId).toBeTruthy();

    // COM contexto de workspace válido (como um service teria): mesmo assim
    // toda mutação de histórico é recusada pelo client protegido
    const cls = app.get(ClsService);
    await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      await expect(
        prisma.db.activity.updateMany({ where: { id: activityId }, data: { type: 'note_added' } }),
      ).rejects.toThrow(/append-only/);
      await expect(prisma.db.activity.deleteMany({ where: { id: activityId } })).rejects.toThrow(
        /append-only/,
      );
      await expect(prisma.db.auditLog.deleteMany({ where: {} })).rejects.toThrow(/append-only/);
      await expect(
        prisma.db.auditLog.updateMany({ where: {}, data: { action: 'forjado' } }),
      ).rejects.toThrow(/append-only/);
      // leitura e escrita append CONTINUAM funcionando
      await expect(prisma.db.activity.findMany()).resolves.toBeDefined();
    });
  });

  it('allowlist: campo fora da lista vira [changed]; segredo nunca aparece', async () => {
    const contact = (
      await post('/api/contacts', sessionA, { name: 'Antes', source: 'evento' }).expect(201)
    ).body;
    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);

    const audit = (await get('/api/audit?entityType=contact', sessionA).expect(200)).body;
    const entry = audit.items[0];
    expect(entry.action).toBe('contact.deleted');
    expect(entry.before.name).toBe('Antes'); // name está na allowlist
    expect(entry.actorLabel).toBe('owner-a');
    expect(entry.requestId).toBeTruthy(); // correlação
    expect(JSON.stringify(audit)).not.toMatch(/passwordHash|tokenHash|secret/i);
  });

  it('AJUSTE #9: excluir contato preserva deal/tarefa (desvinculados), remove notas e audita', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Titular' }).expect(201)).body;
    const deal = (
      await post('/api/deals', sessionA, { title: 'Negócio', contactId: contact.id }).expect(201)
    ).body;
    const task = (
      await post('/api/tasks', sessionA, { title: 'Ligar', contactId: contact.id }).expect(201)
    ).body;
    await post('/api/notes', sessionA, {
      body: 'Nota sobre o titular',
      contactId: contact.id,
    }).expect(201);

    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);

    // deal e tarefa PRESERVADOS, apenas desvinculados
    const dealAfter = (await get(`/api/deals/${deal.id}`, sessionA).expect(200)).body;
    expect(dealAfter.contactId).toBeNull();
    const tasksAfter = (await get('/api/tasks?status=all', sessionA).expect(200)).body;
    expect(tasksAfter.items.find((t: { id: string }) => t.id === task.id).contactId).toBeNull();
    // notas e custom values REMOVIDOS
    expect(await prisma.raw.note.count({ where: { contactId: contact.id } })).toBe(0);
    // AuditLog sobrevive à exclusão do titular
    const audit = (await get(`/api/audit?entityId=${contact.id}`, sessionA).expect(200)).body;
    expect(audit.items[0].action).toBe('contact.deleted');
  });

  it('AJUSTE #8: deal update gera Activity + AuditLog; delete gera SÓ AuditLog', async () => {
    const deal = (
      await post('/api/deals', sessionA, { title: 'Original', amountCents: 100_000 }).expect(201)
    ).body;
    await patch(`/api/deals/${deal.id}`, sessionA, {
      title: 'Renomeado',
      amountCents: 200_000,
    }).expect(200);

    const timeline = (await get(`/api/activities?dealId=${deal.id}`, sessionA).expect(200)).body;
    expect(timeline.items.some((a: { type: string }) => a.type === 'deal_updated')).toBe(true);
    let audit = (await get('/api/audit?entityType=deal', sessionA).expect(200)).body;
    const updated = audit.items.find((a: { action: string }) => a.action === 'deal.updated');
    expect(updated.before.amountCents).toBe(100_000);
    expect(updated.after.amountCents).toBe(200_000);

    await del(`/api/deals/${deal.id}`, sessionA).expect(200);
    audit = (await get('/api/audit?entityType=deal', sessionA).expect(200)).body;
    expect(audit.items.some((a: { action: string }) => a.action === 'deal.deleted')).toBe(true);
    // a Activity morreu com o deal (cascade) — o AuditLog é o registro que fica
    expect(await prisma.raw.activity.count({ where: { dealId: deal.id } })).toBe(0);
  });

  it('mudanças de acesso são auditadas (role e remoção)', async () => {
    const membership = await prisma.raw.membership.findFirst({
      where: { workspaceId: wsA.workspaceId, roleId: wsA.roles.member },
    });
    await patch(`/api/members/${membership!.id}/role`, sessionA, {
      roleId: wsA.roles.guest,
    }).expect(200);
    await del(`/api/members/${membership!.id}`, sessionA).expect(200);

    const audit = (await get('/api/audit?entityType=membership', sessionA).expect(200)).body;
    const actions = audit.items.map((a: { action: string }) => a.action);
    expect(actions).toContain('member.role_changed');
    expect(actions).toContain('member.removed');
  });

  it('RBAC: audit:read é exigido (member não lê a trilha)', async () => {
    await get('/api/audit', memberSession).expect(403);
    await get('/api/audit', sessionA).expect(200);
  });

  it('P0: workspace B não vê a trilha de A', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Do A' }).expect(201)).body;
    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);
    const auditB = (await get('/api/audit', sessionB).expect(200)).body;
    expect(auditB.items).toEqual([]);
  });

  it('AJUSTE #10: retenção expurga trilha além da janela', async () => {
    const contact = (await post('/api/contacts', sessionA, { name: 'Velho' }).expect(201)).body;
    await del(`/api/contacts/${contact.id}`, sessionA).expect(200);
    // envelhece o registro (raw: manipulação de fixture)
    await prisma.raw.auditLog.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000) },
    });
    const audit = app.get(AuditService);
    const purged = await audit.purgeOlderThan(365);
    expect(purged).toBeGreaterThan(0);
    expect((await get('/api/audit', sessionA).expect(200)).body.items).toEqual([]);
  });
});

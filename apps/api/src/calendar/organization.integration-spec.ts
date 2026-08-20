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

const HOJE = new Date('2026-09-01T13:00:00.000Z');
const iso = (offsetMinutes: number) =>
  new Date(HOJE.getTime() + offsetMinutes * 60_000).toISOString();
const JANELA = `from=${encodeURIComponent(iso(-24 * 60))}&to=${encodeURIComponent(iso(24 * 60))}`;

describe('Organização — agenda e notificações (integração)', () => {
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
  let wsB: WorkspaceFixture;
  let sessionA: Session;
  let sessionB: Session;
  let sessionColega: Session;
  let membershipOwnerA: string;
  let membershipColega: string;
  let contactA: string;

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
  const patch = (path: string, s: Session, body?: unknown) =>
    request(http)
      .patch(path)
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

  const evento = (extra: Record<string, unknown> = {}) => ({
    title: 'Reunião de alinhamento',
    startAt: iso(60),
    endAt: iso(120),
    ...extra,
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerA = await createUserFixture(prisma, 'owner-a@veyra.test');
    membershipOwnerA = await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      ownerA,
      wsA.roles.owner,
    );
    const colega = await createUserFixture(prisma, 'colega@veyra.test');
    membershipColega = await createMembershipFixture(
      prisma,
      wsA.workspaceId,
      colega,
      wsA.roles.member,
    );
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionColega = await loginAs('colega@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    contactA = (await post('/api/contacts', sessionA, { name: 'Cliente A' }).expect(201)).body.id;
  });

  // ── Agenda ────────────────────────────────────────────────────────────────

  it('cria evento com organizador implícito e o devolve na janela', async () => {
    const criado = (
      await post('/api/calendar/events', sessionA, evento({ contactId: contactA })).expect(201)
    ).body;
    expect(criado.organizerMembershipId).toBe(membershipOwnerA);
    expect(criado.organizerName).toBe('owner-a');
    expect(criado.contactName).toBe('Cliente A');

    const lista = (await get(`/api/calendar/events?${JANELA}`, sessionA).expect(200)).body;
    expect(lista.map((e: { id: string }) => e.id)).toEqual([criado.id]);
  });

  it('janela devolve só o que INTERSECTA o período', async () => {
    const dentro = (await post('/api/calendar/events', sessionA, evento()).expect(201)).body;
    // evento daqui a uma semana fica fora da janela de 24h
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ title: 'Longe', startAt: iso(7 * 24 * 60), endAt: iso(7 * 24 * 60 + 60) }),
    ).expect(201);
    // evento que COMEÇA antes da janela e termina dentro dela: intersecta
    const atravessa = (
      await post(
        '/api/calendar/events',
        sessionA,
        evento({ title: 'Atravessa', startAt: iso(-25 * 60), endAt: iso(-23 * 60) }),
      ).expect(201)
    ).body;

    const lista = (await get(`/api/calendar/events?${JANELA}`, sessionA).expect(200)).body;
    const ids = lista.map((e: { id: string }) => e.id);
    expect(ids).toContain(dentro.id);
    expect(ids).toContain(atravessa.id);
    expect(ids).toHaveLength(2);
  });

  it('término antes do início é recusado pelo contrato (400)', async () => {
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ startAt: iso(120), endAt: iso(60) }),
    ).expect(400);
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ startAt: iso(60), endAt: iso(60) }), // duração zero também não
    ).expect(400);
  });

  it('CHECK do banco recusa janela invertida mesmo por SQL cru', async () => {
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "CalendarEvent"
           ("id", "workspaceId", "title", "startAt", "endAt", "organizerMembershipId", "updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, 'Invertido', $2::timestamptz, $3::timestamptz, $4::uuid, now())`,
        wsA.workspaceId,
        iso(120),
        iso(60),
        membershipOwnerA,
      ),
    ).rejects.toThrow();
  });

  it('PATCH com uma ponta só não pode inverter o evento (400 claro, não erro do banco)', async () => {
    const criado = (await post('/api/calendar/events', sessionA, evento()).expect(201)).body;
    // só startAt, depois do endAt existente
    const res = await patch(`/api/calendar/events/${criado.id}`, sessionA, { startAt: iso(300) });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/depois do início/i);
  });

  it('PATCH move o evento e preserva a outra ponta', async () => {
    const criado = (await post('/api/calendar/events', sessionA, evento()).expect(201)).body;
    const movido = (
      await patch(`/api/calendar/events/${criado.id}`, sessionA, { startAt: iso(90) }).expect(200)
    ).body;
    expect(movido.startAt).toBe(iso(90));
    expect(movido.endAt).toBe(criado.endAt);
  });

  it('evento agendado entra na timeline do contato', async () => {
    await post('/api/calendar/events', sessionA, evento({ contactId: contactA })).expect(201);
    const timeline = (
      await get(`/api/activities?contactId=${contactA}&limit=10`, sessionA).expect(200)
    ).body;
    expect(timeline.items.map((a: { type: string }) => a.type)).toContain('event_scheduled');
  });

  // ── P0: isolamento ────────────────────────────────────────────────────────

  it('P0: evento de A é invisível e inalcançável de B', async () => {
    const criado = (await post('/api/calendar/events', sessionA, evento()).expect(201)).body;
    expect((await get(`/api/calendar/events?${JANELA}`, sessionB).expect(200)).body).toEqual([]);
    await get(`/api/calendar/events/${criado.id}`, sessionB).expect(404);
    await patch(`/api/calendar/events/${criado.id}`, sessionB, { title: 'Invadido' }).expect(404);
    await del(`/api/calendar/events/${criado.id}`, sessionB).expect(404);
  });

  it('P0: organizador, contato e oportunidade de outro workspace são recusados', async () => {
    const membershipB = await prisma.raw.membership.findFirst({
      where: { workspaceId: wsB.workspaceId },
    });
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ organizerMembershipId: membershipB!.id }),
    ).expect(400);
    const contactB = (await post('/api/contacts', sessionB, { name: 'Cliente B' }).expect(201)).body
      .id;
    await post('/api/calendar/events', sessionA, evento({ contactId: contactB })).expect(400);
  });

  // ── Notificações ──────────────────────────────────────────────────────────

  it('evento para OUTRO organizador notifica uma única vez, mesmo com retry', async () => {
    const key = { 'idempotency-key': 'ev-1' };
    const body = evento({ organizerMembershipId: membershipColega });
    const primeiro = await post('/api/calendar/events', sessionA, body, key).expect(201);
    const replay = await post('/api/calendar/events', sessionA, body, key).expect(201);
    expect(replay.body.id).toBe(primeiro.body.id);

    const caixa = (await get('/api/notifications', sessionColega).expect(200)).body;
    expect(caixa.items).toHaveLength(1);
    expect(caixa.items[0].type).toBe('calendar_event_scheduled');
    expect(caixa.items[0].payload.title).toBe('Reunião de alinhamento');
    expect(caixa.unreadCount).toBe(1);
  });

  it('mesmo SEM idempotency-key, o dedupeKey impede notificação repetida do mesmo fato', async () => {
    const criado = (
      await post(
        '/api/calendar/events',
        sessionA,
        evento({ organizerMembershipId: membershipColega }),
      ).expect(201)
    ).body;
    // segunda emissão do MESMO fato (o que um worker em retry faria)
    const notifications = app.get(
      (await import('../notifications/notifications.service')).NotificationsService,
    );
    await notifications.emit(
      prisma.raw,
      wsA.workspaceId,
      membershipColega,
      'calendar_event_scheduled',
      { title: 'Reunião de alinhamento', startAt: iso(60) },
      `calendar_event_scheduled:${criado.id}:${membershipColega}`,
    );
    expect((await get('/api/notifications', sessionColega).expect(200)).body.items).toHaveLength(1);
  });

  it('quem cria o próprio evento não se autonotifica', async () => {
    await post('/api/calendar/events', sessionA, evento()).expect(201);
    expect((await get('/api/notifications', sessionA).expect(200)).body.items).toEqual([]);
  });

  it('atribuir conversa a outra pessoa notifica quem recebeu', async () => {
    const conv = (
      await post('/api/conversations', sessionA, {
        subject: 'Suporte',
        contactId: contactA,
      }).expect(201)
    ).body;
    await patch(`/api/conversations/${conv.id}`, sessionA, {
      assigneeMembershipId: membershipColega,
    }).expect(200);

    const caixa = (await get('/api/notifications', sessionColega).expect(200)).body;
    expect(caixa.items.map((n: { type: string }) => n.type)).toEqual(['conversation_assigned']);
    expect(caixa.items[0].payload.subject).toBe('Suporte');
  });

  it('caixa é PESSOAL: ninguém lê nem marca a notificação de outro membro', async () => {
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ organizerMembershipId: membershipColega }),
    ).expect(201);
    const daColega = (await get('/api/notifications', sessionColega).expect(200)).body.items[0];

    // o Owner do MESMO workspace não vê a caixa da colega…
    expect((await get('/api/notifications', sessionA).expect(200)).body.items).toEqual([]);
    // …nem consegue marcar como lida (404: não revela existência)
    await patch(`/api/notifications/${daColega.id}/read`, sessionA).expect(404);
    // e a dona marca normalmente
    await patch(`/api/notifications/${daColega.id}/read`, sessionColega).expect(200);
    const depois = (await get('/api/notifications', sessionColega).expect(200)).body;
    expect(depois.items[0].readAt).not.toBeNull();
    expect(depois.unreadCount).toBe(0);
  });

  it('unreadOnly e read-all', async () => {
    for (let i = 0; i < 2; i += 1) {
      await post(
        '/api/calendar/events',
        sessionA,
        evento({ title: `Evento ${i}`, organizerMembershipId: membershipColega }),
      ).expect(201);
    }
    expect(
      (await get('/api/notifications?unreadOnly=true', sessionColega).expect(200)).body.items,
    ).toHaveLength(2);
    expect((await post('/api/notifications/read-all', sessionColega).expect(201)).body.marked).toBe(
      2,
    );
    expect(
      (await get('/api/notifications?unreadOnly=true', sessionColega).expect(200)).body.items,
    ).toEqual([]);
  });

  it('P0: notificação não vaza entre workspaces', async () => {
    await post(
      '/api/calendar/events',
      sessionA,
      evento({ organizerMembershipId: membershipColega }),
    ).expect(201);
    expect((await get('/api/notifications', sessionB).expect(200)).body.items).toEqual([]);
  });

  // ── RBAC ──────────────────────────────────────────────────────────────────

  it('RBAC: Guest lê agenda mas não escreve', async () => {
    const guestId = await createUserFixture(prisma, 'guest-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, guestId, wsA.roles.guest);
    const guest = await loginAs('guest-a@veyra.test');

    await get(`/api/calendar/events?${JANELA}`, guest).expect(200);
    await post('/api/calendar/events', guest, evento()).expect(403);

    const criado = (await post('/api/calendar/events', sessionA, evento()).expect(201)).body;
    await patch(`/api/calendar/events/${criado.id}`, guest, { title: 'Não' }).expect(403);
    await del(`/api/calendar/events/${criado.id}`, guest).expect(403);
    // a caixa pessoal, por outro lado, é de todo mundo autenticado
    await get('/api/notifications', guest).expect(200);
  });
});

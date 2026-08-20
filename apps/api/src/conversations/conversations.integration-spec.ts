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
import { ClsService } from 'nestjs-cls';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Conversas — inbox, mensagens e timeline (integração)', () => {
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
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const ownerA = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, ownerA, wsA.roles.owner);
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    contactA = (await post('/api/contacts', sessionA, { name: 'Cliente A' }).expect(201)).body.id;
  });

  // ── Canal interno (ADR-023) ───────────────────────────────────────────────

  it('workspace nasce com exatamente um canal interno e o banco recusa um segundo', async () => {
    const channels = await prisma.raw.channel.findMany({ where: { workspaceId: wsA.workspaceId } });
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ type: 'internal', systemMark: true });

    // a invariante é do BANCO, não do service: segundo canal de sistema explode
    await expect(
      prisma.raw.channel.create({
        data: {
          workspaceId: wsA.workspaceId,
          type: 'internal',
          name: 'Outro',
          systemMark: true,
        },
      }),
    ).rejects.toThrow();
  });

  it('systemMark=false é recusado pelo CHECK (derrotaria o unique parcial)', async () => {
    await expect(
      prisma.raw.channel.create({
        data: {
          workspaceId: wsA.workspaceId,
          type: 'internal',
          name: 'Falso',
          systemMark: false,
        },
      }),
    ).rejects.toThrow();
  });

  it('canal de sistema só pode ser interno (CHECK cobre o tipo)', async () => {
    await expect(
      prisma.raw.channel.create({
        data: {
          workspaceId: wsA.workspaceId,
          type: 'email',
          name: 'E-mail',
          systemMark: true,
        },
      }),
    ).rejects.toThrow();
  });

  it('conversa criada usa o canal interno do PRÓPRIO workspace', async () => {
    const created = (
      await post('/api/conversations', sessionA, { contactId: contactA }).expect(201)
    ).body;
    expect(created.channelType).toBe('internal');
    const row = await prisma.raw.conversation.findFirst({ where: { id: created.id } });
    const channel = await prisma.raw.channel.findFirst({ where: { id: row!.channelId } });
    expect(channel!.workspaceId).toBe(wsA.workspaceId);
  });

  it('FK TRIPLA: mensagem não pode usar canal diferente do canal da conversa', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    // segundo canal LEGÍTIMO do mesmo workspace (sem marca de sistema, como um
    // canal externo futuro seria)
    const outroCanal = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'email', name: 'E-mail' },
    });

    // SQL CRU, contornando qualquer validação de service: o BANCO precisa
    // recusar mensagem que aponta para a conversa A usando o canal B
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "Message"
           ("id", "workspaceId", "conversationId", "channelId", "direction", "authorType", "body")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'outbound', 'user', 'incoerente')`,
        wsA.workspaceId,
        conv.id,
        outroCanal.id,
      ),
    ).rejects.toThrow();

    // e o caminho coerente (canal da própria conversa) passa
    const row = await prisma.raw.conversation.findFirst({ where: { id: conv.id } });
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "Message"
           ("id", "workspaceId", "conversationId", "channelId", "direction", "authorType", "body")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'outbound', 'user', 'coerente')`,
        wsA.workspaceId,
        conv.id,
        row!.channelId,
      ),
    ).resolves.toBe(1);
  });

  // ── P0: isolamento cross-workspace ────────────────────────────────────────

  it('P0: conversa e mensagens de A são invisíveis e inalcançáveis de B', async () => {
    const conversation = (
      await post('/api/conversations', sessionA, {
        contactId: contactA,
        subject: 'Proposta',
      }).expect(201)
    ).body;
    await post(`/api/conversations/${conversation.id}/messages`, sessionA, {
      direction: 'outbound',
      body: 'Segue a proposta',
    }).expect(201);

    // listagem de B não enxerga
    const listB = await get('/api/conversations?status=all', sessionB).expect(200);
    expect(listB.body.items).toEqual([]);
    // acesso direto por id é 404, não 403 (não revela existência)
    await get(`/api/conversations/${conversation.id}`, sessionB).expect(404);
    await get(`/api/conversations/${conversation.id}/messages`, sessionB).expect(404);
    await post(`/api/conversations/${conversation.id}/messages`, sessionB, {
      direction: 'outbound',
      body: 'Intruso',
    }).expect(404);
    await patch(`/api/conversations/${conversation.id}`, sessionB, { status: 'closed' }).expect(
      404,
    );
  });

  it('P0: contato de OUTRO workspace não pode ser vinculado a uma conversa', async () => {
    const contactB = (await post('/api/contacts', sessionB, { name: 'Cliente B' }).expect(201)).body
      .id;
    await post('/api/conversations', sessionA, { contactId: contactB }).expect(400);
  });

  it('P0: responsável de OUTRO workspace é recusado', async () => {
    const membershipB = await prisma.raw.membership.findFirst({
      where: { workspaceId: wsB.workspaceId },
    });
    await post('/api/conversations', sessionA, {
      contactId: contactA,
      assigneeMembershipId: membershipB!.id,
    }).expect(400);
  });

  // ── Inbox ─────────────────────────────────────────────────────────────────

  it('lastMessageAt é preenchido já na criação — keyset sem caso especial de null', async () => {
    const created = (await post('/api/conversations', sessionA, {}).expect(201)).body;
    expect(created.lastMessageAt).toBeTruthy();
    const row = await prisma.raw.conversation.findFirst({ where: { id: created.id } });
    expect(row!.lastMessageAt).not.toBeNull();
  });

  it('inbox ordena por lastMessageAt desc e pagina por cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const conv = (
        await post('/api/conversations', sessionA, { subject: `Assunto ${i}` }).expect(201)
      ).body;
      ids.push(conv.id);
    }
    // mensagem na PRIMEIRA conversa a joga para o topo do inbox
    await post(`/api/conversations/${ids[0]}/messages`, sessionA, {
      direction: 'outbound',
      body: 'oi',
    }).expect(201);

    const page1 = await get('/api/conversations?limit=2', sessionA).expect(200);
    expect(page1.body.items[0].id).toBe(ids[0]);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await get(
      `/api/conversations?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
      sessionA,
    ).expect(200);
    const seen = [...page1.body.items, ...page2.body.items].map((c: { id: string }) => c.id);
    expect(new Set(seen).size).toBe(3); // sem repetição entre páginas
  });

  it('cursor corrompido vira 400, não 500', async () => {
    await get('/api/conversations?cursor=NAO-EH-CURSOR', sessionA).expect(400);
  });

  it('filtra por status e por responsável', async () => {
    const aberta = (await post('/api/conversations', sessionA, { subject: 'Aberta' }).expect(201))
      .body;
    const fechada = (await post('/api/conversations', sessionA, { subject: 'Fechada' }).expect(201))
      .body;
    await patch(`/api/conversations/${fechada.id}`, sessionA, { status: 'closed' }).expect(200);

    const abertas = await get('/api/conversations?status=open', sessionA).expect(200);
    expect(abertas.body.items.map((c: { id: string }) => c.id)).toEqual([aberta.id]);
    const todas = await get('/api/conversations?status=all', sessionA).expect(200);
    expect(todas.body.items).toHaveLength(2);
  });

  // ── Mensagens ─────────────────────────────────────────────────────────────

  it('mensagem manual nos dois sentidos: autor é derivado da direção', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    const saida = (
      await post(`/api/conversations/${conv.id}/messages`, sessionA, {
        direction: 'outbound',
        body: 'Bom dia',
      }).expect(201)
    ).body;
    expect(saida.authorType).toBe('user');
    expect(saida.authorName).toBe('owner-a');

    const entrada = (
      await post(`/api/conversations/${conv.id}/messages`, sessionA, {
        direction: 'inbound',
        body: 'Bom dia, tudo bem?',
      }).expect(201)
    ).body;
    expect(entrada.authorType).toBe('contact');
    expect(entrada.authorName).toBe('Cliente A');

    const rows = await prisma.raw.message.findMany({ where: { conversationId: conv.id } });
    // o canal da mensagem vem da conversa, nunca do cliente
    expect(new Set(rows.map((r) => r.channelId)).size).toBe(1);
  });

  it('mensagem de entrada exige contato na conversa', async () => {
    const semContato = (await post('/api/conversations', sessionA, {}).expect(201)).body;
    await post(`/api/conversations/${semContato.id}/messages`, sessionA, {
      direction: 'inbound',
      body: 'de quem?',
    }).expect(400);
  });

  it('mensagem atualiza lastMessageAt e reabre conversa fechada', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    await patch(`/api/conversations/${conv.id}`, sessionA, { status: 'closed' }).expect(200);
    await post(`/api/conversations/${conv.id}/messages`, sessionA, {
      direction: 'inbound',
      body: 'voltei',
    }).expect(201);

    const reaberta = (await get(`/api/conversations/${conv.id}`, sessionA).expect(200)).body;
    expect(reaberta.status).toBe('open');
    expect(new Date(reaberta.lastMessageAt).getTime()).toBeGreaterThan(
      new Date(conv.lastMessageAt).getTime() - 1,
    );
  });

  it('mensagens vêm da mais recente para a mais antiga, com cursor', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    for (let i = 0; i < 3; i += 1) {
      await post(`/api/conversations/${conv.id}/messages`, sessionA, {
        direction: 'outbound',
        body: `msg ${i}`,
      }).expect(201);
    }
    const page = await get(`/api/conversations/${conv.id}/messages?limit=2`, sessionA).expect(200);
    expect(page.body.items.map((m: { body: string }) => m.body)).toEqual(['msg 2', 'msg 1']);
    expect(page.body.nextCursor).toBeTruthy();
    const older = await get(
      `/api/conversations/${conv.id}/messages?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`,
      sessionA,
    ).expect(200);
    expect(older.body.items.map((m: { body: string }) => m.body)).toEqual(['msg 0']);
  });

  it('Message é append-only: o client protegido recusa update e delete', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    const msg = (
      await post(`/api/conversations/${conv.id}/messages`, sessionA, {
        direction: 'outbound',
        body: 'imutável',
      }).expect(201)
    ).body;

    // entra no contexto de workspace como uma request faria — fora dele o
    // client protegido barra antes, por falta de tenant
    const cls = app.get(ClsService);
    await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      await expect(
        prisma.db.message.updateMany({ where: { id: msg.id }, data: { body: 'editada' } }),
      ).rejects.toThrow(/append-only/i);
      await expect(prisma.db.message.deleteMany({ where: { id: msg.id } })).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  // ── Idempotência (ajuste aprovado) ────────────────────────────────────────

  it('@Idempotent: duplo clique não duplica mensagem nem Activity', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    const key = { 'idempotency-key': 'msg-1' };
    const first = await post(
      `/api/conversations/${conv.id}/messages`,
      sessionA,
      { direction: 'outbound', body: 'clique duplo' },
      key,
    ).expect(201);
    const replay = await post(
      `/api/conversations/${conv.id}/messages`,
      sessionA,
      { direction: 'outbound', body: 'clique duplo' },
      key,
    ).expect(201);

    expect(replay.body.id).toBe(first.body.id);
    expect(await prisma.raw.message.count({ where: { conversationId: conv.id } })).toBe(1);
    expect(
      await prisma.raw.activity.count({ where: { conversationId: conv.id, type: 'message_sent' } }),
    ).toBe(1);
  });

  it('path params entram no hash: a mesma chave em outra conversa dá 409, não replay', async () => {
    const a = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    const b = (await post('/api/conversations', sessionA, {}).expect(201)).body;
    const key = { 'idempotency-key': 'mesma-chave' };
    await post(
      `/api/conversations/${a.id}/messages`,
      sessionA,
      { direction: 'outbound', body: 'oi' },
      key,
    ).expect(201);
    // corpo idêntico, conversa diferente: como o path entra no hash, o servidor
    // detecta a colisão de chave e RECUSA (409) em vez de devolver a resposta da
    // outra conversa. Silenciar isso com replay entregaria a mensagem errada.
    await post(
      `/api/conversations/${b.id}/messages`,
      sessionA,
      { direction: 'outbound', body: 'oi' },
      key,
    ).expect(409);
    expect(await prisma.raw.message.count()).toBe(1);
    expect(await prisma.raw.message.count({ where: { conversationId: b.id } })).toBe(0);
  });

  // ── Timeline ──────────────────────────────────────────────────────────────

  it('mensagem aparece na timeline do contato — SEM o corpo (LGPD)', async () => {
    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    await post(`/api/conversations/${conv.id}/messages`, sessionA, {
      direction: 'outbound',
      body: 'segredo comercial',
    }).expect(201);
    await post(`/api/conversations/${conv.id}/messages`, sessionA, {
      direction: 'inbound',
      body: 'resposta do cliente',
    }).expect(201);

    const timeline = await get(`/api/activities?contactId=${contactA}&limit=10`, sessionA).expect(
      200,
    );
    const types = timeline.body.items.map((a: { type: string }) => a.type);
    expect(types).toContain('message_sent');
    expect(types).toContain('message_received');
    // o payload da timeline NUNCA carrega o corpo da mensagem
    const serialized = JSON.stringify(timeline.body);
    expect(serialized).not.toContain('segredo comercial');
    expect(serialized).not.toContain('resposta do cliente');
  });

  // ── RBAC ──────────────────────────────────────────────────────────────────

  it('RBAC: Guest lê mas não escreve; sem conversations:read nem lista', async () => {
    const guestId = await createUserFixture(prisma, 'guest-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, guestId, wsA.roles.guest);
    const guest = await loginAs('guest-a@veyra.test');

    await get('/api/conversations?status=all', guest).expect(200);
    await post('/api/conversations', guest, { subject: 'não pode' }).expect(403);

    const conv = (await post('/api/conversations', sessionA, { contactId: contactA }).expect(201))
      .body;
    await post(`/api/conversations/${conv.id}/messages`, guest, {
      direction: 'outbound',
      body: 'não pode',
    }).expect(403);
    await patch(`/api/conversations/${conv.id}`, guest, { status: 'closed' }).expect(403);
  });
});

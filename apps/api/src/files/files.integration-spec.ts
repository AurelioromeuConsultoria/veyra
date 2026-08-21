import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT ?? '.storage-test/1');

interface Session {
  cookieHeader: string;
  csrf: string;
}

const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 7),
  ]);
const pdf = () => Buffer.from('%PDF-1.7\ncorpo do contrato\n', 'binary');

describe('Arquivos — upload, download autorizado e expurgo (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  const transportCalls: string[] = [];
  const fakeTransport = async (url: string) => {
    transportCalls.push(url);
    return { status: 200, durationMs: 3 };
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
  const upload = (s: Session, bytes: Buffer, fileName: string) =>
    request(http)
      .post('/api/files')
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .attach('file', bytes, fileName);
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

  // ── Upload ────────────────────────────────────────────────────────────────

  it('upload detecta o tipo real, nunca nasce clean e deriva a chave no servidor', async () => {
    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    expect(criado.mimeType).toBe('image/png');
    expect(criado.scanStatus).toBe('pending'); // clean exige scanner real (§7.5)
    expect(criado.sizeBytes).toBe(png().length);
    // o DTO não expõe a chave de storage
    expect(criado.key).toBeUndefined();

    const row = await prisma.raw.fileObject.findFirst({ where: { id: criado.id } });
    // chave prefixada pelo workspace do CONTEXTO (§7.3)
    expect(row!.key.startsWith(`${wsA.workspaceId}/`)).toBe(true);
    expect(row!.key).not.toContain('foto');
  });

  it('P0 §7.1: extensão que diverge do conteúdo é rejeitada', async () => {
    const res = await upload(sessionA, png(), 'malicioso.pdf').expect(400);
    expect(res.body.message).toMatch(/não corresponde ao conteúdo/i);
    // nada foi gravado
    expect(await prisma.raw.fileObject.count()).toBe(0);
  });

  it('SVG e executável não entram', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    await upload(sessionA, svg, 'logo.svg').expect(400);
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
    await upload(sessionA, elf, 'app.txt').expect(400);
    expect(await prisma.raw.fileObject.count()).toBe(0);
  });

  it('arquivo acima do limite é recusado pelo multer', async () => {
    const gigante = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(11 * 1024 * 1024, 1),
    ]);
    const res = await upload(sessionA, gigante, 'grande.png');
    expect([400, 413]).toContain(res.status);
    expect(await prisma.raw.fileObject.count()).toBe(0);
  });

  // ── Download ──────────────────────────────────────────────────────────────

  it('download é autenticado e sai como anexo, com nosniff e o MIME detectado', async () => {
    const criado = (await upload(sessionA, pdf(), 'contrato.pdf').expect(201)).body;
    const res = await get(`/api/files/${criado.id}/content`, sessionA).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toContain('contrato.pdf');
    expect(Buffer.from(res.body).equals(pdf())).toBe(true);
  });

  it('sem sessão não há download (URL nunca é pública)', async () => {
    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    await request(http).get(`/api/files/${criado.id}/content`).expect(401);
  });

  it('arquivo em quarentena não é servido nem para quem tem files:read', async () => {
    const criado = (await upload(sessionA, png(), 'suspeito.png').expect(201)).body;
    await prisma.raw.fileObject.updateMany({
      where: { id: criado.id },
      data: { scanStatus: 'quarantined' },
    });
    await get(`/api/files/${criado.id}/content`, sessionA).expect(403);
  });

  // ── P0: isolamento ────────────────────────────────────────────────────────

  it('P0: arquivo de A é invisível e inalcançável de B', async () => {
    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    expect((await get('/api/files', sessionB).expect(200)).body).toEqual([]);
    await get(`/api/files/${criado.id}/content`, sessionB).expect(404);
    await del(`/api/files/${criado.id}`, sessionB).expect(404);
    // e o arquivo continua lá para o dono
    await get(`/api/files/${criado.id}/content`, sessionA).expect(200);
  });

  it('P0: anexo não alcança arquivo de outro workspace', async () => {
    const doB = (await upload(sessionB, png(), 'do-b.png').expect(201)).body;
    const conversa = (
      await post('/api/conversations', sessionA, { subject: 'Proposta' }).expect(201)
    ).body;
    await post(`/api/conversations/${conversa.id}/messages`, sessionA, {
      direction: 'outbound',
      body: 'segue',
      attachmentIds: [doB.id],
    }).expect(400);
  });

  // ── Anexos ────────────────────────────────────────────────────────────────

  it('anexa arquivo à mensagem e o devolve na thread', async () => {
    const arquivo = (await upload(sessionA, pdf(), 'proposta.pdf').expect(201)).body;
    const conversa = (
      await post('/api/conversations', sessionA, { subject: 'Proposta' }).expect(201)
    ).body;
    const mensagem = (
      await post(`/api/conversations/${conversa.id}/messages`, sessionA, {
        direction: 'outbound',
        body: 'Segue a proposta',
        attachmentIds: [arquivo.id],
      }).expect(201)
    ).body;
    expect(mensagem.attachments).toEqual([
      {
        fileObjectId: arquivo.id,
        fileName: 'proposta.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdf().length,
        scanStatus: 'pending',
      },
    ]);
    const thread = (await get(`/api/conversations/${conversa.id}/messages`, sessionA).expect(200))
      .body;
    expect(thread.items[0].attachments).toHaveLength(1);
  });

  it('§7.5: arquivo PENDING não sai para canal EXTERNO, mas anexa no interno', async () => {
    const arquivo = (await upload(sessionA, pdf(), 'proposta.pdf').expect(201)).body;
    // canal externo (ainda sem provider) criado por raw: é o caminho por onde a
    // regra vai passar quando o primeiro provider entrar
    const canalExterno = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'email', name: 'E-mail' },
    });
    const conversaExterna = await prisma.raw.conversation.create({
      data: { workspaceId: wsA.workspaceId, channelId: canalExterno.id, subject: 'Externa' },
    });

    const res = await post(`/api/conversations/${conversaExterna.id}/messages`, sessionA, {
      direction: 'outbound',
      body: 'segue',
      attachmentIds: [arquivo.id],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/não foi verificado|canal externo/i);

    // marcado clean por um scanner, o portão do ARQUIVO libera — e a recusa que
    // sobra é de POLÍTICA do canal (esta conversa não tem endereço externo nem
    // janela aberta), o que prova que os dois portões são independentes
    await prisma.raw.fileObject.updateMany({
      where: { id: arquivo.id },
      data: { scanStatus: 'clean' },
    });
    const depois = await post(`/api/conversations/${conversaExterna.id}/messages`, sessionA, {
      direction: 'outbound',
      body: 'segue',
      attachmentIds: [arquivo.id],
    });
    expect(depois.status).toBe(400);
    expect(depois.body.message).not.toMatch(/não foi verificado/i);
    expect(depois.body.message).toMatch(/destinatário|janela/i);
  });

  // ── Expurgo ───────────────────────────────────────────────────────────────

  it('exclusão tira a linha e o expurgo físico vem pelo outbox, fora da transação', async () => {
    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    const row = await prisma.raw.fileObject.findFirst({ where: { id: criado.id } });
    const key = row!.key;

    await del(`/api/files/${criado.id}`, sessionA).expect(200);
    // linha some na hora…
    expect(await prisma.raw.fileObject.count()).toBe(0);
    // …e os bytes ainda estão lá, aguardando o worker
    const antes = await readdir(resolve(STORAGE_ROOT, wsA.workspaceId));
    expect(antes.some((f) => key.endsWith(f))).toBe(true);

    const evento = await prisma.raw.outboxEvent.findFirst({ where: { eventType: 'file.purge' } });
    expect(evento).toBeTruthy();

    await app.get(JobsService).dispatchPending();
    const depois = await readdir(resolve(STORAGE_ROOT, wsA.workspaceId)).catch(() => []);
    expect(depois.some((f) => key.endsWith(f))).toBe(false);
  });

  it('P0: file.purge NUNCA é entregue a webhook de cliente', async () => {
    // webhook assinando TODOS os eventos que o contrato permite
    await prisma.raw.webhook.create({
      data: {
        workspaceId: wsA.workspaceId,
        url: 'https://destino-ok.veyra.test/hook',
        events: ['contact.created', 'deal.won'],
        secretCipher: 'x',
      },
    });
    // e outro assinando file.purge à força, por raw (o Zod do contrato recusaria)
    await prisma.raw.$executeRawUnsafe(
      `UPDATE "Webhook" SET "events" = ARRAY['file.purge']::text[] WHERE "workspaceId" = $1::uuid`,
      wsA.workspaceId,
    );

    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    await del(`/api/files/${criado.id}`, sessionA).expect(200);
    await app.get(JobsService).dispatchPending();

    // nenhuma chamada externa: a chave de storage não vaza para cliente algum
    expect(transportCalls).toEqual([]);
    expect(await prisma.raw.webhookDelivery.count()).toBe(0);
  });

  it('auditoria registra upload e exclusão sem a chave de storage', async () => {
    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    const row = await prisma.raw.fileObject.findFirst({ where: { id: criado.id } });
    await del(`/api/files/${criado.id}`, sessionA).expect(200);

    const logs = await prisma.raw.auditLog.findMany({ where: { entityType: 'file' } });
    expect(logs.map((l) => l.action).sort()).toEqual(['file.deleted', 'file.uploaded']);
    expect(JSON.stringify(logs)).not.toContain(row!.key);
  });

  // ── RBAC ──────────────────────────────────────────────────────────────────

  it('RBAC: Guest baixa mas não envia nem exclui', async () => {
    const guestId = await createUserFixture(prisma, 'guest-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, guestId, wsA.roles.guest);
    const guest = await loginAs('guest-a@veyra.test');

    const criado = (await upload(sessionA, png(), 'foto.png').expect(201)).body;
    await get('/api/files', guest).expect(200);
    await get(`/api/files/${criado.id}/content`, guest).expect(200);
    await upload(guest, png(), 'guest.png').expect(403);
    await del(`/api/files/${criado.id}`, guest).expect(403);
  });
});

import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CryptoService } from '../common/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  setPlanLimit,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { MediaCollectorService } from './media-collector.service';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from './meta.transport';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const APP_SECRET = process.env.META_APP_SECRET as string;
const PHONE_NUMBER_ID = '109876543210';

/** PNG mínimo válido, para a coleta de mídia. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 9),
]);

/** Transporte FALSO: a suíte nunca fala com a Meta (ADR-039). */
class FakeMetaTransport implements MetaTransport {
  sends: { to: string; body?: string; template?: string }[] = [];
  fetches: string[] = [];
  nextSend: SendOutcome = { ok: true, externalId: 'wamid.ENVIADA' };
  nextFetch: FetchOutcome = { ok: true, bytes: PNG, mimeType: 'image/png' };

  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    return this.nextSend;
  }
  async sendTemplate(_c: unknown, to: string, template: { name: string }): Promise<SendOutcome> {
    this.sends.push({ to, template: template.name });
    return this.nextSend;
  }
  async fetchMedia(_c: unknown, mediaId: string): Promise<FetchOutcome> {
    this.fetches.push(mediaId);
    return this.nextFetch;
  }
}

describe('Canal WhatsApp — envio e coleta (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const transport = new FakeMetaTransport();

  beforeAll(async () => {
    app = await createTestApp([], [{ provide: META_TRANSPORT, useValue: transport }]);
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let session: { cookieHeader: string; csrf: string };
  let channelId: string;
  let conversationId: string;
  let contactId: string;

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const req = request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookieHeader)
      .set('x-csrf-token', session.csrf);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send((body ?? {}) as object);
  };
  const sendMessage = (body: unknown, headers: Record<string, string> = {}) =>
    post(`/api/conversations/${conversationId}/messages`, body, headers);
  const drain = () => app.get(JobsService).dispatchPending();

  /** Entrada real, para a conversa nascer com janela e endereço. */
  const ingest = (timestamp = String(Math.floor(Date.now() / 1000))) => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ wa_id: '5511999998888', profile: { name: 'Paciente Ana' } }],
                messages: [
                  {
                    id: `wamid.IN${timestamp}`,
                    from: '5511999998888',
                    timestamp,
                    type: 'text',
                    text: { body: 'Quero marcar' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw);
  };

  beforeEach(async () => {
    transport.sends = [];
    transport.fetches = [];
    transport.nextSend = { ok: true, externalId: 'wamid.ENVIADA' };
    transport.nextFetch = { ok: true, bytes: PNG, mimeType: 'image/png' };

    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const owner = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, owner, wsA.roles.owner);
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'owner-a@veyra.test', password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    session = { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };

    const channel = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
    });
    channelId = channel.id;
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: 'waba-1',
        tokenCipher: app.get(CryptoService).encrypt('token-de-envio'),
      },
    });
    await ingest().expect(200);
    const conversa = await prisma.raw.conversation.findFirst();
    conversationId = conversa!.id;
    contactId = conversa!.contactId as string;
  });

  // ── Envio dentro da janela ────────────────────────────────────────────────

  it('dentro da janela, envio livre reserva quota, despacha e liquida', async () => {
    const criada = await sendMessage({
      direction: 'outbound',
      body: 'Podemos amanhã às 10h?',
    }).expect(201);
    // ainda não foi enviada: o dispatch está reservado
    const antes = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(antes).toMatchObject({ state: 'reserved' });
    expect(antes!.reservationId).toBeTruthy();
    expect(transport.sends).toEqual([]);

    await drain();

    // enviou para o endereço EXATO que falou com a gente
    expect(transport.sends).toEqual([{ to: '+5511999998888', body: 'Podemos amanhã às 10h?' }]);
    const depois = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(depois).toMatchObject({
      state: 'sent',
      externalId: 'wamid.ENVIADA',
      reservationId: null,
    });

    // quota liquidada em exatamente uma mensagem
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
    expect(await prisma.raw.usageReservation.count()).toBe(0);
  });

  it('reentrega do evento NÃO reenvia a mensagem', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Uma vez só' }).expect(201);
    await drain();
    expect(transport.sends).toHaveLength(1);

    // devolve o evento a pending, como um lease expirado faria
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { status: 'pending', nextRetryAt: new Date(), claimToken: null, leaseExpiresAt: null },
    });
    await drain();

    // o dispatch não está mais `reserved`: nada é reenviado
    expect(transport.sends).toHaveLength(1);
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
    expect(criada.body.id).toBeTruthy();
  });

  // ── Janela, template e consentimento ─────────────────────────────────────

  it('fora da janela, envio livre é recusado com motivo', async () => {
    await prisma.raw.conversation.updateMany({
      where: { id: conversationId },
      data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const res = await sendMessage({ direction: 'outbound', body: 'Oi, tudo bem?' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/janela de 24h/i);
    expect(transport.sends).toEqual([]);
    // nada reservado nem cobrado
    expect(await prisma.raw.usageReservation.count()).toBe(0);
  });

  it('fora da janela, template exige registro E consentimento', async () => {
    await prisma.raw.conversation.updateMany({
      where: { id: conversationId },
      data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const comTemplate = { name: 'lembrete_consulta', language: 'pt_BR', params: ['Ana'] };

    // template não registrado
    let res = await sendMessage({ direction: 'outbound', body: 'x', template: comTemplate });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/não registrado/i);

    await prisma.raw.messageTemplate.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId,
        name: 'lembrete_consulta',
        language: 'pt_BR',
        paramCount: 1,
      },
    });

    // registrado, mas sem consentimento
    res = await sendMessage({ direction: 'outbound', body: 'x', template: comTemplate });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/consentimento/i);

    await prisma.raw.contactChannelConsent.create({
      data: {
        workspaceId: wsA.workspaceId,
        contactId,
        channelType: 'whatsapp',
        source: 'form',
        activeMark: true,
      },
    });

    // agora passa, e envia como template
    await sendMessage({ direction: 'outbound', body: 'x', template: comTemplate }).expect(201);
    await drain();
    expect(transport.sends).toEqual([{ to: '+5511999998888', template: 'lembrete_consulta' }]);
  });

  it('parâmetros que não casam com o template são recusados', async () => {
    await prisma.raw.messageTemplate.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId,
        name: 'lembrete_consulta',
        language: 'pt_BR',
        paramCount: 2,
      },
    });
    await prisma.raw.contactChannelConsent.create({
      data: {
        workspaceId: wsA.workspaceId,
        contactId,
        channelType: 'whatsapp',
        source: 'form',
        activeMark: true,
      },
    });
    const res = await sendMessage({
      direction: 'outbound',
      body: 'x',
      template: { name: 'lembrete_consulta', language: 'pt_BR', params: ['Ana'] },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/parâmetros/i);
  });

  it('janela que FECHA entre a criação e o despacho impede o envio', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'No limite' }).expect(201);
    // a janela fecha antes do worker rodar
    await prisma.raw.conversation.updateMany({
      where: { id: conversationId },
      data: { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await drain();

    expect(transport.sends).toEqual([]);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch!.state).toBe('failed_permanent');
    // quota devolvida: não houve envio
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0);
  });

  // ── Falhas ────────────────────────────────────────────────────────────────

  it('erro AMBÍGUO não reenvia, cobra a quota e fica para resolução humana', async () => {
    transport.nextSend = { ok: false, failure: { networkFailure: true } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Sumiu no caminho' }).expect(
      201,
    );
    await drain();

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch!.state).toBe('unknown_after_dispatch');
    // cobrada, porque pode ter chegado
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);

    // o evento foi ENCERRADO: nada de retentativa automática
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    expect(evento!.status).toBe('delivered');
    await drain();
    expect(transport.sends).toHaveLength(1);
  });

  it('falha PERMANENTE libera a quota e encerra sem seis retentativas', async () => {
    transport.nextSend = { ok: false, failure: { status: 400, metaCode: 132_001 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Template ruim' }).expect(201);
    await drain();

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch!.state).toBe('failed_permanent');
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0); // liberada
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    expect(evento!.status).toBe('delivered'); // encerrado, sem retry
  });

  it('falha TRANSITÓRIA libera a quota, retenta e reserva de novo', async () => {
    transport.nextSend = { ok: false, failure: { status: 429 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Rate limit' }).expect(201);
    await drain();

    let dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch!.state).toBe('failed_before_send');
    expect(dispatch!.reservationId).toBeNull(); // liberada
    let contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0);

    // o evento voltou para pending com backoff
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    expect(evento!.status).toBe('pending');

    // consertado o provedor, a retentativa reserva OUTRA VEZ e envia
    transport.nextSend = { ok: true, externalId: 'wamid.NA_SEGUNDA' };
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: { state: 'reserved' },
    });
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { nextRetryAt: new Date() },
    });
    await drain();

    dispatch = await prisma.raw.messageDispatch.findFirst({ where: { messageId: criada.body.id } });
    expect(dispatch).toMatchObject({ state: 'sent', externalId: 'wamid.NA_SEGUNDA' });
    contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  // ── Quota ─────────────────────────────────────────────────────────────────

  it('quota de mensagens: cinco envios simultâneos com teto 3 param em 3', async () => {
    await setPlanLimit(prisma, 'messages_sent', 3);
    const resultados = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        sendMessage({ direction: 'outbound', body: `msg ${i}` }, { 'idempotency-key': `k-${i}` }),
      ),
    );
    expect(resultados.filter((r) => r.status === 201)).toHaveLength(3);
    expect(resultados.filter((r) => r.status === 400)).toHaveLength(2);
    expect(await prisma.raw.messageDispatch.count()).toBe(3);
  });

  it('duplo clique não cria duas mensagens (@Idempotent)', async () => {
    const chave = { 'idempotency-key': 'clique-duplo' };
    const primeira = await sendMessage({ direction: 'outbound', body: 'Uma só' }, chave).expect(
      201,
    );
    const replay = await sendMessage({ direction: 'outbound', body: 'Uma só' }, chave).expect(201);
    expect(replay.body.id).toBe(primeira.body.id);
    expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(1);
  });

  // ── Coleta de mídia ───────────────────────────────────────────────────────

  it('coleta autenticada cria FileObject PENDENTE e anexa à mensagem', async () => {
    const media = await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: (await prisma.raw.message.findFirst({ where: { direction: 'inbound' } }))!.id,
        providerMediaId: 'media-abc',
        mimeType: 'image/png',
        fileName: 'exame.png',
      },
    });

    const resultado = await app.get(MediaCollectorService).collectPending();
    expect(resultado).toEqual({ collected: 1, failed: 0 });
    expect(transport.fetches).toEqual(['media-abc']);

    const depois = await prisma.raw.inboundMedia.findFirst({ where: { id: media.id } });
    expect(depois).toMatchObject({ state: 'fetched', claimToken: null });
    const arquivo = await prisma.raw.fileObject.findFirst();
    // NUNCA nasce clean: o portão de saída externa depende do scanner (§7.5)
    expect(arquivo).toMatchObject({ scanStatus: 'pending', mimeType: 'image/png' });
    expect(await prisma.raw.messageAttachment.count()).toBe(1);
    // storage cobrado
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contador?.value ?? 0)).toBe(PNG.length);
  });

  it('dois coletores concorrentes baixam a mídia UMA vez', async () => {
    await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: (await prisma.raw.message.findFirst({ where: { direction: 'inbound' } }))!.id,
        providerMediaId: 'media-concorrente',
        mimeType: 'image/png',
        fileName: 'exame.png',
      },
    });
    const collector = app.get(MediaCollectorService);
    const [a, b] = await Promise.all([collector.collectPending(), collector.collectPending()]);

    // o claim com lease e fencing garante um único download e um único arquivo
    expect(a.collected + b.collected).toBe(1);
    expect(transport.fetches).toEqual(['media-concorrente']);
    expect(await prisma.raw.fileObject.count()).toBe(1);
    expect(await prisma.raw.messageAttachment.count()).toBe(1);
  });

  it('mídia de tipo não suportado falha sem gravar arquivo', async () => {
    transport.nextFetch = { ok: true, bytes: Buffer.from('<svg/>'), mimeType: 'image/svg+xml' };
    await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: (await prisma.raw.message.findFirst({ where: { direction: 'inbound' } }))!.id,
        providerMediaId: 'media-svg',
        mimeType: 'image/svg+xml',
        fileName: 'logo.svg',
      },
    });
    const resultado = await app.get(MediaCollectorService).collectPending();
    expect(resultado).toEqual({ collected: 0, failed: 1 });
    expect(await prisma.raw.fileObject.count()).toBe(0);
    const media = await prisma.raw.inboundMedia.findFirst();
    expect(media).toMatchObject({ state: 'failed', errorCode: 'unsupported_type' });
  });
});

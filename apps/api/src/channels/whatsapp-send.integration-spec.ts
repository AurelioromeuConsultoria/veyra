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
import { FilesService } from '../files/files.service';
import { MAX_ATTEMPTS } from '../outbox/outbox.service';
import { UsageService } from '../usage/usage.service';
import { MediaCollectorService } from './media-collector.service';
import { WhatsappSendService } from './whatsapp-send.service';
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

    // consertado o provedor, a retentativa acontece SEM ninguém mexer no
    // dispatch: só o relógio do backoff é adiantado, como o tempo faria
    transport.nextSend = { ok: true, externalId: 'wamid.NA_SEGUNDA' };
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
    // as recusadas vêm com o 402 estruturado, não com 400 genérico
    const recusadas = resultados.filter((r) => r.status === 402);
    expect(recusadas).toHaveLength(2);
    expect(recusadas[0].body).toMatchObject({ code: 'quota_exceeded', metric: 'messages_sent' });
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

  // ── Correções da revisão ──────────────────────────────────────────────────

  it('quota estourada devolve 402 estruturado, não 400', async () => {
    await setPlanLimit(prisma, 'messages_sent', 0);
    const res = await sendMessage({ direction: 'outbound', body: 'Sem cota' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      code: 'quota_exceeded',
      metric: 'messages_sent',
      limit: 0,
    });
    expect(res.body.resetsAt).toBeTruthy();
  });

  it('P0: dois despachos concorrentes chamam a Meta UMA vez', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Uma vez só' }).expect(201);

    // dois workers pegando o mesmo evento (lease do outbox expirado): sem o
    // claim próprio do dispatch, ambos chamariam a Meta
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    const service = app.get(WhatsappSendService);
    const claimado = {
      id: evento!.id,
      workspaceId: wsA.workspaceId,
      eventType: 'whatsapp.send_pending',
      payload: { messageId: criada.body.id },
      attempts: 1,
      claimToken: 'token-de-teste',
      chainId: null,
      depth: 0,
      originAutomationId: null,
    };
    await Promise.all([service.dispatch(claimado), service.dispatch(claimado)]);

    expect(transport.sends).toHaveLength(1);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent', claimToken: null });
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  it('P0: lease expirado APÓS despacho vira incerto — jamais reenvia', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Já pode ter chegado' }).expect(
      201,
    );
    /**
     * Worker que morreu DEPOIS de chamar a Meta: o marcador `dispatchedAt` é a
     * única coisa que distingue este caso de "morreu antes". Sem ele, o claim
     * reassumia e reenviava — mensagem duplicada para o paciente, exatamente o
     * que o ADR-039 existe para impedir.
     */
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: {
        state: 'sending',
        claimToken: '11111111-1111-4111-8111-111111111111',
        leaseExpiresAt: new Date(Date.now() - 1000),
        dispatchedAt: new Date(Date.now() - 30_000),
      },
    });
    await drain();

    // NENHUMA chamada nova ao provedor
    expect(transport.sends).toEqual([]);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'lease_expired_in_flight',
      claimToken: null,
    });
    // e a quota é cobrada: pode ter sido entregue
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  it('lease expirado ANTES do despacho é reassumido e envia uma vez', async () => {
    const criada = await sendMessage({
      direction: 'outbound',
      body: 'Ninguém chamou ainda',
    }).expect(201);
    // morreu ANTES de chamar: sem marcador, é seguro reassumir
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: {
        state: 'sending',
        claimToken: '11111111-1111-4111-8111-111111111111',
        leaseExpiresAt: new Date(Date.now() - 1000),
        dispatchedAt: null,
      },
    });
    await drain();

    expect(transport.sends).toHaveLength(1);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent' });
  });

  it('reserva EXPURGADA na retentativa não deixa o envio sair de graça', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Reserva sumiu' }).expect(201);
    // a reserva expira e o job a devolve ao orçamento, como aconteceria após 10min
    await prisma.raw.usageReservation.updateMany({
      where: {},
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(UsageService).purgeExpiredReservations();
    expect(await prisma.raw.usageReservation.count()).toBe(0);

    await drain();

    // enviou E cobrou: antes o `settle` silencioso deixava a mensagem sair sem
    // consumir quota nenhuma, e o teto deixava de valer para toda retentativa
    expect(transport.sends).toHaveLength(1);
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent' });
  });

  it('evento morto no outbox marca o dispatch terminal, sem estado que mente', async () => {
    transport.nextSend = { ok: false, failure: { status: 429 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Esgota' }).expect(201);
    // última tentativa do outbox
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { attempts: MAX_ATTEMPTS - 1 },
    });
    await drain();

    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    expect(evento!.status).toBe('dead');
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    // `failed_before_send` prometeria retentativa que não vem
    expect(dispatch).toMatchObject({ state: 'failed_permanent', errorCode: 'retries_exhausted' });
  });

  it('o estado do despacho é VISÍVEL na thread', async () => {
    transport.nextSend = { ok: false, failure: { networkFailure: true } };
    await sendMessage({ direction: 'outbound', body: 'Incerta' }).expect(201);
    await drain();

    const thread = await request(http)
      .get(`/api/conversations/${conversationId}/messages`)
      .set('Cookie', session.cookieHeader)
      .expect(200);
    const saida = thread.body.items.find((m: { direction: string }) => m.direction === 'outbound');
    // sem isto, a mensagem morria em silêncio para quem a enviou
    expect(saida.dispatchState).toBe('unknown_after_dispatch');
    expect(saida.dispatchError).toBe('network');
  });

  it('coleta perde a posse ANTES de gravar e não deixa resíduo', async () => {
    const mensagem = await prisma.raw.message.findFirst({ where: { direction: 'inbound' } });
    const media = await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: mensagem!.id,
        providerMediaId: 'media-perdida',
        mimeType: 'image/png',
        fileName: 'exame.png',
      },
    });
    // outro worker assume enquanto o download acontece: o token muda
    transport.nextFetch = { ok: true, bytes: PNG, mimeType: 'image/png' };
    const collector = app.get(MediaCollectorService);
    const original = transport.fetchMedia.bind(transport);
    transport.fetchMedia = async (c: unknown, id: string) => {
      await prisma.raw.inboundMedia.updateMany({
        where: { id: media.id },
        data: { claimToken: '22222222-2222-4222-8222-222222222222' },
      });
      return original(c, id);
    };

    const resultado = await collector.collectPending();
    transport.fetchMedia = original;

    expect(resultado.collected).toBe(0);
    // o download ACONTECEU (não é o caminho de falha do transporte): o que
    // barrou foi a verificação de posse antes de gravar
    expect(transport.fetches).toEqual(['media-perdida']);
    const linha = await prisma.raw.inboundMedia.findFirst({ where: { id: media.id } });
    expect(linha).toMatchObject({
      state: 'pending',
      claimToken: '22222222-2222-4222-8222-222222222222',
    });
    // nenhum arquivo, nenhum anexo, nenhuma quota consumida
    expect(await prisma.raw.fileObject.count()).toBe(0);
    expect(await prisma.raw.messageAttachment.count()).toBe(0);
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0);
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

  it('posse perdida DEPOIS de gravar limpa o resíduo (discardOrphan)', async () => {
    const mensagem = await prisma.raw.message.findFirst({ where: { direction: 'inbound' } });
    const media = await prisma.raw.inboundMedia.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: mensagem!.id,
        providerMediaId: 'media-orfa',
        mimeType: 'image/png',
        fileName: 'exame.png',
      },
    });
    // o token muda DEPOIS do renewLease e do download, já durante a gravação:
    // o storage é o último ponto antes da conclusão fenced
    const files = app.get(FilesService);
    const original = files.storeFromChannel.bind(files);
    (files as unknown as { storeFromChannel: unknown }).storeFromChannel = async (
      input: Parameters<typeof original>[0],
    ) => {
      const arquivo = await original(input);
      await prisma.raw.inboundMedia.updateMany({
        where: { id: media.id },
        data: { claimToken: '33333333-3333-4333-8333-333333333333' },
      });
      return arquivo;
    };

    const resultado = await app.get(MediaCollectorService).collectPending();
    (files as unknown as { storeFromChannel: unknown }).storeFromChannel = original;

    expect(resultado.collected).toBe(0);
    // o resíduo foi limpo: sem arquivo, sem anexo e com a quota devolvida
    expect(await prisma.raw.fileObject.count()).toBe(0);
    expect(await prisma.raw.messageAttachment.count()).toBe(0);
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'storage_bytes' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0);
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

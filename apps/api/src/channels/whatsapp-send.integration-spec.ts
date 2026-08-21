import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { ClsService } from 'nestjs-cls';
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

  /** Roda DENTRO da chamada ao provedor: usado para roubar a posse do lease. */
  onSend?: () => Promise<void>;

  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    await this.onSend?.();
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
    transport.onSend = undefined;

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
    // o segundo worker nem incrementou a tentativa: parou no claim
    expect(dispatch!.attempts).toBe(1);
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
    /**
     * A reserva desta mensagem estava VIVA quando o lease foi reassumido.
     * Perder a referência dela (zerar no claim) fazia a liquidação falhar e
     * cobrar de novo: contador em 2 por UMA mensagem, teto encolhendo a cada
     * worker reiniciado. Cobrança exata e nenhuma reserva pendurada.
     */
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
    expect(await prisma.raw.usageReservation.count({ where: {} })).toBe(0);
  });

  it('P1: reserva expurgada com o teto JÁ OCUPADO não envia — recusa antes da chamada', async () => {
    await setPlanLimit(prisma, 'messages_sent', 1);
    const criada = await sendMessage({ direction: 'outbound', body: 'Perdeu a vaga' }).expect(201);

    // o TTL da reserva (10min) é mais curto que o backoff do outbox (até 25min):
    // a reserva vence e o job a devolve ao orçamento antes de o worker rodar
    await prisma.raw.usageReservation.updateMany({
      where: {},
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(UsageService).purgeExpiredReservations();
    expect(await prisma.raw.usageReservation.count()).toBe(0);

    // OUTRA operação ocupa a última vaga nesse intervalo
    const cls = app.get(ClsService);
    await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      const usage = app.get(UsageService);
      await usage.ensureCounterRow(wsA.workspaceId, 'messages_sent');
      await (
        prisma.db as unknown as {
          $transaction: (fn: (tx: unknown) => Promise<void>) => Promise<void>;
        }
      ).$transaction((tx) =>
        usage.consumeOverLimit(tx as never, wsA.workspaceId, 'messages_sent', 1),
      );
    });

    await drain();

    // NADA foi enviado: sem vaga, o transporte não é chamado. Antes, o worker
    // confiava no reservationId morto, enviava, e só cobrava depois — fora do
    // limite, contra a regra central da entrega.
    expect(transport.sends).toEqual([]);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'failed_permanent', errorCode: 'quota_exceeded' });
    // o contador continua no teto, sem estouro
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  it('reserva expurgada COM vaga disponível reserva de novo e envia uma vez', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Ainda cabe' }).expect(201);
    await prisma.raw.usageReservation.updateMany({
      where: {},
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.get(UsageService).purgeExpiredReservations();

    await drain();

    expect(transport.sends).toHaveLength(1);
    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent' });
    // cobrada uma única vez, pela reserva NOVA
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
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

  it('P1: falha transitória ZERA o marcador de despacho da tentativa', async () => {
    transport.nextSend = { ok: false, failure: { status: 429 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Marcador limpo' }).expect(201);
    await drain();

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    /**
     * `dispatchedAt` significa "esta tentativa chegou a chamar a Meta". Herdado
     * de uma tentativa anterior, ele mentia: um worker que morresse ANTES de
     * chamar seria lido como "pode ter enviado", virava incerto e cobrava quota
     * por uma mensagem que provadamente nunca saiu.
     */
    expect(dispatch).toMatchObject({ state: 'failed_before_send', dispatchedAt: null });
  });

  /** Abandona o dispatch da mensagem: `sending`, lease vencido há muito. */
  const abandonar = async (messageId: string, dispatchedAt: Date | null) => {
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId },
      data: {
        state: 'sending',
        claimToken: '22222222-2222-4222-8222-222222222222',
        leaseExpiresAt: new Date(Date.now() - 30 * 60_000),
        dispatchedAt,
      },
    });
  };

  it('varredura: abandonado SEM despacho, com evento vivo, volta a ser enviável', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Worker morreu' }).expect(201);
    await abandonar(criada.body.id, null);

    expect(await app.get(WhatsappSendService).reapStaleDispatches()).toBe(1);

    let dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    /**
     * `failed_permanent` aqui MATAVA a entrega: o evento do outbox ainda vai
     * tentar (o backoff dele chega a horas, muito além do limiar da varredura) e
     * o claim recusa estado terminal — mensagem nunca enviada, sem retentativa.
     * `failed_before_send` é elegível ao claim.
     */
    expect(dispatch).toMatchObject({
      state: 'failed_before_send',
      errorCode: 'abandoned_before_send',
      claimToken: null,
      reservationId: null,
    });
    let contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0); // devolvida: nada foi enviado

    // e a retentativa do outbox realmente envia
    await drain();
    expect(transport.sends).toHaveLength(1);
    dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent' });
    contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  it('varredura: sem evento vivo no outbox, encerra em definitivo', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Ninguém mais tenta' }).expect(
      201,
    );
    // o evento já morreu: não há quem retente
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { status: 'dead' },
    });
    await abandonar(criada.body.id, null);

    await app.get(WhatsappSendService).reapStaleDispatches();

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'failed_permanent' });
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(0);
  });

  it('varredura: abandonado COM marcador vira incerto e cobra', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Pode ter saído' }).expect(201);
    await abandonar(criada.body.id, new Date(Date.now() - 30 * 60_000));

    await app.get(WhatsappSendService).reapStaleDispatches();

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'abandoned_in_flight',
    });
    // o INSTANTE do despacho sobrevive: é dele que depende a triagem humana
    expect(dispatch!.dispatchedAt).not.toBeNull();
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1); // cobrada: pode ter chegado
  });

  it('P0: varredura NÃO toca dispatch já concluído com lease residual', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Já foi' }).expect(201);
    await drain();
    /**
     * Concluído por um worker, com lease residual antigo. O predicado precisa
     * estar no WHERE EXTERNO, não só na subquery: em READ COMMITTED o Postgres
     * refaz a qualificação contra a versão nova da linha, mas reavalia a
     * subquery no snapshot ORIGINAL — e a varredura sobrescrevia um `sent`
     * acabado de comitar. Mensagem entregue exibida como "Não enviada" leva a
     * reenvio manual: o dano do ADR-039 por caminho humano.
     */
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: { leaseExpiresAt: new Date(Date.now() - 30 * 60_000) },
    });

    expect(await app.get(WhatsappSendService).reapStaleDispatches()).toBe(0);

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent', externalId: 'wamid.ENVIADA' });
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1); // cobrada UMA vez
  });

  it('P0: varredura cross-workspace mantém cada quota no seu workspace', async () => {
    // wsB tem o próprio canal, conversa, mensagem e dispatch abandonado
    const wsB = await createWorkspaceFixture(prisma, 'outra-clinica');
    const canalB = await prisma.raw.channel.create({
      data: { workspaceId: wsB.workspaceId, type: 'whatsapp', name: 'WhatsApp B' },
    });
    const conversaB = await prisma.raw.conversation.create({
      data: {
        workspaceId: wsB.workspaceId,
        channelId: canalB.id,
        externalAddress: '5511777776666',
      },
    });
    const mensagemB = await prisma.raw.message.create({
      data: {
        workspaceId: wsB.workspaceId,
        channelId: canalB.id,
        conversationId: conversaB.id,
        direction: 'outbound',
        authorType: 'system',
        body: 'De outro workspace',
      },
    });
    const usage = app.get(UsageService);
    await usage.ensureCounterRow(wsB.workspaceId, 'messages_sent');
    const reservaB = await app.get(ClsService).run(async () => {
      app.get(ClsService).set('workspaceId', wsB.workspaceId);
      return usage.reserve(wsB.workspaceId, 'messages_sent', 1);
    });
    await prisma.raw.messageDispatch.create({
      data: {
        workspaceId: wsB.workspaceId,
        messageId: mensagemB.id,
        state: 'sending',
        reservationId: (reservaB as { reservationId: string }).reservationId,
        claimToken: '44444444-4444-4444-8444-444444444444',
        leaseExpiresAt: new Date(Date.now() - 30 * 60_000),
        dispatchedAt: new Date(Date.now() - 30 * 60_000), // cobrável
      },
    });

    // wsA: abandonado SEM marcador (quota deve VOLTAR)
    const criada = await sendMessage({ direction: 'outbound', body: 'Do wsA' }).expect(201);
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { status: 'dead' },
    });
    await abandonar(criada.body.id, null);

    expect(await app.get(WhatsappSendService).reapStaleDispatches()).toBe(2);

    // cada contador ficou no seu: A devolveu, B cobrou
    const contadorA = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    const contadorB = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsB.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contadorA?.value ?? 0)).toBe(0);
    expect(Number(contadorB?.value ?? 0)).toBe(1);
    const dispatchA = await prisma.raw.messageDispatch.findFirst({
      where: { workspaceId: wsA.workspaceId, messageId: criada.body.id },
    });
    const dispatchB = await prisma.raw.messageDispatch.findFirst({
      where: { workspaceId: wsB.workspaceId, messageId: mensagemB.id },
    });
    expect(dispatchA).toMatchObject({ state: 'failed_permanent' });
    expect(dispatchB).toMatchObject({ state: 'unknown_after_dispatch' });
  });

  it('P0: conclusão CONCORRENTE não comitada não é rebaixada pela varredura', async () => {
    const criada = await sendMessage({ direction: 'outbound', body: 'Comitando agora' }).expect(
      201,
    );
    await drain();
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: { state: 'sending', leaseExpiresAt: new Date(Date.now() - 30 * 60_000) },
    });

    /**
     * Segunda conexão com transação ABERTA: é o único jeito de o Jest exercitar
     * o recheck que protege um `sent` recém-concluído. Sem o predicado no WHERE
     * externo, a varredura reavalia a subquery no snapshot ORIGINAL — que ainda
     * vê `sending` — e sobrescreve a linha que o outro acabou de concluir.
     */
    const outra = new Client({ connectionString: process.env.DATABASE_URL });
    await outra.connect();
    try {
      await outra.query('BEGIN');
      await outra.query(
        `UPDATE "MessageDispatch" SET "state" = 'sent', "leaseExpiresAt" = NULL
          WHERE "messageId" = $1`,
        [criada.body.id],
      );

      /**
       * A varredura precisa NÃO TOCAR e NÃO BLOQUEAR. A corrida é decidida por
       * duas guardas: `SKIP LOCKED` pula a linha travada e o predicado repetido
       * no WHERE externo descarta na reavaliação caso ela chegue a bloquear.
       * Sem ambas, esta chamada trava até o COMMIT — daí a corrida contra o
       * relógio, para falhar com mensagem em vez de estourar o timeout da suíte.
       */
      const resultado = await Promise.race([
        app.get(WhatsappSendService).reapStaleDispatches(),
        new Promise((resolve) => setTimeout(() => resolve('bloqueou'), 2_000)),
      ]);
      expect(resultado).toBe(0);

      await outra.query('COMMIT');
    } finally {
      await outra.end();
    }

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch).toMatchObject({ state: 'sent', externalId: 'wamid.ENVIADA' });
    const contador = await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
    });
    expect(Number(contador?.value ?? 0)).toBe(1);
  });

  it('varredura: `failed_before_send` sem retentador para de mentir', async () => {
    transport.nextSend = { ok: false, failure: { status: 429 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Sem retentador' }).expect(201);
    await drain();
    // o evento que faria a retentativa não existe mais
    await prisma.raw.outboxEvent.updateMany({
      where: { eventType: 'whatsapp.send_pending' },
      data: { status: 'delivered' },
    });
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60_000) },
    });

    expect(await app.get(WhatsappSendService).reapStaleDispatches()).toBe(1);

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    // "aguardando nova tentativa" sem ninguém que possa tentar é estado que mente
    expect(dispatch).toMatchObject({ state: 'failed_permanent', errorCode: 'no_retrier' });
  });

  it('varredura NÃO encerra `failed_before_send` com evento vivo', async () => {
    transport.nextSend = { ok: false, failure: { status: 429 } };
    const criada = await sendMessage({ direction: 'outbound', body: 'Ainda vai tentar' }).expect(
      201,
    );
    await drain();
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId: criada.body.id },
      data: { updatedAt: new Date(Date.now() - 30 * 60_000) },
    });

    expect(await app.get(WhatsappSendService).reapStaleDispatches()).toBe(0);

    const dispatch = await prisma.raw.messageDispatch.findFirst({
      where: { messageId: criada.body.id },
    });
    expect(dispatch!.state).toBe('failed_before_send'); // o outbox ainda vai tentar
  });

  it('posse perdida APÓS envio bem-sucedido deixa trilha com o wamid, sem corpo', async () => {
    const roubarPosse = async () => {
      await prisma.raw.messageDispatch.updateMany({
        where: { state: 'sending' },
        data: { claimToken: '55555555-5555-4555-8555-555555555555' },
      });
    };
    transport.onSend = roubarPosse;
    const criada = await sendMessage({ direction: 'outbound', body: 'Texto sigiloso' }).expect(201);
    await drain();

    expect(transport.sends).toHaveLength(1);
    const trilha = await prisma.raw.auditLog.findFirst({
      where: { workspaceId: wsA.workspaceId, action: 'message.dispatch_lease_lost' },
    });
    /**
     * O wamid é o ÚNICO ponto de retomada: sem ele a trilha do caso incerto era
     * `{ direction: "[changed]" }`, e um humano não teria como achar a mensagem
     * no provedor. Corpo da mensagem, jamais.
     */
    expect(trilha).toBeTruthy();
    expect((trilha!.after as Record<string, unknown>).externalId).toBe('wamid.ENVIADA');
    expect(JSON.stringify(trilha!.after)).not.toContain('Texto sigiloso');
    expect(trilha!.entityId).toBe(criada.body.id);
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

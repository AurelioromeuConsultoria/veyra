import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  createUserFixture,
  createMembershipFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';

const APP_SECRET = process.env.META_APP_SECRET as string;
const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN as string;
const PHONE_NUMBER_ID = '109876543210';

const sign = (raw: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(raw)).digest('hex')}`;

const inbound = (extra: Record<string, unknown> = {}, phoneNumberId = PHONE_NUMBER_ID) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: '5511999998888', profile: { name: 'Paciente Ana' } }],
            messages: [
              {
                id: 'wamid.INBOUND1',
                from: '5511999998888',
                timestamp: '1787000000',
                type: 'text',
                text: { body: 'Bom dia, queria marcar uma consulta' },
                ...extra,
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('Canal WhatsApp — ingestão (integração)', () => {
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
  let channelId: string;

  /** POST assinado, como a Meta faria. */
  const send = (payload: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(payload);
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', sign(raw, secret))
      .send(raw);
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const owner = await createUserFixture(prisma, 'owner-a@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, owner, wsA.roles.owner);

    // canal externo do workspace, com credencial de roteamento
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
        tokenCipher: 'cifrado',
      },
    });
  });

  // ── Verificação (ADR-037) ─────────────────────────────────────────────────

  it('desafio GET devolve o challenge só com o verify_token correto', async () => {
    const ok = await request(http)
      .get('/api/channels/whatsapp/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '42' })
      .expect(200);
    expect(ok.text).toBe('42');

    await request(http)
      .get('/api/channels/whatsapp/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '42' })
      .expect(403);
  });

  it('P0: payload com assinatura inválida NÃO toca o domínio', async () => {
    const res = await send(inbound(), 'segredo-de-atacante');
    // 200 neutro de propósito: 401/403 confirmaria a um sondador que o endpoint
    // existe e valida assinatura
    expect(res.status).toBe(200);
    expect(await prisma.raw.message.count()).toBe(0);
    expect(await prisma.raw.contact.count()).toBe(0);
    expect(await prisma.raw.conversation.count()).toBe(0);
  });

  it('P0: sem header de assinatura também não processa', async () => {
    await request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(inbound()))
      .expect(200);
    expect(await prisma.raw.message.count()).toBe(0);
  });

  it('P0: número desconhecido não cria nada — roteamento é pela credencial', async () => {
    await send(inbound({}, '000000000000')).expect(200);
    expect(await prisma.raw.message.count()).toBe(0);
    expect(await prisma.raw.contact.count()).toBe(0);
  });

  // ── Ingestão ──────────────────────────────────────────────────────────────

  it('mensagem recebida cria contato, conversa e mensagem no workspace do número', async () => {
    await send(inbound()).expect(200);

    const contato = await prisma.raw.contact.findFirst();
    expect(contato).toMatchObject({ name: 'Paciente Ana', source: 'whatsapp' });
    expect(contato!.phones).toEqual(['+5511999998888']);
    expect(contato!.workspaceId).toBe(wsA.workspaceId);

    const mensagem = await prisma.raw.message.findFirst();
    expect(mensagem).toMatchObject({
      direction: 'inbound',
      authorType: 'contact',
      externalId: 'wamid.INBOUND1',
      body: 'Bom dia, queria marcar uma consulta',
    });
    expect(mensagem!.channelId).toBe(channelId);

    // a timeline registra o fato, sem o corpo
    const activity = await prisma.raw.activity.findFirst({ where: { type: 'message_received' } });
    expect(activity!.actorType).toBe('system');
    expect(JSON.stringify(activity!.payload)).not.toContain('consulta');
  });

  it('ADR-038: entrada abre a JANELA e NÃO cria consentimento', async () => {
    await send(inbound()).expect(200);
    const conversa = await prisma.raw.conversation.findFirst();
    expect(conversa!.lastInboundAt).not.toBeNull();
    expect(conversa!.lastMessageAt).toEqual(conversa!.lastInboundAt);

    // consentimento é evidência SEPARADA: nada foi criado
    expect(await prisma.raw.contactChannelConsent.count()).toBe(0);
  });

  it('reentrega do MESMO evento não duplica a mensagem', async () => {
    await send(inbound()).expect(200);
    await send(inbound()).expect(200);
    expect(await prisma.raw.message.count()).toBe(1);
    expect(await prisma.raw.conversation.count()).toBe(1);
  });

  it('segunda mensagem do mesmo contato reaproveita a conversa aberta', async () => {
    await send(inbound()).expect(200);
    const segunda = inbound();
    segunda.entry[0].changes[0].value.messages[0].id = 'wamid.INBOUND2';
    segunda.entry[0].changes[0].value.messages[0].text = { body: 'Ainda estou aí?' };
    await send(segunda).expect(200);

    expect(await prisma.raw.conversation.count()).toBe(1);
    expect(await prisma.raw.message.count()).toBe(2);
  });

  it('mídia recebida NÃO é baixada no request público: só a coleta é agendada', async () => {
    const comImagem = inbound();
    const mensagem = comImagem.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    mensagem.type = 'image';
    delete mensagem.text;
    mensagem.image = { id: 'media-123', mime_type: 'image/png' };
    await send(comImagem).expect(200);

    // nenhum arquivo existe ainda — o webhook público não busca conteúdo
    expect(await prisma.raw.fileObject.count()).toBe(0);
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.media_pending' },
    });
    expect(evento).toBeTruthy();
    expect(evento!.payload).toMatchObject({ mediaId: 'media-123', mimeType: 'image/png' });
  });

  it('tipo de mensagem não suportado é ignorado sem quebrar', async () => {
    const naoSuportado = inbound();
    const mensagem = naoSuportado.entry[0].changes[0].value.messages[0] as Record<string, unknown>;
    mensagem.type = 'sticker';
    delete mensagem.text;
    await send(naoSuportado).expect(200);
    expect(await prisma.raw.message.count()).toBe(0);
  });

  it('payload malformado responde 200 e não vira reentrega infinita', async () => {
    await send({ object: 'whatsapp_business_account', entry: 'não é array' }).expect(200);
    expect(await prisma.raw.message.count()).toBe(0);
  });

  // ── Recibos (ADR-039) ─────────────────────────────────────────────────────

  it('recibo é ligado pelo wamid do dispatch, deduplicado e com hora do provedor', async () => {
    // uma mensagem de saída já despachada
    const conversation = await prisma.raw.conversation.create({
      data: { workspaceId: wsA.workspaceId, channelId },
    });
    const enviada = await prisma.raw.message.create({
      data: {
        workspaceId: wsA.workspaceId,
        conversationId: conversation.id,
        channelId,
        direction: 'outbound',
        authorType: 'user',
        body: 'Confirmado para amanhã',
      },
    });
    await prisma.raw.messageDispatch.create({
      data: {
        workspaceId: wsA.workspaceId,
        messageId: enviada.id,
        state: 'sent',
        externalId: 'wamid.OUT1',
      },
    });

    const recibo = (status: string, timestamp: string) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [{ id: 'wamid.OUT1', status, timestamp }],
              },
            },
          ],
        },
      ],
    });

    // chegam FORA de ordem: read antes de delivered
    await send(recibo('read', '1787000300')).expect(200);
    await send(recibo('delivered', '1787000200')).expect(200);
    // e o delivered chega DE NOVO
    await send(recibo('delivered', '1787000200')).expect(200);

    const eventos = await prisma.raw.messageStatusEvent.findMany({
      where: { messageId: enviada.id },
      orderBy: { occurredAt: 'asc' },
    });
    // três chegadas, dois FATOS: o unique deduplicou
    expect(eventos).toHaveLength(2);
    // a ordem é a do PROVEDOR, não a de chegada
    expect(eventos.map((e) => e.status)).toEqual(['delivered', 'read']);
    expect(eventos[0].occurredAt.getTime()).toBeLessThan(eventos[1].occurredAt.getTime());
  });

  it('recibo de mensagem desconhecida é ignorado', async () => {
    await send({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                statuses: [
                  { id: 'wamid.DESCONHECIDO', status: 'delivered', timestamp: '1787000200' },
                ],
              },
            },
          ],
        },
      ],
    }).expect(200);
    expect(await prisma.raw.messageStatusEvent.count()).toBe(0);
  });

  it('P0: dois workspaces com números diferentes não se cruzam', async () => {
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const canalB = await prisma.raw.channel.create({
      data: { workspaceId: wsB.workspaceId, type: 'whatsapp', name: 'WhatsApp B' },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsB.workspaceId,
        channelId: canalB.id,
        phoneNumberId: '555555555555',
        businessAccountId: 'waba-2',
        tokenCipher: 'cifrado',
      },
    });

    await send(inbound()).expect(200);
    const paraB = inbound({}, '555555555555');
    paraB.entry[0].changes[0].value.messages[0].id = 'wamid.PARA_B';
    await send(paraB).expect(200);

    const deA = await prisma.raw.message.findMany({ where: { workspaceId: wsA.workspaceId } });
    const deB = await prisma.raw.message.findMany({ where: { workspaceId: wsB.workspaceId } });
    expect(deA).toHaveLength(1);
    expect(deB).toHaveLength(1);
    expect(deA[0].externalId).toBe('wamid.INBOUND1');
    expect(deB[0].externalId).toBe('wamid.PARA_B');
  });

  it('o mesmo número não pode ser reivindicado por dois workspaces', async () => {
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const canalB = await prisma.raw.channel.create({
      data: { workspaceId: wsB.workspaceId, type: 'whatsapp', name: 'WhatsApp B' },
    });
    await expect(
      prisma.raw.channelCredential.create({
        data: {
          workspaceId: wsB.workspaceId,
          channelId: canalB.id,
          phoneNumberId: PHONE_NUMBER_ID, // já é de A
          businessAccountId: 'waba-2',
          tokenCipher: 'cifrado',
        },
      }),
    ).rejects.toThrow();
  });
});

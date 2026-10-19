import { createHmac, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { webhookEventSchema, type WebhookEvent } from '@veyra/contracts';
import { CryptoService } from '../common/crypto.service';
import { JobsService } from '../jobs/jobs.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_TRANSPORT, WebhooksService } from '../webhooks/webhooks.service';
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
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../intelligence/llm/llm.client';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../channels/meta.transport';
import {
  CONTENT_RESTRICTION_PROVIDERS,
  type ContentRestrictionProvider,
  type RestrictionConsumer,
  type RestrictionSubject,
} from './content-restriction';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
/**
 * TODOS os tipos do catálogo de webhooks, lidos do próprio contrato: tipo novo
 * entra sozinho nesta bateria (ADR-048 §6.6), sem ninguém lembrar de acrescentá-lo.
 */
const WEBHOOK_EVENTS_FOR_TEST: WebhookEvent[] = [...webhookEventSchema.options];
const APP_SECRET = process.env.META_APP_SECRET as string;
const PHONE_NUMBER_ID = '109876543299';

/**
 * Porta de TESTE do E6 (ADR-047): o que um vertical faria, controlável. A F1.a
 * prova o lado do CORE — todos os pontos de checagem consultam a porta, pelo
 * consumidor certo e com o workspace certo, e falham fechados. A regra de
 * QUEM é restrito é do vertical e é testada na F1.b.
 */
class ProbeRestriction implements ContentRestrictionProvider {
  /** workspaces onde há "dado sensível"; fora deles nada é restrito */
  workspaces = new Set<string>();
  rules: Record<RestrictionConsumer, { all: boolean; ids: Set<RestrictionSubject> }> = {
    ai: { all: false, ids: new Set() },
    webhook: { all: false, ids: new Set() },
  };
  fail = false;
  /** passa a restringir TUDO depois de N consultas (corrida entre checagens) */
  restrictAfter: number | null = null;
  calls: { workspaceId: string; consumer: RestrictionConsumer; subjects: RestrictionSubject[] }[] =
    [];

  reset(): void {
    this.workspaces.clear();
    this.rules.ai = { all: false, ids: new Set() };
    this.rules.webhook = { all: false, ids: new Set() };
    this.fail = false;
    this.restrictAfter = null;
    this.calls = [];
  }

  async restricted(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<readonly boolean[]> {
    this.calls.push({ workspaceId, consumer, subjects: [...subjects] });
    if (this.fail) throw new Error('porta indisponível (teste)');
    if (this.restrictAfter !== null && this.calls.length > this.restrictAfter) {
      return subjects.map(() => true);
    }
    if (!this.workspaces.has(workspaceId)) return subjects.map(() => false);
    const rule = this.rules[consumer];
    return subjects.map((subject) => rule.all || rule.ids.has(subject));
  }
}

class FakeLlm implements LlmClient {
  readonly model = 'claude-sonnet-5';
  calls: LlmRequest[] = [];
  nextText = '{}';
  async complete(request: LlmRequest): Promise<LlmOutcome> {
    this.calls.push(request);
    return { kind: 'ok', text: this.nextText, inputTokens: 500, outputTokens: 100 };
  }
}

class FakeMetaTransport implements MetaTransport {
  sends: { to: string; body?: string }[] = [];
  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    this.sends.push({ to, body });
    return { ok: true, externalId: `wamid.ENVIADA.${this.sends.length}` };
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.sends.push({ to });
    return { ok: true, externalId: `wamid.T.${this.sends.length}` };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

const RESUMO = JSON.stringify({
  subject: 'Agendamento',
  summary: 'O contato pediu horário.',
  pendencies: [],
  sentiment: 'neutro',
  injectionAttempt: false,
});
const RASCUNHO = JSON.stringify({
  body: 'Temos horário amanhã às 10h.',
  rationale: 'Pedido de horário dentro da janela.',
  injectionAttempt: false,
});
const ACAO = JSON.stringify({ title: 'Retornar contato', rationale: 'Sinais.', dueInDays: 1 });
const EXPLICACAO = JSON.stringify({ explanation: 'Score explicado.' });

interface Session {
  cookieHeader: string;
  csrf: string;
}

describe('Restrição de conteúdo por contato — ADR-047 E6 (integração, lado do Core)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const probe = new ProbeRestriction();
  const llm = new FakeLlm();
  const meta = new FakeMetaTransport();
  const hooks: { url: string; body: string }[] = [];

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONTENT_RESTRICTION_PROVIDERS, useValue: [probe] },
        { provide: LLM_CLIENT, useValue: llm },
        { provide: META_TRANSPORT, useValue: meta },
        {
          provide: WEBHOOK_TRANSPORT,
          useValue: async (url: string, body: string) => {
            hooks.push({ url, body });
            return { status: 200, durationMs: 1 };
          },
        },
      ],
    );
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
  let conversationId: string;
  let contactId: string;

  const loginAs = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const send = (method: 'post' | 'put', path: string, s: Session, body?: unknown) =>
    request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const postWithKey = (path: string, s: Session, key: string) =>
    request(http)
      .post(path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .set('idempotency-key', key)
      .send({});
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);
  /**
   * `nextRetryAt` nasce com o relógio do NODE e o claim compara com o `now()` do
   * POSTGRES: com a VM do Docker alguns ms atrás, um evento recém-criado ainda
   * parece "do futuro" e fica para a próxima rodada. O teste não é sobre isso —
   * torna tudo o que está pendente elegível antes de reivindicar.
   */
  const makeDue = () =>
    prisma.raw.outboxEvent.updateMany({
      where: { status: 'pending' },
      data: { nextRetryAt: new Date(0) },
    });
  const drain = async () => {
    await makeDue();
    return app.get(JobsService).dispatchPending(50);
  };

  /** "Dado sensível" no workspace A, para o consumidor pedido. */
  const restrictA = (consumer: RestrictionConsumer, subjects: RestrictionSubject[] | 'all') => {
    probe.workspaces.add(wsA.workspaceId);
    if (subjects === 'all') probe.rules[consumer].all = true;
    else for (const s of subjects) probe.rules[consumer].ids.add(s);
  };

  const ingest = (texto = 'Tem horário amanhã?') => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                contacts: [{ wa_id: '5511988887777', profile: { name: 'Contato Teste' } }],
                messages: [
                  {
                    id: `wamid.IN${timestamp}${Math.random()}`,
                    from: '5511988887777',
                    timestamp,
                    type: 'text',
                    text: { body: texto },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw);
  };

  const usoDeIa = async () => ({
    reservas: await prisma.raw.usageReservation.count(),
    runs: await prisma.raw.usageCounter.findFirst({
      where: { workspaceId: wsA.workspaceId, metric: 'ai_runs' },
    }),
  });

  beforeEach(async () => {
    probe.reset();
    llm.calls = [];
    llm.nextText = RESUMO;
    meta.sends = [];
    hooks.length = 0;
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
    await send('put', '/api/intelligence/consent', sessionA, { conversationContent: true }).expect(
      200,
    );

    const channel = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId: channel.id,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: 'waba-e6',
        tokenCipher: app.get(CryptoService).encrypt('token-de-envio'),
      },
    });
    await ingest().expect(200);
    const conversa = await prisma.raw.conversation.findFirst({
      where: { workspaceId: wsA.workspaceId, channelId: channel.id },
    });
    conversationId = conversa!.id;
    contactId = conversa!.contactId!;
  });

  // ── Não regressão: Core sem dado sensível ─────────────────────────────────

  it('sem restrição, a IA funciona como antes e a porta é consultada com consumidor e workspace', async () => {
    const res = await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ok');
    expect(llm.calls).toHaveLength(1);
    expect(probe.calls.length).toBeGreaterThan(0);
    for (const call of probe.calls) {
      expect(call).toMatchObject({ workspaceId: wsA.workspaceId, consumer: 'ai' });
      expect(call.subjects).toEqual([contactId]);
    }
  });

  // ── IA: toda a superfície ─────────────────────────────────────────────────

  describe('IA (consumidor `ai`)', () => {
    it('resumo: recusa SEM chamar o provedor, sem reservar quota, e registra o run recusado', async () => {
      restrictA('ai', [contactId]);
      const res = await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      const uso = await usoDeIa();
      expect(uso.reservas).toBe(0);
      expect(Number(uso.runs?.value ?? 0)).toBe(0);
      const run = await prisma.raw.aiRun.findFirst({
        where: { capability: 'conversation_summary' },
      });
      expect(run).toMatchObject({ status: 'refused', reasonCode: 'content_restricted' });
      expect(run!.contextSummary).not.toContain('horário');
    });

    it('sugestão de resposta: recusa sem provedor e sem proposta', async () => {
      restrictA('ai', [contactId]);
      llm.nextText = RASCUNHO;
      const res = await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);
      expect(res.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      expect(await prisma.raw.aiProposal.count()).toBe(0);
    });

    it('próxima ação: recusa sem provedor e sem proposta', async () => {
      restrictA('ai', [contactId]);
      llm.nextText = ACAO;
      const res = await post(
        `/api/intelligence/contacts/${contactId}/next-action`,
        sessionA,
      ).expect(201);
      expect(res.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      expect(await prisma.raw.aiProposal.count()).toBe(0);
    });

    it('lead score: o score determinístico continua; a redação pelo modelo, não', async () => {
      restrictA('ai', [contactId]);
      llm.nextText = EXPLICACAO;
      const res = await get(`/api/intelligence/contacts/${contactId}/score`, sessionA).expect(200);
      expect(typeof res.body.score).toBe('number');
      expect(res.body.explanation).toBeNull();
      expect(llm.calls).toEqual([]);
      // leitura (GET a cada visualização): não grava run — não polui o histórico
      expect(await prisma.raw.aiRun.count()).toBe(0);
    });

    it('conversa sem contato: o `null` vai à porta, e ela decide', async () => {
      const interna = (
        await post('/api/conversations', sessionA, { subject: 'Interna' }).expect(201)
      ).body.id;
      await post(`/api/conversations/${interna}/messages`, sessionA, {
        direction: 'outbound',
        body: 'Anotação da equipe',
      }).expect(201);

      restrictA('ai', [null]);
      const recusa = await post(`/api/intelligence/conversations/${interna}/summary`, sessionA);
      expect(recusa.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);

      probe.reset();
      const ok = await post(`/api/intelligence/conversations/${interna}/summary`, sessionA);
      expect(ok.body.status).toBe('ok');
      expect(llm.calls).toHaveLength(1);
    });

    it('última barreira: restrito ENTRE a checagem e a chamada, o gateway recusa e devolve a quota', async () => {
      // 1ª consulta: checagem da capacidade; 2ª: antes de reservar; a 3ª, no
      // gateway, já vê o contato restrito
      probe.restrictAfter = 2;
      const res = await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA);
      expect(res.body.status).toBe('content_restricted');
      expect(llm.calls).toEqual([]);
      const uso = await usoDeIa();
      expect(uso.reservas).toBe(0);
      expect(Number(uso.runs?.value ?? 0)).toBe(0);
    });

    it('resumo PERSISTIDO antes da restrição deixa de ser devolvido', async () => {
      await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA).expect(201);
      const antes = await get(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      );
      expect(antes.body.summary).toBe('O contato pediu horário.');

      restrictA('ai', [contactId]);
      const depois = await get(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      ).expect(200);
      expect(depois.body.summary).toBeUndefined();
    });

    it('rascunho pendente: some da conversa e da fila, aprovar é recusado e nada é enviado', async () => {
      llm.nextText = RASCUNHO;
      const gerado = await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);
      expect(gerado.body.status).toBe('proposed');

      restrictA('ai', [contactId]);
      const pendente = await get(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(200);
      expect(pendente.body.draft).toBeUndefined();
      const fila = await get('/api/intelligence/proposals?status=pending', sessionA).expect(200);
      expect(fila.body).toEqual([]);

      await post(
        `/api/intelligence/proposals/${gerado.body.proposalId}/approve-reply`,
        sessionA,
        {},
      ).expect(400);
      const proposta = await prisma.raw.aiProposal.findFirst({
        where: { id: gerado.body.proposalId },
      });
      expect(proposta!.status).toBe('expired');
      expect(await prisma.raw.message.count({ where: { direction: 'outbound' } })).toBe(0);
      await drain();
      expect(meta.sends).toEqual([]);
    });

    it('proposta de tarefa: aprovar é recusado e nenhuma tarefa nasce', async () => {
      llm.nextText = ACAO;
      const proposta = await post(
        `/api/intelligence/contacts/${contactId}/next-action`,
        sessionA,
      ).expect(201);
      expect(proposta.body.status).toBe('proposed');

      restrictA('ai', [contactId]);
      await post(
        `/api/intelligence/proposals/${proposta.body.proposalId}/approve`,
        sessionA,
      ).expect(400);
      expect(await prisma.raw.task.count()).toBe(0);
    });

    it('despacho: mensagem DA IA para contato restrito não sai; a de pessoa sai normalmente', async () => {
      llm.nextText = RASCUNHO;
      const gerado = await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);
      // aprovado sem edição: autoria `ai` (ADR-044.8)
      await post(
        `/api/intelligence/proposals/${gerado.body.proposalId}/approve-reply`,
        sessionA,
        {},
      ).expect(201);

      // ficou restrito DEPOIS da aprovação e ANTES do worker
      restrictA('ai', [contactId]);
      await drain();
      expect(meta.sends).toEqual([]);
      const dispatch = await prisma.raw.messageDispatch.findFirst();
      expect(dispatch).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });
      expect(await prisma.raw.usageReservation.count()).toBe(0);

      await post(`/api/conversations/${conversationId}/messages`, sessionA, {
        direction: 'outbound',
        body: 'Mensagem escrita pela recepção',
      }).expect(201);
      await drain();
      expect(meta.sends.map((s) => s.body)).toEqual(['Mensagem escrita pela recepção']);
    });

    it('expireContentFor: anula resultados e expira propostas do contato, com trilha', async () => {
      llm.nextText = RESUMO;
      await postWithKey(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
        'k-expira',
      ).expect(201);
      expect(
        await prisma.raw.idempotencyKey.count({ where: { endpoint: { endsWith: '/summary' } } }),
      ).toBe(1);
      llm.nextText = RASCUNHO;
      await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);

      const { IntelligenceService } = await import('../intelligence/intelligence.service');
      const { ClsService } = await import('nestjs-cls');
      const cls = app.get(ClsService);
      const resultado = await cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        return app.get(IntelligenceService).expireContentFor({ contactIds: [contactId] });
      });
      // o resumo grava só a conversa, o rascunho grava os dois: ambos alcançados
      expect(resultado).toMatchObject({ results: 2, proposals: 1 });
      const auditoria = await prisma.raw.auditLog.findFirst({
        where: { action: 'ai_run.results_expired' },
      });
      expect(auditoria!.after).toMatchObject({ results: 2, scope: 'contacts' });
      expect(
        await prisma.raw.idempotencyKey.count({ where: { endpoint: { endsWith: '/summary' } } }),
      ).toBe(0);
      const runs = await prisma.raw.aiRun.findMany({ where: { workspaceId: wsA.workspaceId } });
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.filter((run) => run.result !== null)).toEqual([]);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'ai_proposal.expired', actorType: 'system' },
      });
      expect(trilha).toBeTruthy();
    });

    it('REPLAY de idempotência: corpo guardado não sai depois da restrição; antes dela, sai', async () => {
      const rota = `/api/intelligence/conversations/${conversationId}/summary`;
      const primeira = await postWithKey(rota, sessionA, 'k-resumo').expect(201);
      expect(primeira.body.status).toBe('ok');

      // sem restrição: replay normal, com o corpo guardado (não regressão)
      const replay = await postWithKey(rota, sessionA, 'k-resumo').expect(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body.summary).toBe('O contato pediu horário.');

      restrictA('ai', [contactId]);
      const depois = await postWithKey(rota, sessionA, 'k-resumo').expect(201);
      expect(depois.headers['idempotent-replay']).toBeUndefined();
      expect(depois.body.status).toBe('content_restricted');
      expect(depois.body.summary).toBeUndefined();
      expect(llm.calls).toHaveLength(1); // a reexecução não chamou o provedor
    });

    it('REPLAY de próxima ação e de rascunho também passa pela guarda', async () => {
      llm.nextText = ACAO;
      const acao = `/api/intelligence/contacts/${contactId}/next-action`;
      await postWithKey(acao, sessionA, 'k-acao').expect(201);
      llm.nextText = RASCUNHO;
      const rascunho = `/api/intelligence/conversations/${conversationId}/reply-suggestion`;
      await postWithKey(rascunho, sessionA, 'k-rascunho').expect(201);

      restrictA('ai', [contactId]);
      const a = await postWithKey(acao, sessionA, 'k-acao').expect(201);
      expect(a.body.status).toBe('content_restricted');
      expect(a.body.title).toBeUndefined();
      const r = await postWithKey(rascunho, sessionA, 'k-rascunho').expect(201);
      expect(r.body.status).toBe('content_restricted');
      expect(r.body.draft).toBeUndefined();
    });

    it('fila: conversa RELIGADA a contato restrito tira o rascunho da fila', async () => {
      llm.nextText = RASCUNHO;
      await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);
      const outro = (await post('/api/contacts', sessionA, { name: 'Outro' }).expect(201)).body.id;
      await prisma.raw.conversation.updateMany({
        where: { id: conversationId },
        data: { contactId: outro },
      });
      restrictA('ai', [outro]); // o contato DA PROPOSTA segue liberado; o atual, não
      const fila = await get('/api/intelligence/proposals?status=pending', sessionA).expect(200);
      expect(fila.body).toEqual([]);
    });

    it('porta INDISPONÍVEL na aprovação: 503, sem efeito e SEM expirar a proposta', async () => {
      llm.nextText = ACAO;
      const proposta = await post(
        `/api/intelligence/contacts/${contactId}/next-action`,
        sessionA,
      ).expect(201);
      probe.fail = true;
      await post(
        `/api/intelligence/proposals/${proposta.body.proposalId}/approve`,
        sessionA,
      ).expect(503);
      const linha = await prisma.raw.aiProposal.findFirst({
        where: { id: proposta.body.proposalId },
      });
      expect(linha!.status).toBe('pending');
      expect(await prisma.raw.task.count()).toBe(0);

      probe.fail = false;
      await post(
        `/api/intelligence/proposals/${proposta.body.proposalId}/approve`,
        sessionA,
      ).expect(201);
    });

    it('porta INDISPONÍVEL no despacho: não envia, não descarta — envia quando volta', async () => {
      llm.nextText = RASCUNHO;
      const gerado = await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      ).expect(201);
      await post(
        `/api/intelligence/proposals/${gerado.body.proposalId}/approve-reply`,
        sessionA,
        {},
      ).expect(201);

      probe.fail = true;
      await drain();
      expect(meta.sends).toEqual([]);
      const dispatch = await prisma.raw.messageDispatch.findFirst();
      expect(dispatch).toMatchObject({
        state: 'failed_before_send',
        errorCode: 'restriction_unavailable',
      });

      probe.fail = false;
      await drain();
      expect(meta.sends.map((s) => s.body)).toEqual(['Temos horário amanhã às 10h.']);
    });

    it('porta FALHANDO: 503, nada vai ao provedor e NÃO se grava "restrito"', async () => {
      probe.fail = true;
      const res = await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA);
      expect(res.status).toBe(503);
      expect(llm.calls).toEqual([]);
      // falha de infraestrutura não vira recusa por restrição na trilha
      expect(await prisma.raw.aiRun.count({ where: { reasonCode: 'content_restricted' } })).toBe(0);
      expect(await prisma.raw.usageReservation.count()).toBe(0);
    });

    it('porta FALHANDO no REPLAY: 503 e o corpo guardado NÃO é apagado nem regerado', async () => {
      const rota = `/api/intelligence/conversations/${conversationId}/summary`;
      await postWithKey(rota, sessionA, 'k-oscila').expect(201);
      probe.fail = true;
      await postWithKey(rota, sessionA, 'k-oscila').expect(503);
      expect(llm.calls).toHaveLength(1);

      probe.fail = false;
      const replay = await postWithKey(rota, sessionA, 'k-oscila').expect(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(llm.calls).toHaveLength(1); // nenhuma chamada nova ao provedor
    });

    it('limpeza do cache de replay não toca reserva em andamento nem rota fora da IA', async () => {
      const base = {
        workspaceId: wsA.workspaceId,
        requestHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
      };
      await prisma.raw.idempotencyKey.createMany({
        data: [
          {
            ...base,
            key: 'em-curso',
            endpoint: 'POST /api/intelligence/conversations/:id/summary',
          },
          {
            ...base,
            key: 'gravada',
            endpoint: 'POST /api/intelligence/conversations/:id/summary',
            state: 'completed',
            responseStatus: 201,
          },
          {
            ...base,
            key: 'outra-rota',
            endpoint: 'POST /api/reports/:id/summary',
            state: 'completed',
            responseStatus: 201,
          },
        ],
      });
      const { IntelligenceService } = await import('../intelligence/intelligence.service');
      const { ClsService } = await import('nestjs-cls');
      const cls = app.get(ClsService);
      const resultado = await cls.run(async () => {
        cls.set('workspaceId', wsA.workspaceId);
        return app.get(IntelligenceService).expireContentFor('workspace');
      });
      expect(resultado.replays).toBe(1);
      const restantes = await prisma.raw.idempotencyKey.findMany({ select: { key: true } });
      expect(restantes.map((r) => r.key).sort()).toEqual(['em-curso', 'outra-rota']);
    });

    it('a restrição do workspace A não alcança o B', async () => {
      restrictA('ai', 'all');
      const contatoB = (await post('/api/contacts', sessionB, { name: 'Cliente B' }).expect(201))
        .body.id;
      const conversaB = (
        await post('/api/conversations', sessionB, { contactId: contatoB }).expect(201)
      ).body.id;
      await post(`/api/conversations/${conversaB}/messages`, sessionB, {
        direction: 'inbound',
        body: 'Olá',
      }).expect(201);
      await send('put', '/api/intelligence/consent', sessionB, { conversationContent: true });
      const res = await post(`/api/intelligence/conversations/${conversaB}/summary`, sessionB);
      expect(res.body.status).toBe('ok');
    });
  });

  // ── Webhooks: conferido NA ENTREGA ────────────────────────────────────────

  describe('webhooks (consumidor `webhook`)', () => {
    const deliverAll = async () => {
      await makeDue();
      const outbox = app.get(OutboxService);
      const webhooks = app.get(WebhooksService);
      for (const event of await outbox.claimBatch(100)) await webhooks.deliver(event);
    };

    /** Evento direto no outbox: cobre também os tipos que o Core ainda não emite. */
    const emit = (workspaceId: string, eventType: string, entityId: string) =>
      prisma.raw.outboxEvent.create({
        data: {
          workspaceId,
          eventType,
          payload: { id: entityId },
          dedupeKey: `${eventType}:${entityId}:${randomUUID()}`,
        },
      });

    const subscribe = (s: Session) =>
      post('/api/webhooks', s, {
        url: 'https://destino.veyra.test/hook',
        events: WEBHOOK_EVENTS_FOR_TEST,
      }).expect(201);

    /** Entidade de cada tipo de evento, ligada a `contato` (ou a nenhum). */
    const entityFor = async (
      eventType: string,
      contato: string | null,
      ws: WorkspaceFixture = wsA,
    ): Promise<string> => {
      if (eventType.startsWith('contact.')) return contato ?? randomUUID();
      if (eventType.startsWith('deal.')) {
        const deal = await prisma.raw.deal.create({
          data: {
            workspaceId: ws.workspaceId,
            title: 'Negócio',
            pipelineId: ws.pipelineId,
            stageId: Object.values(ws.stages)[0],
            contactId: contato,
            amountCents: 1000,
            currency: 'BRL',
            position: 0,
          },
        });
        return deal.id;
      }
      const task = await prisma.raw.task.create({
        data: { workspaceId: ws.workspaceId, title: 'Tarefa', contactId: contato },
      });
      return task.id;
    };

    it.each(WEBHOOK_EVENTS_FOR_TEST)(
      '%s ligado a contato restrito NÃO é entregue; sem restrição, é',
      async (eventType) => {
        await subscribe(sessionA);
        await deliverAll(); // limpa eventos da preparação
        hooks.length = 0;

        restrictA('webhook', [contactId]);
        await emit(wsA.workspaceId, eventType, await entityFor(eventType, contactId));
        await deliverAll();
        expect(hooks).toEqual([]);

        probe.reset();
        await emit(wsA.workspaceId, eventType, await entityFor(eventType, contactId));
        await deliverAll();
        expect(hooks).toHaveLength(1);
        expect(JSON.parse(hooks[0].body).type).toBe(eventType);
      },
    );

    it('deal DESLIGADO do contato entre emissão e entrega não sai (fotografia da emissão)', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      restrictA('webhook', [contactId]);

      // emitido pelo domínio, ligado ao contato: a fotografia registra o vínculo
      const deal = (await post('/api/deals', sessionA, { title: 'Pacote', contactId }).expect(201))
        .body.id;
      const evento = await prisma.raw.outboxEvent.findFirst({
        where: { eventType: 'deal.created' },
      });
      expect(evento!.subjectContactIds).toEqual([contactId]);
      // desligado ANTES da entrega: a resolução de agora já não vê o contato
      await prisma.raw.deal.updateMany({ where: { id: deal }, data: { contactId: null } });
      await deliverAll();
      expect(hooks).toEqual([]);

      // prova de que é a FOTOGRAFIA que segura: o mesmo cenário sem ela sairia
      const semFotografia = await prisma.raw.outboxEvent.create({
        data: {
          workspaceId: wsA.workspaceId,
          eventType: 'deal.created',
          payload: { id: deal, title: 'Pacote', amountCents: 0, currency: 'BRL' },
          dedupeKey: `sem-fotografia:${deal}`,
        },
      });
      await deliverAll();
      expect(hooks).toHaveLength(1);
      expect(JSON.parse(hooks[0].body).id).toBe(semFotografia.id);
    });

    it('contato que entra pelo WhatsApp: o contact.created já nasce com a fotografia', async () => {
      const evento = await prisma.raw.outboxEvent.findFirst({
        where: { workspaceId: wsA.workspaceId, eventType: 'contact.created' },
      });
      expect(evento!.subjectContactIds).toEqual([contactId]);
    });

    it('tarefa de AUTOMAÇÃO com o título do deal de um contato restrito não sai', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      await post('/api/automations', sessionA, {
        name: 'Ligar sobre o negócio',
        trigger: 'deal.created',
        action: 'create_task',
        actionConfig: { title: 'Ligar sobre {{title}}', dueInDays: 1 },
      }).expect(201);
      restrictA('webhook', [contactId]);

      await post('/api/deals', sessionA, { title: 'Botox', contactId }).expect(201);
      for (let i = 0; i < 4; i += 1) await drain(); // automação, depois as entregas
      expect(await prisma.raw.task.count({ where: { title: 'Ligar sobre Botox' } })).toBe(1);
      expect(hooks.map((h) => JSON.parse(h.body).type)).toEqual([]);
    });

    it('cadeia: deal ligado a contato restrito DEPOIS da automação — a tarefa derivada não sai', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      await post('/api/automations', sessionA, {
        name: 'Ligar sobre o negócio',
        trigger: 'deal.created',
        action: 'create_task',
        actionConfig: { title: 'Ligar sobre {{title}}', dueInDays: 1 },
      }).expect(201);

      // nasce SEM contato: deal.created sai (não era de ninguém) e a automação
      // cria a tarefa, cujo task.created herda a fotografia vazia
      const deal = (await post('/api/deals', sessionA, { title: 'Peeling' }).expect(201)).body.id;
      await drain();
      expect(hooks.map((h) => JSON.parse(h.body).type)).toEqual(['deal.created']);
      hooks.length = 0;

      // agora o deal é ligado a um contato restrito, ANTES da entrega da tarefa
      await prisma.raw.deal.updateMany({ where: { id: deal }, data: { contactId } });
      restrictA('webhook', [contactId]);
      await drain();
      expect(await prisma.raw.task.count({ where: { title: 'Ligar sobre Peeling' } })).toBe(1);
      expect(hooks).toEqual([]); // a raiz da cadeia agora é do contato restrito
    });

    it('tarefa ligada ao paciente SÓ pelo deal também não sai', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      restrictA('webhook', [contactId]);
      const dealId = await entityFor('deal.created', contactId);
      const task = await prisma.raw.task.create({
        data: { workspaceId: wsA.workspaceId, title: 'Retorno', dealId },
      });
      await emit(wsA.workspaceId, 'task.created', task.id);
      await deliverAll();
      expect(hooks).toEqual([]);
    });

    it('porta INDISPONÍVEL: o evento volta ao outbox (não é descartado) e sai quando ela volta', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      probe.fail = true;
      const evento = await emit(wsA.workspaceId, 'contact.updated', contactId);
      await drain();
      expect(hooks).toEqual([]);
      const linha = await prisma.raw.outboxEvent.findFirst({ where: { id: evento.id } });
      expect(linha!.status).toBe('pending');
      expect(linha!.lastError).toMatch(/indisponível/);

      probe.fail = false;
      await drain();
      expect(hooks).toHaveLength(1);
    });

    it('deal e tarefa SEM contato continuam saindo, mesmo com tudo restrito', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      restrictA('webhook', 'all');
      await emit(wsA.workspaceId, 'deal.created', await entityFor('deal.created', null));
      await emit(wsA.workspaceId, 'task.created', await entityFor('task.created', null));
      await deliverAll();
      expect(hooks.map((h) => JSON.parse(h.body).type).sort()).toEqual([
        'deal.created',
        'task.created',
      ]);
    });

    it('entidade que sumiu vira `null` para a porta (desconhecido não sai se `null` é restrito)', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      restrictA('webhook', [null]);
      await emit(wsA.workspaceId, 'deal.won', randomUUID());
      await deliverAll();
      expect(hooks).toEqual([]);
    });

    it('evento emitido ANTES da restrição e ainda pendente não sai', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      await post('/api/contacts', sessionA, { name: 'Novo lead' }).expect(201); // contact.created pendente
      restrictA('webhook', 'all');
      await drain();
      expect(hooks).toEqual([]);
      const pendentes = await prisma.raw.outboxEvent.count({ where: { status: 'pending' } });
      expect(pendentes).toBe(0); // suprimido = concluído, não fica girando
    });

    it('consumidores SEPARADOS: restrição só para IA não bloqueia webhook, e vice-versa', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;

      restrictA('ai', [contactId]);
      await emit(wsA.workspaceId, 'contact.updated', contactId);
      await deliverAll();
      expect(hooks).toHaveLength(1);

      probe.reset();
      restrictA('webhook', [contactId]);
      const res = await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA);
      expect(res.body.status).toBe('ok');
    });

    it('porta FALHANDO não entrega (e a entrega lança, para o dispatcher reagendar)', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      probe.fail = true;
      await emit(wsA.workspaceId, 'contact.updated', contactId);
      await expect(deliverAll()).rejects.toThrow(/indisponível/);
      expect(hooks).toEqual([]);
    });

    it('a restrição do workspace A não suprime eventos do B', async () => {
      await subscribe(sessionA);
      await subscribe(sessionB);
      await deliverAll();
      hooks.length = 0;
      restrictA('webhook', 'all');
      probe.calls = []; // só as consultas da ação no B interessam aqui
      const contatoB = (await post('/api/contacts', sessionB, { name: 'Cliente B' }).expect(201))
        .body.id;
      await deliverAll();
      expect(hooks).toHaveLength(1);
      expect(JSON.parse(hooks[0].body).data.id).toBe(contatoB);
      const consultas = probe.calls.filter((c) => c.consumer === 'webhook');
      expect(consultas.length).toBeGreaterThan(0);
      expect(consultas.every((c) => c.workspaceId === wsB.workspaceId)).toBe(true);
    });
  });
});

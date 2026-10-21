import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { webhookEventSchema, type WebhookEvent } from '@veyra/contracts';
import request from 'supertest';
import { CryptoService } from '../../common/crypto.service';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../../channels/meta.transport';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../../intelligence/llm/llm.client';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxService } from '../../outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WEBHOOK_TRANSPORT, WebhooksService } from '../../webhooks/webhooks.service';
import { createTestApp } from '../../../test/integration/app';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsContentRestriction } from './clinics-content-restriction';
import { CLINICS_MODELS } from './clinics.extension';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
/** Todos os tipos do catálogo, lidos do contrato: tipo novo entra sozinho. */
const WEBHOOK_EVENTS: WebhookEvent[] = [...webhookEventSchema.options];
const APP_SECRET = process.env.META_APP_SECRET as string;
const PHONE_NUMBER_ID = '109876543288';

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

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * Bateria do ADR-048 §6.6 com a porta REAL do Clinics (F1.b). A F1.a provou que
 * o Core consulta a porta em todo ponto de checagem e falha fechado; aqui se
 * prova a REGRA: quem é restrito, quando, e que desativar não a levanta.
 * Nenhuma porta de teste: o que decide é `ClinicsContentRestriction`.
 */
describe('Clinics — restrição de conteúdo com a porta real e API de liberação (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let port: ClinicsContentRestriction;
  const llm = new FakeLlm();
  const meta = new FakeMetaTransport();
  const hooks: { url: string; body: string }[] = [];

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
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
    port = app.get(ClinicsContentRestriction);
  });
  afterAll(async () => {
    await app.close();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let sessionA: Session;
  let sessionB: Session;
  let conversationId: string;
  /** contato criado ANTES de qualquer ativação, vindo pelo WhatsApp */
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
  const send = (method: 'post' | 'put' | 'delete', path: string, s: Session, body?: unknown) =>
    request(http)
      [method](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const post = (path: string, s: Session, body?: unknown) => send('post', path, s, body);
  const del = (path: string, s: Session) => send('delete', path, s);
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  /** Ativação e desativação REAIS (o serviço da CLI); a sessão do Owner cai e é refeita. */
  const enable = async (slug = 'acme') => {
    await app.get(ClinicsActivationService).enable(slug);
    if (slug === 'acme') sessionA = await loginAs('owner-a@veyra.test');
    else sessionB = await loginAs('owner-b@veyra.test');
  };
  const disable = async () => {
    await app.get(ClinicsActivationService).disable('acme');
    sessionA = await loginAs('owner-a@veyra.test');
  };
  const release = (id: string, s: Session = sessionA, reason = 'supplier') =>
    post(`/api/clinics/contacts/${id}/ai-release`, s, { reason });

  const makeDue = () =>
    prisma.raw.outboxEvent.updateMany({
      where: { status: 'pending' },
      data: { nextRetryAt: new Date(0) },
    });
  const drain = async () => {
    await makeDue();
    return app.get(JobsService).dispatchPending(50);
  };
  const deliverAll = async () => {
    await makeDue();
    const outbox = app.get(OutboxService);
    const webhooks = app.get(WebhooksService);
    for (const event of await outbox.claimBatch(100)) await webhooks.deliver(event);
  };
  const subscribe = (s: Session) =>
    post('/api/webhooks', s, {
      url: 'https://destino.veyra.test/hook',
      events: WEBHOOK_EVENTS,
    }).expect(201);
  const emit = (workspaceId: string, eventType: string, entityId: string) =>
    prisma.raw.outboxEvent.create({
      data: {
        workspaceId,
        eventType,
        payload: { id: entityId },
        dedupeKey: `${eventType}:${entityId}:${randomUUID()}`,
      },
    });
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
  const hookTypes = () => hooks.map((h) => JSON.parse(h.body).type as string);

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
                contacts: [{ wa_id: '5511977776666', profile: { name: 'Paciente Teste' } }],
                messages: [
                  {
                    id: `wamid.IN${timestamp}${Math.random()}`,
                    from: '5511977776666',
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

  /** Toda a superfície de IA do Core, para um contato (e a conversa dele, se houver). */
  const iaRecusa = async (contato: string, conversa?: string) => {
    llm.calls = [];
    if (conversa) {
      llm.nextText = RESUMO;
      const resumo = await post(`/api/intelligence/conversations/${conversa}/summary`, sessionA);
      expect(resumo.body.status).toBe('content_restricted');
      llm.nextText = RASCUNHO;
      const rascunho = await post(
        `/api/intelligence/conversations/${conversa}/reply-suggestion`,
        sessionA,
      );
      expect(rascunho.body.status).toBe('content_restricted');
      const persistido = await get(
        `/api/intelligence/conversations/${conversa}/summary`,
        sessionA,
      ).expect(200);
      expect(persistido.body.summary).toBeUndefined();
    }
    llm.nextText = ACAO;
    const acao = await post(`/api/intelligence/contacts/${contato}/next-action`, sessionA);
    expect(acao.body.status).toBe('content_restricted');
    const score = await get(`/api/intelligence/contacts/${contato}/score`, sessionA).expect(200);
    expect(score.body.explanation).toBeNull();
    expect(llm.calls).toEqual([]);
    expect(await prisma.raw.usageReservation.count()).toBe(0);
  };

  /** Nenhum tipo de evento ligado a `contato` chega ao webhook do A. */
  const webhookSuprime = async (contato: string) => {
    await deliverAll();
    hooks.length = 0;
    for (const eventType of WEBHOOK_EVENTS) {
      await emit(wsA.workspaceId, eventType, await entityFor(eventType, contato));
    }
    await deliverAll();
    expect(hooks).toEqual([]);
  };

  beforeEach(async () => {
    llm.calls = [];
    llm.nextText = RESUMO;
    meta.sends = [];
    hooks.length = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
    sessionA = await loginAs('owner-a@veyra.test');
    sessionB = await loginAs('owner-b@veyra.test');
    for (const s of [sessionA, sessionB]) {
      await send('put', '/api/intelligence/consent', s, { conversationContent: true }).expect(200);
    }
    const channel = await prisma.raw.channel.create({
      data: { workspaceId: wsA.workspaceId, type: 'whatsapp', name: 'WhatsApp' },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: wsA.workspaceId,
        channelId: channel.id,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: 'waba-clinics',
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

  // ── Ativação ──────────────────────────────────────────────────────────────

  describe('ativação', () => {
    it('contato ANTERIOR à ativação: liberado antes, restrito para IA e webhook no commit — sem backfill', async () => {
      await subscribe(sessionA);
      // antes: Core puro, a IA funciona
      const antes = await post(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      );
      expect(antes.body.status).toBe('ok');
      expect(llm.calls).toHaveLength(1);
      llm.nextText = ACAO;
      const proposta = await post(`/api/intelligence/contacts/${contactId}/next-action`, sessionA);
      expect(proposta.body.status).toBe('proposed');
      llm.nextText = RASCUNHO;
      const rascunho = await post(
        `/api/intelligence/conversations/${conversationId}/reply-suggestion`,
        sessionA,
      );
      expect(rascunho.body.status).toBe('proposed');

      await enable();
      // nada foi gravado por contato: a restrição é derivada
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
      // a limpeza pós-commit da ativação RODOU: o resultado anterior foi zerado
      // no banco, não só ocultado na leitura
      const runs = await prisma.raw.aiRun.findMany({ where: { workspaceId: wsA.workspaceId } });
      expect(runs.filter((run) => run.result !== null)).toEqual([]);
      expect(
        await prisma.raw.auditLog.findFirst({ where: { action: 'ai_run.results_expired' } }),
      ).toMatchObject({ after: { scope: 'workspace' } });

      await iaRecusa(contactId, conversationId);
      // o que foi gerado ANTES da ativação: some, e aprovar é recusado
      const fila = await get('/api/intelligence/proposals?status=pending', sessionA).expect(200);
      expect(fila.body).toEqual([]);
      await post(
        `/api/intelligence/proposals/${proposta.body.proposalId}/approve`,
        sessionA,
      ).expect(400);
      await post(
        `/api/intelligence/proposals/${rascunho.body.proposalId}/approve-reply`,
        sessionA,
        {},
      ).expect(400);
      expect(await prisma.raw.task.count()).toBe(0);

      // contato criado DEPOIS da ativação: restrito do mesmo jeito
      const novo = (await post('/api/contacts', sessionA, { name: 'Lead novo' }).expect(201)).body
        .id as string;
      await iaRecusa(novo);
      await webhookSuprime(contactId);
      await webhookSuprime(novo);
    });

    it('mensagem DA IA aprovada antes da ativação não é despachada; a escrita por pessoa é', async () => {
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

      await enable();
      await drain();
      expect(meta.sends).toEqual([]);
      expect(await prisma.raw.messageDispatch.findFirst()).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });

      await post(`/api/conversations/${conversationId}/messages`, sessionA, {
        direction: 'outbound',
        body: 'Mensagem escrita pela recepção',
      }).expect(201);
      await drain();
      expect(meta.sends.map((s) => s.body)).toEqual(['Mensagem escrita pela recepção']);
    });

    it('evento emitido ANTES da ativação e ainda pendente no outbox não sai', async () => {
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      await post('/api/contacts', sessionA, { name: 'Lead' }).expect(201); // contact.created pendente
      await enable();
      await drain();
      expect(hooks).toEqual([]);
      expect(await prisma.raw.outboxEvent.count({ where: { status: 'pending' } })).toBe(0);
    });
  });

  // ── Desativação e reativação ──────────────────────────────────────────────

  describe('desativação e reativação', () => {
    it('depois do disable, toda a superfície de IA recusa (existentes e criados depois) e nada de contato sai por webhook', async () => {
      await subscribe(sessionA);
      await enable();
      await disable();
      await iaRecusa(contactId, conversationId);
      const depois = (
        await post('/api/contacts', sessionA, { name: 'Pós-desativação' }).expect(201)
      ).body.id as string;
      await iaRecusa(depois);
      await webhookSuprime(contactId);
      await webhookSuprime(depois);
    });

    it('proposta de contato liberado: o disable EXPIRA o conteúdo de IA (ADR-047 adendo 6 §6), e aprovar recusa sem criar tarefa', async () => {
      await enable();
      await release(contactId).expect(201);
      llm.nextText = ACAO;
      const proposta = await post(`/api/intelligence/contacts/${contactId}/next-action`, sessionA);
      expect(proposta.body.status).toBe('proposed');

      // a desativação expira o conteúdo de IA do workspace depois do commit,
      // como a ativação; a recusa pela reconferência sob as travas, com a
      // mudança concorrente, está em clinics-restriction-changes
      await disable();
      expect(
        (await prisma.raw.aiProposal.findFirst({ where: { id: proposta.body.proposalId } }))!
          .status,
      ).toBe('expired');
      const recusa = await post(
        `/api/intelligence/proposals/${proposta.body.proposalId}/approve`,
        sessionA,
      ).expect(400);
      expect(recusa.body.message).toMatch(/revisada|restrito/);
      expect(
        (await prisma.raw.aiProposal.findFirst({ where: { id: proposta.body.proposalId } }))!
          .status,
      ).toBe('expired');
      expect(await prisma.raw.task.count()).toBe(0);
      const fila = await get('/api/intelligence/proposals?status=pending', sessionA).expect(200);
      expect(fila.body).toEqual([]);
    });

    it('liberação de IA: vale com o Clinics ativo, fica SUSPENSA no disable e volta no enable', async () => {
      await enable();
      await release(contactId).expect(201);
      const liberado = await post(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      );
      expect(liberado.body.status).toBe('ok');

      await disable();
      await iaRecusa(contactId, conversationId);

      await enable();
      llm.calls = [];
      llm.nextText = RESUMO;
      const deVolta = await post(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      );
      expect(deVolta.body.status).toBe('ok');
      expect(llm.calls).toHaveLength(1);
    });

    it('porta com ClinicsSettings em `disabled` e NENHUM outro dado: restrito (regressão — não filtra por status)', async () => {
      await enable();
      await release(contactId).expect(201);
      await disable();
      // sobra só a linha de ativação, desativada
      await prisma.raw.clinicsContactRelease.deleteMany({});
      await prisma.raw.clinicsUnit.deleteMany({});
      expect(await prisma.raw.clinicsSettings.findFirst()).toMatchObject({ status: 'disabled' });
      for (const consumer of ['ai', 'webhook'] as const) {
        expect(await port.restricted(wsA.workspaceId, consumer, [contactId, null])).toEqual([
          true,
          true,
        ]);
      }
    });

    /** Uma linha de cada modelo do vertical; tipado sobre a lista: modelo novo sem fábrica não compila. */
    const SOMENTE: Record<(typeof CLINICS_MODELS)[number], () => Promise<unknown>> = {
      ClinicsSettings: () =>
        prisma.raw.clinicsSettings.create({
          data: { workspaceId: wsA.workspaceId, status: 'disabled', disabledAt: new Date() },
        }),
      ClinicsUnit: () =>
        prisma.raw.clinicsUnit.create({ data: { workspaceId: wsA.workspaceId, name: 'Sala 2' } }),
      ClinicsContactRelease: async () => {
        const dono = await prisma.raw.membership.findFirst({
          where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
        });
        return prisma.raw.clinicsContactRelease.create({
          data: {
            workspaceId: wsA.workspaceId,
            contactId,
            consumer: 'ai',
            reason: 'supplier',
            releasedByMembershipId: dono!.id,
          },
        });
      },
      ClinicsService: () =>
        prisma.raw.clinicsService.create({
          data: { workspaceId: wsA.workspaceId, name: 'Limpeza de pele', durationMin: 60 },
        }),
      ClinicsProfessional: () =>
        prisma.raw.clinicsProfessional.create({
          data: { workspaceId: wsA.workspaceId, name: 'Profissional' },
        }),
      // junção, horários, agendamento e atendimento não existem sem os pais
      // (agendamento e atendimento passam pelo paciente, que já é presença): as
      // linhas deles vêm junto, e
      // a cobertura POR MODELO da presença é a do teste estático (CLINICS_MODELS
      // igual ao schema, percorrida pela porta)
      ClinicsProfessionalService: async () => {
        const workspaceId = wsA.workspaceId;
        const prof = await prisma.raw.clinicsProfessional.create({
          data: { workspaceId, name: 'P' },
        });
        const serv = await prisma.raw.clinicsService.create({
          data: { workspaceId, name: 'S', durationMin: 30 },
        });
        return prisma.raw.clinicsProfessionalService.create({
          data: { workspaceId, professionalId: prof.id, serviceId: serv.id },
        });
      },
      ClinicsWorkingHours: async () => {
        const workspaceId = wsA.workspaceId;
        const prof = await prisma.raw.clinicsProfessional.create({
          data: { workspaceId, name: 'P' },
        });
        const unit = await prisma.raw.clinicsUnit.create({ data: { workspaceId, name: 'U' } });
        return prisma.raw.clinicsWorkingHours.create({
          data: {
            workspaceId,
            professionalId: prof.id,
            unitId: unit.id,
            weekday: 1,
            startMinute: 480,
            endMinute: 720,
          },
        });
      },
      ClinicsPatient: async () => {
        const dono = await prisma.raw.membership.findFirst({
          where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
        });
        return prisma.raw.clinicsPatient.create({
          data: { workspaceId: wsA.workspaceId, contactId, createdByMembershipId: dono!.id },
        });
      },
      ClinicsAppointment: () => agendamentoComPais(),
      ClinicsAttendance: async () => {
        const ag = await agendamentoComPais();
        return prisma.raw.clinicsAttendance.create({
          data: {
            workspaceId: wsA.workspaceId,
            appointmentId: ag.id,
            professionalId: ag.professionalId,
            completedAt: new Date(),
            recordedByMembershipId: ag.createdByMembershipId,
          },
        });
      },
      // o pacote passa pelo paciente e pelo serviço, que vêm junto (F3.1)
      ClinicsPackage: async () => {
        const workspaceId = wsA.workspaceId;
        const dono = await prisma.raw.membership.findFirst({
          where: { workspaceId, role: { systemKey: 'owner' } },
        });
        const paciente = await prisma.raw.clinicsPatient.create({
          data: { workspaceId, contactId, createdByMembershipId: dono!.id },
        });
        const serv = await prisma.raw.clinicsService.create({
          data: { workspaceId, name: 'S', durationMin: 30 },
        });
        return prisma.raw.clinicsPackage.create({
          data: {
            workspaceId,
            patientId: paciente.id,
            serviceId: serv.id,
            totalSessions: 3,
            currency: 'BRL',
            createdByMembershipId: dono!.id,
          },
        });
      },
    };

    /** Agendamento fictício com os pais (paciente, profissional, serviço, unidade). */
    async function agendamentoComPais() {
      const workspaceId = wsA.workspaceId;
      const dono = await prisma.raw.membership.findFirst({
        where: { workspaceId, role: { systemKey: 'owner' } },
      });
      const paciente = await prisma.raw.clinicsPatient.create({
        data: { workspaceId, contactId, createdByMembershipId: dono!.id },
      });
      const prof = await prisma.raw.clinicsProfessional.create({
        data: { workspaceId, name: 'P' },
      });
      const serv = await prisma.raw.clinicsService.create({
        data: { workspaceId, name: 'S', durationMin: 30 },
      });
      const unit = await prisma.raw.clinicsUnit.create({ data: { workspaceId, name: 'U' } });
      return prisma.raw.clinicsAppointment.create({
        data: {
          workspaceId,
          patientId: paciente.id,
          professionalId: prof.id,
          serviceId: serv.id,
          unitId: unit.id,
          startsAt: new Date('2026-11-02T12:00:00Z'),
          endsAt: new Date('2026-11-02T12:30:00Z'),
          createdByMembershipId: dono!.id,
        },
      });
    }

    it.each([...CLINICS_MODELS])(
      'presença com %s (sem ClinicsSettings ativo; junção e horários vêm com os pais): restrito para os dois consumidores',
      async (model) => {
        await SOMENTE[model]();
        for (const consumer of ['ai', 'webhook'] as const) {
          expect(
            await port.restricted(wsA.workspaceId, consumer, [contactId, randomUUID(), null]),
          ).toEqual([true, true, true]);
          // o B nunca teve o Clinics: nada restrito
          expect(await port.restricted(wsB.workspaceId, consumer, [randomUUID(), null])).toEqual([
            false,
            false,
          ]);
        }
      },
    );

    it('id de contato EXCLUÍDO e `null`: restritos, mesmo com Clinics ativo e liberação anterior', async () => {
      await enable();
      const fornecedor = (await post('/api/contacts', sessionA, { name: 'Fornecedor' }).expect(201))
        .body.id as string;
      await release(fornecedor).expect(201);
      expect(await port.restricted(wsA.workspaceId, 'ai', [fornecedor, null])).toEqual([
        false,
        true,
      ]);
      await del(`/api/contacts/${fornecedor}`, sessionA).expect(200);
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0); // cascata
      expect(await port.restricted(wsA.workspaceId, 'ai', [fornecedor])).toEqual([true]);
    });

    it('enable → disable → enable → disable repetidos nunca abrem janela para contato restrito', async () => {
      await enable();
      const fornecedor = (await post('/api/contacts', sessionA, { name: 'Fornecedor' }).expect(201))
        .body.id as string;
      await release(fornecedor).expect(201);
      const activation = app.get(ClinicsActivationService);
      let alternando = true;
      const observado: boolean[] = [];
      const vigia = (async () => {
        while (alternando) {
          // `contactId` não tem liberação: restrito para IA em qualquer estado;
          // `fornecedor` tem, mas para webhook nunca vale
          observado.push(...(await port.restricted(wsA.workspaceId, 'ai', [contactId])));
          observado.push(...(await port.restricted(wsA.workspaceId, 'webhook', [fornecedor])));
        }
      })();
      for (let i = 0; i < 3; i++) {
        await activation.disable('acme');
        await activation.enable('acme');
      }
      await activation.disable('acme');
      alternando = false;
      await vigia;
      expect(observado.length).toBeGreaterThan(0);
      expect(observado.every(Boolean)).toBe(true);
    });
  });

  // ── Webhooks ──────────────────────────────────────────────────────────────

  describe('webhooks', () => {
    it.each(WEBHOOK_EVENTS)(
      '%s ligado a contato LIBERADO para IA não sai do A; no B, sem Clinics, sai',
      async (eventType) => {
        await enable();
        await release(contactId).expect(201);
        await subscribe(sessionA);
        await subscribe(sessionB);
        await deliverAll();
        hooks.length = 0;

        await emit(wsA.workspaceId, eventType, await entityFor(eventType, contactId));
        await deliverAll();
        expect(hooks).toEqual([]);

        const contatoB = await prisma.raw.contact.create({
          data: { workspaceId: wsB.workspaceId, name: 'Cliente B' },
        });
        await emit(wsB.workspaceId, eventType, await entityFor(eventType, contatoB.id, wsB));
        await deliverAll();
        expect(hookTypes()).toEqual([eventType]);
      },
    );

    it('deal e tarefa SEM contato continuam saindo com o Clinics ativo', async () => {
      await enable();
      await subscribe(sessionA);
      await deliverAll();
      hooks.length = 0;
      await emit(wsA.workspaceId, 'deal.created', await entityFor('deal.created', null));
      await emit(wsA.workspaceId, 'task.created', await entityFor('task.created', null));
      await deliverAll();
      expect(hookTypes().sort()).toEqual(['deal.created', 'task.created']);
    });
  });

  // ── Workspace sem o Clinics ───────────────────────────────────────────────

  it('workspace SEM o Clinics, com o A ativo: IA e webhooks como antes', async () => {
    await enable();
    await subscribe(sessionB);
    await deliverAll();
    hooks.length = 0;
    const contatoB = (await post('/api/contacts', sessionB, { name: 'Cliente B' }).expect(201)).body
      .id as string;
    await deliverAll();
    expect(hookTypes()).toEqual(['contact.created']);

    llm.calls = [];
    llm.nextText = ACAO;
    const acao = await post(`/api/intelligence/contacts/${contatoB}/next-action`, sessionB);
    expect(acao.body.status).toBe('proposed');
    expect(llm.calls).toHaveLength(1);
    for (const consumer of ['ai', 'webhook'] as const) {
      expect(await port.restricted(wsB.workspaceId, consumer, [contatoB, null])).toEqual([
        false,
        false,
      ]);
    }
  });

  // ── API do vertical ───────────────────────────────────────────────────────

  describe('API', () => {
    it('status acompanha o ciclo de vida, só do próprio workspace', async () => {
      expect((await get('/api/clinics/status', sessionA).expect(200)).body).toEqual({
        active: false,
      });
      await enable();
      expect((await get('/api/clinics/status', sessionA).expect(200)).body).toEqual({
        active: true,
      });
      expect((await get('/api/clinics/status', sessionB).expect(200)).body).toEqual({
        active: false,
      });
      await disable();
      expect((await get('/api/clinics/status', sessionA).expect(200)).body).toEqual({
        active: false,
      });
      await request(http).get('/api/clinics/status').expect(401);
    });

    it('403 sem a chave: workspace sem o Clinics, e Member e Guest do workspace ativo', async () => {
      await get('/api/clinics/ai-releases', sessionB).expect(403);
      await release(randomUUID(), sessionB).expect(403);
      await enable();
      for (const email of ['member-a@veyra.test', 'guest-a@veyra.test']) {
        const s = await loginAs(email);
        await get('/api/clinics/ai-releases', s).expect(403);
        await release(contactId, s).expect(403);
        await del(`/api/clinics/contacts/${contactId}/ai-release`, s).expect(403);
      }
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
    });

    it('404 no caso residual: chave presente com o Clinics desativado, mesmo com sessão nova', async () => {
      await enable();
      await disable();
      // chave posta por fora do produto, sem derrubar sessões
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: wsA.roles.owner,
          permissionKey: 'clinics:restriction:manage',
        },
      });
      const s = await loginAs('owner-a@veyra.test');
      await get('/api/clinics/ai-releases', s).expect(404);
      await release(contactId, s).expect(404);
      await del(`/api/clinics/contacts/${contactId}/ai-release`, s).expect(404);
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
    });

    it('conceder: motivo fora da lista, consumidor no corpo e id inválido → 400; contato de outro workspace → 404', async () => {
      await enable();
      await release(contactId, sessionA, 'paciente').expect(400);
      await post(`/api/clinics/contacts/${contactId}/ai-release`, sessionA, {
        reason: 'supplier',
        consumer: 'webhook',
      }).expect(400);
      await release('nao-e-uuid').expect(400);
      const deOutro = await prisma.raw.contact.create({
        data: { workspaceId: wsB.workspaceId, name: 'Cliente B' },
      });
      await release(deOutro.id).expect(404);
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
    });

    it('conceder de novo devolve a liberação existente (motivo original) e audita uma vez, sem dado do contato', async () => {
      await enable();
      const primeira = await release(contactId, sessionA, 'staff').expect(201);
      expect(primeira.body).toMatchObject({ contactId, reason: 'staff' });
      const segunda = await release(contactId, sessionA, 'partner').expect(201);
      expect(segunda.body).toEqual(primeira.body);
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(1);
      const trilha = await prisma.raw.auditLog.findMany({
        where: { action: 'clinics.ai_release.granted' },
      });
      expect(trilha).toHaveLength(1);
      // o FATO e os ids: qual contato, consumidor e motivo — nada do contato
      expect(trilha[0].after).toEqual({ contactId, consumer: 'ai', reason: 'staff' });
      const lista = await get('/api/clinics/ai-releases', sessionA).expect(200);
      expect(lista.body).toEqual({ items: [primeira.body], nextCursor: null });
    });

    it('revogar: restringe na hora, expira o conteúdo gerado enquanto liberado e audita; revogar de novo → 404', async () => {
      await enable();
      await release(contactId).expect(201);
      await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA).expect(201);
      const visivel = await get(
        `/api/intelligence/conversations/${conversationId}/summary`,
        sessionA,
      );
      expect(visivel.body.summary).toBe('O contato pediu horário.');

      expect(
        (await del(`/api/clinics/contacts/${contactId}/ai-release`, sessionA).expect(200)).body,
      ).toEqual({ ok: true });
      expect(await port.restricted(wsA.workspaceId, 'ai', [contactId])).toEqual([true]);
      await iaRecusa(contactId, conversationId);
      const runs = await prisma.raw.aiRun.findMany({ where: { workspaceId: wsA.workspaceId } });
      expect(runs.filter((run) => run.result !== null)).toEqual([]);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'clinics.ai_release.revoked' },
      });
      // a linha foi apagada; a trilha ainda diz de QUEM era a liberação
      expect(trilha!.before).toEqual({ contactId, consumer: 'ai', reason: 'supplier' });
      await del(`/api/clinics/contacts/${contactId}/ai-release`, sessionA).expect(404);
    });

    it('contato LIBERADO vira PACIENTE (F2.1): a bateria inteira recusa, o conteúdo gerado enquanto liberado expira, e nada dele sai por webhook', async () => {
      await subscribe(sessionA);
      await enable();
      await release(contactId).expect(201);
      await post(`/api/intelligence/conversations/${conversationId}/summary`, sessionA).expect(201);

      await post('/api/clinics/patients', sessionA, { contactId }).expect(201);
      expect(await port.restricted(wsA.workspaceId, 'ai', [contactId])).toEqual([true]);
      await iaRecusa(contactId, conversationId);
      const runs = await prisma.raw.aiRun.findMany({ where: { workspaceId: wsA.workspaceId } });
      expect(runs.filter((run) => run.result !== null)).toEqual([]);
      await webhookSuprime(contactId);
    });

    it('listar mostra só as liberações do próprio workspace', async () => {
      await enable();
      await enable('beta');
      const contatoB = (await post('/api/contacts', sessionB, { name: 'Fornecedor B' }).expect(201))
        .body.id as string;
      await release(contactId).expect(201);
      await release(contatoB, sessionB).expect(201);
      const listaA = await get('/api/clinics/ai-releases', sessionA).expect(200);
      expect(listaA.body.items.map((r: { contactId: string }) => r.contactId)).toEqual([contactId]);
      const listaB = await get('/api/clinics/ai-releases', sessionB).expect(200);
      expect(listaB.body.items.map((r: { contactId: string }) => r.contactId)).toEqual([contatoB]);
    });

    it('listar pagina por cursor, sem repetir nem pular; cursor de outro formato → 400', async () => {
      await enable();
      const nomes = ['Fornecedor 1', 'Fornecedor 2', 'Fornecedor 3'];
      for (const name of nomes) {
        const id = (await post('/api/contacts', sessionA, { name }).expect(201)).body.id as string;
        await release(id).expect(201);
      }
      await release(contactId).expect(201);
      const vistos: string[] = [];
      let cursor: string | null = null;
      let paginas = 0;
      do {
        const pagina: request.Response = await get(
          `/api/clinics/ai-releases?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
          sessionA,
        ).expect(200);
        vistos.push(...pagina.body.items.map((r: { contactName: string }) => r.contactName));
        cursor = pagina.body.nextCursor;
        paginas += 1;
      } while (cursor);
      expect(paginas).toBe(2);
      expect([...vistos].sort()).toEqual([...nomes, 'Paciente Teste'].sort());
      expect(new Set(vistos).size).toBe(4);
      await get('/api/clinics/ai-releases?cursor=nao-e-cursor', sessionA).expect(400);
      await get('/api/clinics/ai-releases?limit=101', sessionA).expect(400);
    });
  });
});

import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { AuditService } from '../audit/audit.service';
import { normalizarTodos, normalizarWorkspace } from '../cli/phones-normalize.core';
import { CryptoService } from '../common/crypto.service';
import { ConsentPurposesService } from '../consents/consent-purposes.service';
import { derivadosDosTelefones } from '../contacts/phone-identity';
import { ContentUseGuard } from '../content-use/content-use.guard';
import { CONFIG_DA_GUARDA, CONFIG_PADRAO_DA_GUARDA } from '../content-use/content-use.pools';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { CHAVE } from '../content-use/restriction-locks';
import { ContentRestrictionService } from '../extensions/content-restriction';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../intelligence/llm/llm.client';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import { agoraNoBanco } from '../../test/integration/clock';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { esperarBloqueadosPor, esperarTravasPendentes } from '../../test/integration/locks';
import { CancelamentoDeDespachos } from './dispatch-cancellation.service';
import { META_TRANSPORT, type MetaTransport, type SendOutcome } from './meta.transport';
import { WhatsappSendService } from './whatsapp-send.service';

/**
 * F4.1c-1 (ADR-052, decisões de 2026-10-26): os escritores de telefone
 * coordenados pela trava dos escritores em massa, a normalização que revoga o
 * consentimento do número que deixa de ser exato, e o cancelamento neutro com o
 * estado `canceled`. Números e nomes FICTÍCIOS.
 */

const APP_SECRET = process.env.META_APP_SECRET as string;
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const NUMERO_A1 = '109876543501';
const NUMERO_A2 = '109876543502';
const NUMERO_B = '109876543503';
const N = '5511987654321';
const N_E164 = `+${N}`;
const OUTRO = '+5521912345678';

/** Prazos curtos: a falha por prazo aparece em segundos, não nos 10 s de produção. */
const CONFIG = { ...CONFIG_PADRAO_DA_GUARDA, mudancaTravaMs: 2_000, mudancaTransacaoMs: 10_000 };

class FakeLlm implements LlmClient {
  readonly model = 'claude-sonnet-5';
  nextText = '{}';
  async complete(_request: LlmRequest): Promise<LlmOutcome> {
    return { kind: 'ok', text: this.nextText, inputTokens: 500, outputTokens: 100 };
  }
}

class FakeMeta implements MetaTransport {
  /** só os envios que SAÍRAM */
  sends: { to: string; body?: string }[] = [];
  /** a próxima chamada espera isto antes de responder */
  antes: (() => Promise<void>) | null = null;
  /** a próxima chamada falha assim, sem sair */
  falha: SendOutcome | null = null;
  async sendText(_c: unknown, to: string, body: string): Promise<SendOutcome> {
    const antes = this.antes;
    this.antes = null;
    if (antes) await antes();
    const falha = this.falha;
    this.falha = null;
    if (falha) return falha;
    this.sends.push({ to, body });
    return { ok: true, externalId: `wamid.ENVIADA.${this.sends.length}` };
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.sends.push({ to });
    return { ok: true, externalId: `wamid.T.${this.sends.length}` };
  }
  async fetchMedia(): Promise<never> {
    throw new Error('não usado');
  }
}

const RASCUNHO = JSON.stringify({
  body: 'Temos horário amanhã às 10h.',
  rationale: 'Pedido de horário.',
  injectionAttempt: false,
});

interface Session {
  cookieHeader: string;
  csrf: string;
}

/** Um portão que o teste abre quando quiser. */
function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

describe('F4.1c-1 — escritores de telefone, normalização e cancelamento neutro (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  const llm = new FakeLlm();
  const meta = new FakeMeta();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: LLM_CLIENT, useValue: llm },
        { provide: META_TRANSPORT, useValue: meta },
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
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
  let canalA1: string;
  let canalA2: string;
  let owner: Session;
  let ownerB: Session;
  let finalidade: string;
  let seq = 0;

  const login = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const enviar = (
    metodo: 'post' | 'patch' | 'put' | 'delete',
    path: string,
    s: Session,
    body?: unknown,
  ) =>
    request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf)
      .send((body ?? {}) as object);
  const registrar = (path: string, s: Session, body: unknown) =>
    enviar('post', path, s, body).set('idempotency-key', randomUUID());
  const webhook = (corpo: unknown) => {
    const raw = JSON.stringify(corpo);
    return request(http)
      .post('/api/channels/whatsapp/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-hub-signature-256',
        `sha256=${createHmac('sha256', APP_SECRET).update(Buffer.from(raw)).digest('hex')}`,
      )
      .send(raw);
  };
  const chega = (de = N, numero = NUMERO_A1) =>
    webhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: numero },
                messages: [
                  {
                    id: `wamid.ID${++seq}`,
                    from: de,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: `Mensagem fictícia ${seq}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    }).expect(200);
  const contato = async (nome: string, phones: string[], s = owner): Promise<string> =>
    (await enviar('post', '/api/contacts', s, { name: nome, phones }).expect(201)).body.id;
  const conversaDe = () =>
    prisma.raw.conversation.findFirstOrThrow({
      where: { workspaceId: wsA.workspaceId, externalAddress: N_E164, channelId: canalA1 },
      orderBy: { createdAt: 'desc' },
    });
  const conceder = (contactId: string, canal = canalA1, numero = N_E164) =>
    registrar(`/api/contacts/${contactId}/consents`, owner, {
      channelId: canal,
      number: numero,
      purposeId: finalidade,
      origin: 'in_person',
    });
  const parar = (contactId: string, numero = N_E164) =>
    registrar(`/api/contacts/${contactId}/stop`, owner, { number: numero, origin: 'phone' });
  const importar = (nome: string, telefone = N_E164, s = owner) =>
    registrar('/api/contacts/import', s, { rows: [{ name: nome, phone: telefone }] });
  const consentimento = (id: string) => prisma.raw.consent.findUniqueOrThrow({ where: { id } });
  const despachoDe = (messageId: string) =>
    prisma.raw.messageDispatch.findFirstOrThrow({ where: { messageId } });
  const drenar = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const credencialDeVerdade = () =>
    prisma.raw.channelCredential.updateMany({
      where: { workspaceId: wsA.workspaceId },
      data: { tokenCipher: app.get(CryptoService).encrypt('token-ficticio') },
    });
  const responder = async (body = 'Resposta fictícia') => {
    const conversa = await conversaDe();
    return (
      await enviar('post', `/api/conversations/${conversa.id}/messages`, owner, {
        direction: 'outbound',
        body,
      }).expect(201)
    ).body.id as string;
  };
  const contadorDeEnvios = async () =>
    (
      await prisma.raw.usageCounter.findFirst({
        where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
      })
    )?.value ?? 0n;

  const endereco = (numero: string) =>
    CHAVE.entidade(
      wsA.workspaceId,
      app.get(TravasDeIdentidade).endereco(wsA.workspaceId, numero.replace(/\D/g, '').slice(-8)),
    );
  /** Uma conexão que segura travas numa transação aberta, para as corridas. */
  const travar = async (chave: string, compartilhada = false) => {
    const c = new Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query('BEGIN');
    await c.query(
      `SELECT pg_advisory_xact_lock${compartilhada ? '_shared' : ''}(hashtextextended($1, 0))`,
      [chave],
    );
    return c;
  };
  const soltar = async (c: Client) => {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  };
  /** A outra operação está ESPERANDO uma trava consultiva, lida ao vivo. */
  const esperando = (descricao: string) => esperarTravasPendentes(TEST_DATABASE_URL, 1, descricao);
  /**
   * Os portões e as requisições de cada teste: o que falha no meio não deixa
   * operação pausada nem requisição em voo para o próximo (nem segura o processo
   * do jest aberto).
   */
  const abertos: (() => void)[] = [];
  const emCurso: Promise<unknown>[] = [];
  afterEach(async () => {
    for (const abrir of abertos.splice(0)) abrir();
    await Promise.allSettled(emCurso.splice(0));
  });
  const disparar = <T>(p: Promise<T>): Promise<T> => {
    emCurso.push(p);
    return p;
  };
  /** Para `metodo` de `servico` DEPOIS do original, na primeira chamada, até o portão abrir. */
  const pausarDepois = (servico: object, metodo: string) => {
    const chegou = portao();
    const segue = portao();
    abertos.push(segue.abrir);
    const alvo = servico as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = alvo[metodo].bind(servico);
    jest.spyOn(alvo, metodo).mockImplementationOnce(async (...args: unknown[]) => {
      const valor = await original(...args);
      chegou.abrir();
      await segue.aberto;
      return valor;
    });
    return { chegou: chegou.aberto, segue: segue.abrir };
  };
  /** Para `metodo` de `servico` ANTES do original, na primeira chamada, até o portão abrir. */
  const pausarAntes = (servico: object, metodo: string) => {
    const chegou = portao();
    const segue = portao();
    abertos.push(segue.abrir);
    const alvo = servico as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = alvo[metodo].bind(servico);
    jest.spyOn(alvo, metodo).mockImplementationOnce(async (...args: unknown[]) => {
      chegou.abrir();
      await segue.aberto;
      return original(...args);
    });
    return { chegou: chegou.aberto, segue: segue.abrir };
  };
  /** A normalização da região US, parada na trilha da primeira revogação — com a trava de massa EXCLUSIVA. */
  const normalizacaoParada = () => {
    const chegou = portao();
    const segue = portao();
    abertos.push(segue.abrir);
    const audit = app.get(AuditService);
    const pausada = {
      record: async (...args: Parameters<AuditService['record']>) => {
        chegou.abrir();
        await segue.aberto;
        return audit.record(...args);
      },
    } as unknown as AuditService;
    const resultado = disparar(
      normalizarWorkspace(
        prisma,
        pausada,
        app.get(TravasDeIdentidade),
        { id: wsA.workspaceId, phoneRegion: 'US' },
        { travaMs: 2_000, transacaoMs: 20_000 },
      ),
    );
    return { chegou: chegou.aberto, segue: segue.abrir, resultado };
  };
  /** A região muda para US: o celular brasileiro sem DDI deixa de ser exato. */
  const regiaoUS = () =>
    prisma.raw.workspace.update({ where: { id: wsA.workspaceId }, data: { phoneRegion: 'US' } });
  /** Um rascunho da IA para a conversa de N, aprovado: o despacho fica `reserved`. */
  const aprovarRascunho = async () => {
    await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
      200,
    );
    const conversa = await conversaDe();
    llm.nextText = RASCUNHO;
    const sugestao = await enviar(
      'post',
      `/api/intelligence/conversations/${conversa.id}/reply-suggestion`,
      owner,
    ).expect(201);
    await enviar(
      'post',
      `/api/intelligence/proposals/${sugestao.body.proposalId}/approve-reply`,
      owner,
      {},
    ).expect(201);
    return (await prisma.raw.messageDispatch.findFirstOrThrow({ where: { fromAiProposal: true } }))
      .messageId;
  };
  /** No contexto do workspace, como uma requisição o teria. */
  const noWorkspace = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('workspaceId', workspaceId);
      return await fn();
    });
  };
  const normalizar = (ws = wsA, audit: AuditService = app.get(AuditService), travaMs = 2_000) =>
    normalizarWorkspace(
      prisma,
      audit,
      app.get(TravasDeIdentidade),
      { id: ws.workspaceId, phoneRegion: 'BR' },
      { travaMs, transacaoMs: 20_000 },
    );
  /** O telefone como estava ANTES da normalização: a forma ainda não preenchida. */
  const semForma = (contactId: string) =>
    prisma.raw.contact.updateMany({
      where: { id: contactId },
      data: { phonesNormalized: [] },
    });

  beforeEach(async () => {
    meta.sends = [];
    meta.antes = null;
    meta.falha = null;
    jest.restoreAllMocks();
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    for (const [ws, numero, guardar] of [
      [wsA.workspaceId, NUMERO_A1, (id: string) => (canalA1 = id)],
      [wsA.workspaceId, NUMERO_A2, (id: string) => (canalA2 = id)],
      [wsB.workspaceId, NUMERO_B, () => undefined],
    ] as const) {
      const canal = await prisma.raw.channel.create({
        data: { workspaceId: ws, type: 'whatsapp', name: `WhatsApp ${numero}` },
      });
      guardar(canal.id);
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          phoneNumberId: numero,
          businessAccountId: `waba-${numero}`,
          tokenCipher: 'cifrado',
        },
      });
    }
    finalidade = (
      await app.get(ConsentPurposesService).criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes de horário marcado',
        category: 'utility',
        fields: ['nome'],
      })
    ).purposeId;
    owner = await login('dono@veyra.test');
    ownerB = await login('dono-b@veyra.test');
  });

  // ── A trava dos escritores em massa ─────────────────────────────────────

  describe('a trava dos escritores em massa', () => {
    it('a importação sem a trava no prazo: 409, e nada é importado nem cobrado', async () => {
      const t = await travar(CHAVE.telefones(wsA.workspaceId), true);
      try {
        const antes = await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } });
        const r = await importar('Yara Fictícia');
        expect(r.status).toBe(409);
        expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
          antes,
        );
        expect(
          await prisma.raw.usageCounter.findFirst({
            where: { workspaceId: wsA.workspaceId, metric: 'contacts', value: { gt: 0 } },
          }),
        ).toBeNull();
      } finally {
        await soltar(t);
      }
    });

    it('conceder primeiro: a importação espera o commit dele (e não o contrário)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const t = await travar(endereco(N_E164));
      try {
        const c = conceder(ana).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a concessão' });
        const i = importar('Yara Fictícia').then((r) => r);
        // a importação espera a trava de massa, que a concessão segura compartilhada
        await esperarBloqueadosPor(t, 2, { descricao: 'a concessão e a importação' });
        await t.query('ROLLBACK');
        expect((await c).status).toBe(201);
        expect((await i).status).toBe(201);
      } finally {
        await soltar(t);
      }
    });

    it('a importação primeiro: o pedido de parar espera, relê o conjunto e vale para a importada', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      const travas = jest.spyOn(app.get(TravasDeIdentidade), 'paraNumero');
      const pausa = pausarDepois(app.get(TravasDeIdentidade), 'paraImportacao');
      const i = disparar(importar('Yara Fictícia').then((r) => r));
      await pausa.chegou;
      const p = disparar(parar(ana).then((r) => r));
      await esperando('o pedido de parar, atrás da importação');
      pausa.segue();
      expect((await i).status).toBe(201);
      expect((await p).status).toBe(201);
      const yara = await prisma.raw.contact.findFirstOrThrow({ where: { name: 'Yara Fictícia' } });
      // a primeira passada leu só a Ana; sob as travas, a Yara apareceu e houve
      // uma segunda passada com as duas
      const passadas = travas.mock.calls.map(([, escopo]) => [...escopo.contactIds].sort());
      expect(passadas[passadas.length - 1]).toEqual([ana, yara.id].sort());
    });

    it('a importação com o envio da IA parado na guarda: 409, e a ingestão do workspace entra logo depois (o prazo curto, pela unidade)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      await aprovarRascunho();
      const chamou = portao();
      const segue = portao();
      abertos.push(segue.abrir);
      meta.antes = async () => {
        chamou.abrir();
        await segue.aberto;
      };
      const envio = disparar(app.get(JobsService).dispatchPending());
      // a chamada começou: a guarda segura a trava de massa compartilhada
      await chamou.aberto;
      const inicio = Date.now();
      await importar('Yara Fictícia', OUTRO).expect(409);
      expect(Date.now() - inicio).toBeLessThan(CONFIG.mudancaTransacaoMs);
      expect(await prisma.raw.contact.count({ where: { name: 'Yara Fictícia' } })).toBe(0);
      // a importação desistiu: a fila da trava compartilhada andou
      await chega();
      segue.abrir();
      await envio;
      expect(meta.sends).toHaveLength(1);
    });

    it('a trava é do workspace: a importação de outro workspace não espera (P0)', async () => {
      const t = await travar(CHAVE.telefones(wsA.workspaceId));
      try {
        await importar('Yara Fictícia B', N_E164, ownerB).expect(201);
      } finally {
        await soltar(t);
      }
    });

    it('a importação de mil números pega uma trava só; o tempo é medido, não prometido', async () => {
      const linhas = Array.from({ length: 1000 }, (_, i) => ({
        name: `Importado ${i}`,
        phone: `+5511${String(900000000 + i).padStart(9, '0')}`,
      }));
      const inicio = Date.now();
      await enviar('post', '/api/contacts/import', owner, { rows: linhas })
        .set('idempotency-key', randomUUID())
        .expect(201);
      const ms = Date.now() - inicio;
      // evidência para o ADR (a expectativa de "poucos segundos"), sem limite apertado
      console.log(`[F4.1c-1] importação de 1000 números: ${ms} ms`);
      expect(ms).toBeLessThan(60_000);
      expect(await prisma.raw.contact.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
        1000,
      );
    });
  });

  // ── A normalização ──────────────────────────────────────────────────────

  describe('a normalização (phones:normalize)', () => {
    it('só a apresentação muda: os números exatos são os mesmos, e nada é revogado', async () => {
      const ana = await contato('Ana Fictícia', ['+55 11 98765-4321']);
      const c = (await conceder(ana).expect(201)).body.id as string;
      await semForma(ana);
      const r = await normalizar();
      expect(r).toMatchObject({ alterados: 1, revogados: 0 });
      expect(await consentimento(c)).toMatchObject({ activeMark: true });
      expect(await normalizar()).toMatchObject({ alterados: 0, revogados: 0 });
    });

    it('o número que deixa de ser exato revoga (number_removed), na mesma transação; rodar de novo não faz nada', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      const c = (await conceder(ana).expect(201)).body.id as string;
      // a forma guardada some e a região deixa de validar o número: ele não é
      // mais exato do contato
      await prisma.raw.workspace.update({
        where: { id: wsA.workspaceId },
        data: { phoneRegion: 'US' },
      });
      const r = await normalizarWorkspace(
        prisma,
        app.get(AuditService),
        app.get(TravasDeIdentidade),
        { id: wsA.workspaceId, phoneRegion: 'US' },
        { travaMs: 2_000, transacaoMs: 20_000 },
      );
      expect(r).toMatchObject({ alterados: 1, revogados: 1 });
      expect(await consentimento(c)).toMatchObject({
        revocationReason: 'number_removed',
        activeMark: null,
        revokedByMembershipId: null,
      });
      const trilha = await prisma.raw.auditLog.findFirstOrThrow({
        where: { action: 'consent.revoked', entityId: c },
      });
      expect(trilha).toMatchObject({ actorType: 'system', actorId: 'cli:phones-normalize' });
      expect(JSON.stringify(trilha)).not.toContain(N);
      expect(
        await normalizarWorkspace(
          prisma,
          app.get(AuditService),
          app.get(TravasDeIdentidade),
          { id: wsA.workspaceId, phoneRegion: 'US' },
          { travaMs: 2_000, transacaoMs: 20_000 },
        ),
      ).toMatchObject({ alterados: 0, revogados: 0 });
    });

    it('a falha no meio desfaz o workspace: nenhum número atualizado com o consentimento antigo; a retomada conclui', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      const bia = await contato('Bia Fictícia', ['(21) 91234-5678']);
      const ca = (await conceder(ana).expect(201)).body.id as string;
      const cb = (await conceder(bia, canalA1, OUTRO).expect(201)).body.id as string;
      await prisma.raw.workspace.update({
        where: { id: wsA.workspaceId },
        data: { phoneRegion: 'US' },
      });
      const antes = await prisma.raw.contact.findMany({
        where: { workspaceId: wsA.workspaceId },
        select: { id: true, phonesNormalized: true },
      });
      // a trilha falha no primeiro consentimento: a transação inteira cai
      const quebrada = {
        record: async () => {
          throw new Error('falha fictícia no meio');
        },
      } as unknown as AuditService;
      await expect(
        normalizarWorkspace(
          prisma,
          quebrada,
          app.get(TravasDeIdentidade),
          { id: wsA.workspaceId, phoneRegion: 'US' },
          { travaMs: 2_000, transacaoMs: 20_000 },
        ),
      ).rejects.toThrow(/falha fictícia/);
      expect(
        await prisma.raw.contact.findMany({
          where: { workspaceId: wsA.workspaceId },
          select: { id: true, phonesNormalized: true },
        }),
      ).toEqual(antes);
      expect(await consentimento(ca)).toMatchObject({ activeMark: true });
      expect(await consentimento(cb)).toMatchObject({ activeMark: true });
      const retomada = await normalizarWorkspace(
        prisma,
        app.get(AuditService),
        app.get(TravasDeIdentidade),
        { id: wsA.workspaceId, phoneRegion: 'US' },
        { travaMs: 2_000, transacaoMs: 20_000 },
      );
      expect(retomada).toMatchObject({ alterados: 2, revogados: 2 });
    });

    it('sem a trava no prazo, nada muda, e o erro sai para a CLI relatar', async () => {
      const ana = await contato('Ana Fictícia', ['+55 11 98765-4321']);
      await semForma(ana);
      const t = await travar(CHAVE.telefones(wsA.workspaceId), true);
      try {
        await expect(normalizar(wsA, app.get(AuditService), 300)).rejects.toThrow();
        expect(
          (await prisma.raw.contact.findUniqueOrThrow({ where: { id: ana } })).phonesNormalized,
        ).toEqual([]);
      } finally {
        await soltar(t);
      }
    });

    it('a normalização primeiro: segura a trava até o fim, e a concessão espera e vê o número que já não é exato', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      // um consentimento noutro canal: a normalização o revoga e pausa ali,
      // ainda com a trava de massa exclusiva
      await conceder(ana, canalA2).expect(201);
      await prisma.raw.workspace.update({
        where: { id: wsA.workspaceId },
        data: { phoneRegion: 'US' },
      });
      const chegou = portao();
      const segue = portao();
      abertos.push(segue.abrir);
      const audit = app.get(AuditService);
      const pausada = {
        record: async (...args: Parameters<AuditService['record']>) => {
          chegou.abrir();
          await segue.aberto;
          return audit.record(...args);
        },
      } as unknown as AuditService;
      const n = disparar(
        normalizarWorkspace(
          prisma,
          pausada,
          app.get(TravasDeIdentidade),
          { id: wsA.workspaceId, phoneRegion: 'US' },
          { travaMs: 2_000, transacaoMs: 20_000 },
        ),
      );
      await chegou.aberto;
      const c = disparar(conceder(ana).then((r) => r));
      await esperando('a concessão, atrás da normalização');
      segue.abrir();
      expect(await n).toMatchObject({ revogados: 1 });
      // o número já não é exato do contato: a concessão relê e recusa
      expect((await c).status).toBe(400);
    });

    it('conceder primeiro: a normalização espera, e revoga o consentimento recém-criado', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await prisma.raw.workspace.update({
        where: { id: wsA.workspaceId },
        data: { phoneRegion: 'US' },
      });
      const t = await travar(endereco(N_E164));
      try {
        const c = conceder(ana).then((r) => r);
        await esperarBloqueadosPor(t, 1, { descricao: 'a concessão' });
        const n = normalizarWorkspace(
          prisma,
          app.get(AuditService),
          app.get(TravasDeIdentidade),
          { id: wsA.workspaceId, phoneRegion: 'US' },
          { travaMs: 5_000, transacaoMs: 20_000 },
        );
        await esperarBloqueadosPor(t, 2, { descricao: 'a concessão e a normalização' });
        await t.query('ROLLBACK');
        const concedido = await c;
        expect(concedido.status).toBe(201);
        expect(await n).toMatchObject({ revogados: 1 });
        expect(await consentimento(concedido.body.id)).toMatchObject({
          revocationReason: 'number_removed',
        });
      } finally {
        await soltar(t);
      }
    });

    it('a trava é do workspace: normalizar um não espera o outro (P0)', async () => {
      const t = await travar(CHAVE.telefones(wsB.workspaceId));
      try {
        const ana = await contato('Ana Fictícia', ['+55 11 98765-4321']);
        await semForma(ana);
        expect(await normalizar()).toMatchObject({ alterados: 1 });
      } finally {
        await soltar(t);
      }
    });

    it('normalizar mil contatos: o tempo com a trava exclusiva é medido, não prometido', async () => {
      const linhas = Array.from({ length: 1000 }, (_, i) => ({
        name: `Importado ${i}`,
        phone: `+5511${String(900000000 + i).padStart(9, '0')}`,
      }));
      await enviar('post', '/api/contacts/import', owner, { rows: linhas })
        .set('idempotency-key', randomUUID())
        .expect(201);
      await prisma.raw.contact.updateMany({
        where: { workspaceId: wsA.workspaceId },
        data: { phonesNormalized: [] },
      });
      const inicio = Date.now();
      const r = await normalizar();
      const ms = Date.now() - inicio;
      // evidência para o ADR: enquanto isso, os escritores e leitores de
      // telefone do workspace esperam (a ingestão, até o prazo dela)
      console.log(`[F4.1c-1] normalização de 1000 contatos: ${ms} ms`);
      expect(ms).toBeLessThan(60_000);
      expect(r).toMatchObject({ lidos: 1000, alterados: 1000, revogados: 0 });
    });

    it('editar sem telefone e excluir a empresa durante a passada: a espera pela linha tem prazo (409), e nada muda', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await conceder(ana, canalA2).expect(201);
      const empresa = await prisma.raw.company.create({
        data: { workspaceId: wsA.workspaceId, name: 'Empresa Fictícia' },
      });
      await prisma.raw.contact.updateMany({ where: { id: ana }, data: { companyId: empresa.id } });
      await regiaoUS();
      // a normalização já atualizou a linha da Ana e para na revogação
      const n = normalizacaoParada();
      await n.chegou;
      const inicio = Date.now();
      await enviar('patch', `/api/contacts/${ana}`, owner, { name: 'Ana Editada' }).expect(409);
      await enviar('delete', `/api/companies/${empresa.id}`, owner).expect(409);
      // o prazo das mudanças (2 s aqui), não o da transação da normalização
      expect(Date.now() - inicio).toBeLessThan(10_000);
      n.segue();
      expect(await n.resultado).toMatchObject({ revogados: 1 });
      expect(
        await prisma.raw.contact.findFirstOrThrow({
          where: { id: ana },
          select: { name: true, companyId: true },
        }),
      ).toEqual({ name: 'Ana Fictícia', companyId: empresa.id });
    });

    it('os MESMOS telefones no PATCH não regravam as formas: a região mudada fica para a normalização, que revoga', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      const c = (await conceder(ana).expect(201)).body.id as string;
      await regiaoUS();
      await enviar('patch', `/api/contacts/${ana}`, owner, {
        name: 'Ana Editada',
        phones: ['(11) 98765-4321'],
      }).expect(200);
      expect(
        (await prisma.raw.contact.findFirstOrThrow({ where: { id: ana } })).phonesNormalized,
      ).toEqual([N_E164]);
      expect(await consentimento(c)).toMatchObject({ activeMark: true });
      expect(await normalizar(wsA, app.get(AuditService))).toMatchObject({
        alterados: 0,
        revogados: 0,
      });
      const r = await normalizarWorkspace(
        prisma,
        app.get(AuditService),
        app.get(TravasDeIdentidade),
        { id: wsA.workspaceId, phoneRegion: 'US' },
        { travaMs: 2_000, transacaoMs: 20_000 },
      );
      expect(r).toMatchObject({ alterados: 1, revogados: 1 });
      expect(await consentimento(c)).toMatchObject({ revocationReason: 'number_removed' });
    });

    it('o consentimento de um número que já não era exato (a CLI antiga) também sai; rodar de novo não revoga nada', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      const c = (await conceder(ana).expect(201)).body.id as string;
      // a CLI anterior recalculou as formas na região US e não revogou
      await prisma.raw.contact.updateMany({
        where: { id: ana },
        data: derivadosDosTelefones(['(11) 98765-4321'], 'US'),
      });
      const passada = () =>
        normalizarWorkspace(
          prisma,
          app.get(AuditService),
          app.get(TravasDeIdentidade),
          { id: wsA.workspaceId, phoneRegion: 'US' },
          { travaMs: 2_000, transacaoMs: 20_000 },
        );
      expect(await passada()).toMatchObject({ alterados: 0, revogados: 1 });
      expect(await consentimento(c)).toMatchObject({
        revocationReason: 'number_removed',
        activeMark: null,
      });
      expect(await passada()).toMatchObject({ alterados: 0, revogados: 0 });
    });

    it('a CLI relata o workspace que falha só com o tipo e o código, segue para o próximo e devolve a falha', async () => {
      const ana = await contato('Ana Fictícia', ['+55 11 98765-4321']);
      await semForma(ana);
      const bia = await contato('Bia Fictícia B', ['+55 21 91234-5678'], ownerB);
      await prisma.raw.contact.updateMany({ where: { id: bia }, data: { phonesNormalized: [] } });
      const linhas: string[] = [];
      const erros: string[] = [];
      const t = await travar(CHAVE.telefones(wsA.workspaceId));
      let falhas: number;
      try {
        falhas = await normalizarTodos(
          prisma,
          app.get(AuditService),
          app.get(TravasDeIdentidade),
          { log: (l) => linhas.push(l), erro: (l) => erros.push(l) },
          { travaMs: 300, transacaoMs: 20_000 },
        );
      } finally {
        await soltar(t);
      }
      expect(falhas).toBe(1);
      expect(erros).toHaveLength(1);
      expect(erros[0]).toMatch(/^acme: NÃO normalizado \(\S+ \S+\); nada mudou/);
      // nem número, nem nome, nem a mensagem do erro
      expect(erros[0]).not.toMatch(/\d{8}|Ana|lock|timeout/i);
      expect(linhas).toEqual([expect.stringMatching(/^beta: 1 contatos lidos, 1 atualizados/)]);
      expect(
        (await prisma.raw.contact.findUniqueOrThrow({ where: { id: ana } })).phonesNormalized,
      ).toEqual([]);
    });

    it('a ingestão durante a passada: o workspace dela fica para a reentrega, o outro workspace do mesmo POST segue, e a reentrega entra depois', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await conceder(ana, canalA2).expect(201);
      await regiaoUS();
      const lote = {
        object: 'whatsapp_business_account',
        entry: [NUMERO_A1, NUMERO_B].map((numero, i) => ({
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: numero },
                messages: [
                  {
                    id: `wamid.LOTE.${i}`,
                    from: N,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: `Mensagem fictícia do lote ${i}` },
                  },
                ],
              },
            },
          ],
        })),
      };
      const conversas = (workspaceId: string) =>
        prisma.raw.conversation.count({ where: { workspaceId } });
      const n = normalizacaoParada();
      await n.chegou;
      const r1 = await webhook(lote);
      expect(r1.status).not.toBe(200);
      // o B entrou; o A espera a passada
      expect(await conversas(wsB.workspaceId)).toBe(1);
      expect(await conversas(wsA.workspaceId)).toBe(0);
      n.segue();
      await n.resultado;
      await webhook(lote).expect(200);
      expect(await conversas(wsA.workspaceId)).toBe(1);
      // a reentrega do B é deduplicada
      expect(await prisma.raw.message.count({ where: { workspaceId: wsB.workspaceId } })).toBe(1);
    });

    it('o marcador da resposta de pessoa espera a passada e vê o número que deixou de ser exato', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await conceder(ana, canalA2).expect(201);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      await regiaoUS();
      const n = normalizacaoParada();
      await n.chegou;
      const envio = disparar(app.get(JobsService).dispatchPending());
      await esperando('o marcador, atrás da normalização');
      n.segue();
      await n.resultado;
      await envio;
      expect(await despachoDe(m)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'number_not_exact',
      });
      expect(meta.sends).toEqual([]);
    });

    it('o envio da IA espera a passada sob a guarda e vê o número que deixou de ser exato', async () => {
      const ana = await contato('Ana Fictícia', ['(11) 98765-4321']);
      await conceder(ana, canalA2).expect(201);
      await credencialDeVerdade();
      await chega();
      const m = await aprovarRascunho();
      await regiaoUS();
      const n = normalizacaoParada();
      await n.chegou;
      const envio = disparar(app.get(JobsService).dispatchPending());
      await esperando('a guarda do envio da IA, atrás da normalização');
      n.segue();
      await n.resultado;
      await envio;
      expect(await despachoDe(m)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'number_not_exact',
        dispatchedAt: null,
      });
      expect(meta.sends).toEqual([]);
    });
  });

  // ── O cancelamento neutro ───────────────────────────────────────────────

  describe('o cancelamento neutro e o estado canceled', () => {
    const cancelar = (alvo: { numero: string } | { messageIds: string[] }) =>
      noWorkspace(wsA.workspaceId, () =>
        (
          prisma.db as unknown as {
            $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
          }
        ).$transaction((tx) =>
          app
            .get(CancelamentoDeDespachos)
            .cancelarNaTransacao(tx, wsA.workspaceId, alvo as never, 'stop_requested'),
        ),
      );

    it('o reservado vai a canceled e a reserva volta UMA vez; repetir não muda nada', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      const comReserva = await contadorDeEnvios();
      expect(await cancelar({ messageIds: [m] })).toEqual({ cancelados: 1, pedidos: 0, emVoo: 0 });
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        reservationId: null,
      });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(await cancelar({ messageIds: [m] })).toEqual({ cancelados: 0, pedidos: 0, emVoo: 0 });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      // o worker nunca reivindica o cancelado
      await drenar();
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', attempts: 0 });
      expect(meta.sends).toEqual([]);
    });

    it('enviado, incerto e recusado não voltam a ser elegíveis', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const ids = [await responder('um'), await responder('dois'), await responder('três')];
      const estados = ['sent', 'unknown_after_dispatch', 'failed_permanent'] as const;
      for (const [i, state] of estados.entries()) {
        await prisma.raw.messageDispatch.updateMany({
          where: { messageId: ids[i] },
          data: { state, reservationId: null },
        });
      }
      expect(await cancelar({ numero: N_E164 })).toEqual({ cancelados: 0, pedidos: 0, emVoo: 0 });
      for (const [i, state] of estados.entries()) {
        expect(await despachoDe(ids[i])).toMatchObject({ state, cancelRequestedAt: null });
      }
    });

    it('o reivindicado sem marcador não chama o transporte: o worker perde a posse', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      const posse = randomUUID();
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: {
          state: 'sending',
          claimToken: posse,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await cancelar({ numero: N_E164 })).toMatchObject({ cancelados: 1 });
      const marcou = await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m, claimToken: posse, state: 'sending' },
        data: { dispatchedAt: new Date() },
      });
      expect(marcou.count).toBe(0);
      await drenar();
      expect(meta.sends).toEqual([]);
    });

    it('o em voo recebe o pedido uma vez; o esgotamento e as varreduras não tiram o cancelado do lugar, e o em voo abandonado fica incerto', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const m = await responder();
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: {
          state: 'sending',
          claimToken: randomUUID(),
          dispatchedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await cancelar({ numero: N_E164 })).toEqual({ cancelados: 0, pedidos: 1, emVoo: 1 });
      const pedido = (await despachoDe(m)).cancelRequestedAt;
      expect(pedido).not.toBeNull();
      expect(await cancelar({ numero: N_E164 })).toEqual({ cancelados: 0, pedidos: 0, emVoo: 1 });
      expect((await despachoDe(m)).cancelRequestedAt).toEqual(pedido);
      // o cancelado também não é tocado pelo esgotamento
      const outra = await responder('outra');
      await cancelar({ messageIds: [outra] });
      await app.get(WhatsappSendService).markExhausted(wsA.workspaceId, outra);
      expect(await despachoDe(outra)).toMatchObject({ state: 'canceled' });
      // as varreduras, com as linhas velhas e sem retentador: o em voo
      // abandonado pode ter saído (incerto, nunca reenviado); o cancelado fica
      const agora = await agoraNoBanco(prisma);
      await prisma.raw.outboxEvent.updateMany({
        where: { eventType: 'whatsapp.send_pending' },
        data: { status: 'delivered' },
      });
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: { leaseExpiresAt: new Date(agora - 60 * 60_000) },
      });
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: outra },
        data: { updatedAt: new Date(agora - 60 * 60_000) },
      });
      await app.get(WhatsappSendService).reapStaleDispatches();
      expect(await despachoDe(m)).toMatchObject({
        state: 'unknown_after_dispatch',
        errorCode: 'abandoned_in_flight',
        cancelRequestedAt: pedido,
      });
      expect(await despachoDe(outra)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
      });
    });

    it('dois cancelamentos ao mesmo tempo: um cancela, o outro não acha nada, e a reserva volta uma vez', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const m = await responder();
      const comReserva = await contadorDeEnvios();
      const [a, b] = await Promise.all([
        cancelar({ messageIds: [m] }),
        cancelar({ numero: N_E164 }),
      ]);
      expect(a.cancelados + b.cancelados).toBe(1);
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', reservationId: null });
    });

    it('o em voo com o pedido que falha antes de sair vai a canceled, e não é reivindicado de novo', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      const comReserva = await contadorDeEnvios();
      const chamou = portao();
      const segue = portao();
      abertos.push(segue.abrir);
      meta.antes = async () => {
        chamou.abrir();
        await segue.aberto;
      };
      // a falha transitória que prova o não envio (429)
      meta.falha = { ok: false, failure: { status: 429 } };
      const envio = disparar(app.get(JobsService).dispatchPending());
      await chamou.aberto;
      // a chamada começou (o marcador está gravado): o cancelamento só pede
      expect(await cancelar({ messageIds: [m] })).toEqual({ cancelados: 0, pedidos: 1, emVoo: 1 });
      segue.abrir();
      await envio;
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        dispatchedAt: null,
        reservationId: null,
        attempts: 1,
      });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      await drenar();
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', attempts: 1 });
      expect(meta.sends).toEqual([]);
    });

    it('o marcador que chega entre os dois comandos do cancelamento espera a linha presa e perde a posse', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const m = await responder();
      const posse = randomUUID();
      // reivindicado e ainda sem o marcador
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: {
          state: 'sending',
          claimToken: posse,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const chegou = portao();
      const segue = portao();
      abertos.push(segue.abrir);
      // a transação do cancelamento, parada DEPOIS do primeiro comando
      const cancelamento = disparar(
        noWorkspace(wsA.workspaceId, () =>
          (
            prisma.db as unknown as {
              $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
            }
          ).$transaction(async (tx) => {
            let primeiro = true;
            const despachos = tx.messageDispatch;
            const parado = new Proxy(tx, {
              get(alvo, chave) {
                const valor = Reflect.get(alvo, chave) as unknown;
                if (chave !== 'messageDispatch') {
                  return typeof valor === 'function' ? valor.bind(alvo) : valor;
                }
                return new Proxy(despachos, {
                  get(modelo, metodo) {
                    const f = Reflect.get(modelo, metodo) as unknown;
                    if (typeof f !== 'function') return f;
                    if (metodo !== 'updateManyAndReturn') return f.bind(modelo);
                    return async (...args: unknown[]) => {
                      const r = await (f as (...a: unknown[]) => Promise<unknown>).apply(
                        modelo,
                        args,
                      );
                      if (primeiro) {
                        primeiro = false;
                        chegou.abrir();
                        await segue.aberto;
                      }
                      return r;
                    };
                  },
                });
              },
            });
            return app
              .get(CancelamentoDeDespachos)
              .cancelarNaTransacao(parado, wsA.workspaceId, { messageIds: [m] }, 'stop_requested');
          }),
        ),
      );
      await chegou.aberto;
      // o marcador da IA não pega trava: com a linha presa, ele ESPERA, e
      // depois do commit do cancelamento não acha mais a posse
      const marcador = new Client({ connectionString: TEST_DATABASE_URL });
      const olheiro = new Client({ connectionString: TEST_DATABASE_URL });
      await marcador.connect();
      await olheiro.connect();
      try {
        const [{ pid }] = (await marcador.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows;
        const marcou = marcador.query(
          `UPDATE "MessageDispatch" SET "dispatchedAt" = now()
            WHERE "messageId" = $1::uuid AND "claimToken" = $2::uuid AND "state" = 'sending'`,
          [m, posse],
        );
        let esperando = false;
        for (let i = 0; i < 200 && !esperando; i += 1) {
          const { rows } = await olheiro.query<{ w: string | null }>(
            'SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1',
            [pid],
          );
          esperando = rows[0]?.w === 'Lock';
          if (!esperando) await new Promise((r) => setTimeout(r, 25));
        }
        expect(esperando).toBe(true);
        segue.abrir();
        expect(await cancelamento).toMatchObject({ cancelados: 1, pedidos: 0 });
        expect((await marcou).rowCount).toBe(0);
      } finally {
        await marcador.end();
        await olheiro.end();
      }
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        dispatchedAt: null,
      });
    });

    it('a falha que comita enquanto o pedido espera a linha: o cancelamento a vê e a cancela (a ordem dos comandos)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const m = await responder();
      const posse = randomUUID();
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: {
          state: 'sending',
          claimToken: posse,
          dispatchedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      // o primeiro comando do `finish` da falha transitória, sem comitar
      const falha = new Client({ connectionString: TEST_DATABASE_URL });
      await falha.connect();
      try {
        await falha.query('BEGIN');
        await falha.query(
          `UPDATE "MessageDispatch"
              SET "state" = 'failed_before_send', "dispatchedAt" = NULL, "claimToken" = NULL
            WHERE "messageId" = $1::uuid AND "claimToken" = $2::uuid AND "state" = 'sending'
              AND "cancelRequestedAt" IS NULL`,
          [m, posse],
        );
        const cancelamento = disparar(cancelar({ messageIds: [m] }));
        await esperarBloqueadosPor(falha, 1, { descricao: 'o cancelamento, na linha' });
        await falha.query('COMMIT');
        expect(await cancelamento).toMatchObject({ cancelados: 1 });
      } finally {
        await soltar(falha);
      }
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', errorCode: 'stop_requested' });
    });

    it('numa transação raw, o cancelamento por número não alcança o mesmo número noutro workspace (P0)', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const mA = await responder();
      await contato('Bia Fictícia B', [N_E164], ownerB);
      await chega(N, NUMERO_B);
      const conversaB = await prisma.raw.conversation.findFirstOrThrow({
        where: { workspaceId: wsB.workspaceId, externalAddress: N_E164 },
      });
      const mB = (
        await enviar('post', `/api/conversations/${conversaB.id}/messages`, ownerB, {
          direction: 'outbound',
          body: 'Resposta fictícia B',
        }).expect(201)
      ).body.id as string;
      await prisma.raw.$transaction((tx) =>
        app
          .get(CancelamentoDeDespachos)
          .cancelarNaTransacao(
            tx as unknown as Db,
            wsA.workspaceId,
            { numero: N_E164 },
            'stop_requested',
          ),
      );
      expect(await despachoDe(mA)).toMatchObject({ state: 'canceled' });
      expect(await despachoDe(mB)).toMatchObject({ state: 'reserved', cancelRequestedAt: null });
    });

    it('o banco amarra o pedido ao motivo da lista fechada', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await chega();
      const m = await responder();
      for (const data of [
        { cancelRequestedAt: new Date() },
        { cancelReason: 'stop_requested' },
        { cancelRequestedAt: new Date(), cancelReason: 'texto livre' },
      ]) {
        await expect(
          prisma.raw.messageDispatch.updateMany({ where: { messageId: m }, data }),
        ).rejects.toThrow(/MessageDispatch_cancel_check/);
      }
      expect(await despachoDe(m)).toMatchObject({ cancelRequestedAt: null, cancelReason: null });
    });

    it('o pedido gravado nunca chega ao transporte: reivindicado com ele, o despacho vai a canceled', async () => {
      await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      const comReserva = await contadorDeEnvios();
      // um estado que nenhum caminho deixa hoje: a segunda camada
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId: m },
        data: {
          state: 'failed_before_send',
          cancelRequestedAt: new Date(),
          cancelReason: 'stop_requested',
        },
      });
      await drenar();
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        reservationId: null,
      });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(meta.sends).toEqual([]);
    });

    it('o worker REAL parado entre o claim e o marcador: o pedido de parar cancela, a reserva volta uma vez, e nada sai', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await responder();
      const comReserva = await contadorDeEnvios();
      const pausa = pausarDepois(app.get(WhatsappSendService), 'evaluate');
      const envio = disparar(app.get(JobsService).dispatchPending());
      await pausa.chegou;
      expect((await despachoDe(m)).state).toBe('sending');
      await parar(ana).expect(201);
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        reservationId: null,
      });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      pausa.segue();
      await envio;
      // o worker perdeu a posse: nada saiu, e a reserva que ele refez voltou
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', errorCode: 'stop_requested' });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(meta.sends).toEqual([]);
    });

    it('o envio da IA parado entre o claim e o marcador: o pedido de parar cancela, a reserva volta uma vez, e nada sai', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await aprovarRascunho();
      const comReserva = await contadorDeEnvios();
      const pausa = pausarDepois(app.get(ContentRestrictionService), 'check');
      const envio = disparar(app.get(JobsService).dispatchPending());
      await pausa.chegou;
      await parar(ana).expect(201);
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', errorCode: 'stop_requested' });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      pausa.segue();
      await envio;
      expect(await despachoDe(m)).toMatchObject({ state: 'canceled', errorCode: 'stop_requested' });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(meta.sends).toEqual([]);
    });

    it('o envio da IA com o marcador, antes da guarda, e o pedido de parar REAL: canceled com stop_requested, e a guarda devolve a reserva', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await chega();
      const m = await aprovarRascunho();
      const comReserva = await contadorDeEnvios();
      const pausa = pausarAntes(app.get(ContentUseGuard), 'executar');
      const envio = disparar(app.get(JobsService).dispatchPending());
      await pausa.chegou;
      expect((await despachoDe(m)).dispatchedAt).not.toBeNull();
      await parar(ana).expect(201);
      expect((await despachoDe(m)).cancelRequestedAt).not.toBeNull();
      pausa.segue();
      await envio;
      expect(await despachoDe(m)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        dispatchedAt: null,
        reservationId: null,
      });
      expect(await contadorDeEnvios()).toBe(comReserva - 1n);
      expect(meta.sends).toEqual([]);
    });

    it('o despacho da IA à espera da guarda: o pedido é visto na reconferência, e nada sai (canceled)', async () => {
      const ana = await contato('Ana Fictícia', [N_E164]);
      await credencialDeVerdade();
      await enviar('put', '/api/intelligence/consent', owner, { conversationContent: true }).expect(
        200,
      );
      await chega();
      const conversa = await conversaDe();
      llm.nextText = RASCUNHO;
      const sugestao = await enviar(
        'post',
        `/api/intelligence/conversations/${conversa.id}/reply-suggestion`,
        owner,
      ).expect(201);
      await enviar(
        'post',
        `/api/intelligence/proposals/${sugestao.body.proposalId}/approve-reply`,
        owner,
        {},
      ).expect(201);
      const despacho = await prisma.raw.messageDispatch.findFirstOrThrow({
        where: { fromAiProposal: true },
      });
      const t = await travar(CHAVE.contato(wsA.workspaceId, ana));
      try {
        const envio = app.get(JobsService).dispatchPending();
        await esperarBloqueadosPor(t, 1, { descricao: 'a guarda do envio na trava da Ana' });
        // o marcador já está gravado: o cancelamento só pode pedir
        await t.query(
          `UPDATE "MessageDispatch" SET "cancelRequestedAt" = now(), "cancelReason" = 'stop_requested'
            WHERE "messageId" = $1::uuid`,
          [despacho.messageId],
        );
        await t.query('COMMIT');
        await envio;
      } finally {
        await soltar(t);
      }
      // sem bloqueio nenhum: o motivo é o gravado com o pedido
      expect(await despachoDe(despacho.messageId)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
        dispatchedAt: null,
      });
      expect(meta.sends).toEqual([]);
    });
  });

  // ── O marcador da resposta de pessoa ────────────────────────────────────

  it('o marcador da resposta de pessoa relê a religação: a conversa religada depois da checagem rápida não recebe', async () => {
    const ana = await contato('Ana Fictícia', [N_E164]);
    await credencialDeVerdade();
    await chega();
    const m = await responder();
    // depois da chegada: com as duas, a mensagem teria ido à RAI
    const bia = await contato('Bia Fictícia', [N_E164]);
    const pausa = pausarDepois(app.get(WhatsappSendService), 'evaluate');
    const envio = disparar(app.get(JobsService).dispatchPending());
    await pausa.chegou;
    // a religação comita entre a checagem rápida e o marcador
    const conversa = await conversaDe();
    expect(conversa.contactId).toBe(ana);
    await prisma.raw.conversation.updateMany({
      where: { id: conversa.id },
      data: { contactId: bia },
    });
    pausa.segue();
    await envio;
    expect(await despachoDe(m)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'conversation_relinked',
    });
    expect(meta.sends).toEqual([]);
  });

  it('o marcador da resposta de pessoa relê o número sob as travas: a troca que comita antes é vista, e nada sai', async () => {
    const ana = await contato('Ana Fictícia', [N_E164]);
    await credencialDeVerdade();
    await chega();
    const m = await responder();
    // a trava exclusiva do endereço, como a de quem edita o telefone
    const t = await travar(endereco(N_E164));
    try {
      const envio = app.get(JobsService).dispatchPending();
      await esperarBloqueadosPor(t, 1, { descricao: 'o marcador, no endereço' });
      await t.query(
        `UPDATE "Contact" SET "phones" = ARRAY[$1], "phonesNormalized" = ARRAY[$1] WHERE "id" = $2::uuid`,
        [OUTRO, ana],
      );
      await t.query('COMMIT');
      await envio;
    } finally {
      await soltar(t);
    }
    expect(await despachoDe(m)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'number_not_exact',
      dispatchedAt: null,
    });
    expect(meta.sends).toEqual([]);
  });
});

import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import {
  FakeTemplateCatalog,
  META_TEMPLATE_CATALOG,
  type TemplateDaMeta,
} from '../channels/meta-templates.catalog';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type ParametrosDoTemplate,
  type SendCredential,
  type SendOutcome,
} from '../channels/meta.transport';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { CryptoService } from '../common/crypto.service';
import { ConsentPurposesService } from '../consents/consent-purposes.service';
import {
  ContentUseGuard,
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
} from '../content-use/content-use.guard';
import { CONFIG_DA_GUARDA, CONFIG_PADRAO_DA_GUARDA } from '../content-use/content-use.pools';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { CHAVE } from '../content-use/restriction-locks';
import { MudancasDeRestricao } from '../content-use/restriction-changes';
import { chaveDeCoincidencia } from '../contacts/phone-identity';
import {
  OUTBOUND_PRECONDITION_PROVIDERS,
  OutboundPreconditionService,
  type OutboundPreconditionAnswer,
  type OutboundPreconditionProvider,
} from '../extensions/outbound-precondition';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { TemplateVersionsService } from '../templates/template-versions.service';
import { UsageService } from '../usage/usage.service';
import { createTestApp } from '../../test/integration/app';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  makeRetriableNowById,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { EnvioDoNegocioService } from './business-outbound.service';
import { ConferenciaDoEnvio } from './conferencia';

/**
 * F4.1c-3 (ADR-052 itens 6 a 9): o envio iniciado pelo negócio — a prévia, a
 * aprovação em lote, o despacho sob a guarda e a pré-condição do vertical (E7).
 * O catálogo falso faz o papel da Meta, o transporte falso nunca envia e uma
 * porta de teste faz o papel do vertical. Determinístico: quem espera quem é
 * conferido em `pg_blocking_pids`, e o envio fica preso num portão. Conteúdo,
 * nomes e números FICTÍCIOS.
 */

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';
const WABA_A = '1001';
const WABA_B = '1002';
const PHONE_A = '100000000000001';
const PHONE_B = '100000000000002';
const ID_DO_TEMPLATE = '5001';
const NUMERO = '+5511988887777';
const NOME = 'Ana Ficticia';

/** Prazos curtos: a espera aparece em segundos, e o envio preso cabe no prazo da Meta. */
const CONFIG = {
  ...CONFIG_PADRAO_DA_GUARDA,
  mudancaTravaMs: 2_000,
  mudancaTransacaoMs: 10_000,
  prazoDaMetaMs: 8_000,
};

interface Session {
  cookieHeader: string;
  csrf: string;
}

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/** O transporte falso: guarda o template enviado e pode segurar a resposta. */
class MetaFalsa implements MetaTransport {
  templates: {
    phoneNumberId: string;
    to: string;
    name: string;
    language: string;
    params: ParametrosDoTemplate;
  }[] = [];
  textos = 0;
  entrou = portao();
  segura: Promise<void> | null = null;
  proximo: SendOutcome = { ok: true, externalId: 'wamid.NEGOCIO' };
  reiniciar(): void {
    this.templates = [];
    this.textos = 0;
    this.entrou = portao();
    this.segura = null;
    this.proximo = { ok: true, externalId: 'wamid.NEGOCIO' };
  }
  async sendText(): Promise<SendOutcome> {
    this.textos += 1;
    return this.proximo;
  }
  async sendTemplate(
    credencial: SendCredential,
    to: string,
    template: { name: string; language: string },
    params: ParametrosDoTemplate,
    signal?: AbortSignal,
  ): Promise<SendOutcome> {
    this.templates.push({ phoneNumberId: credencial.phoneNumberId, to, ...template, params });
    this.entrou.abrir();
    if (this.segura) {
      const abortou = await Promise.race([
        this.segura.then(() => false),
        new Promise<boolean>((resolve) => signal?.addEventListener('abort', () => resolve(true))),
      ]);
      if (abortou) return { ok: false, failure: { networkFailure: true } };
    }
    return this.proximo;
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

/** A porta do vertical, de teste: o pedido vale só no workspace em que foi posto. */
class PreCondicaoDeTeste implements OutboundPreconditionProvider {
  readonly prefix = 'teste.pedido';
  validos = new Map<string, OutboundPreconditionAnswer>();
  foraDoAr = false;
  consultas: [string, string][] = [];
  limpar(): void {
    this.validos.clear();
    this.foraDoAr = false;
    this.consultas = [];
  }
  async check(workspaceId: string, originId: string): Promise<OutboundPreconditionAnswer> {
    this.consultas.push([workspaceId, originId]);
    if (this.foraDoAr) throw new Error('porta fora do ar');
    return this.validos.get(`${workspaceId}:${originId}`) ?? { valid: false };
  }
}

const lembrete = (mudanca: Partial<TemplateDaMeta> = {}): TemplateDaMeta => ({
  id: ID_DO_TEMPLATE,
  name: 'lembrete_horario',
  language: 'pt_BR',
  status: 'APPROVED',
  category: 'UTILITY',
  parameterFormat: 'POSITIONAL',
  components: [
    { type: 'BODY', text: 'Ola {{1}}, seu horario esta confirmado.' },
    { type: 'FOOTER', text: 'Clinica Ficticia' },
  ],
  ...mudanca,
});

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('F4.1c-3 — o envio iniciado pelo negócio (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;
  let observador: Client;
  const catalogo = new FakeTemplateCatalog();
  const meta = new MetaFalsa();
  const porta = new PreCondicaoDeTeste();

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: META_TEMPLATE_CATALOG, useValue: catalogo },
        { provide: META_TRANSPORT, useValue: meta },
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        { provide: OUTBOUND_PRECONDITION_PROVIDERS, useValue: [porta] },
        {
          provide: GANCHOS_DA_GUARDA,
          useValue: (ponto: PontoDaGuarda, contexto: ContextoDoPonto) => gancho?.(ponto, contexto),
        },
      ],
    );
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });
  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  /**
   * Os portões e as chamadas em voo de cada teste: o que falha no meio não
   * deixa o envio preso nem a guarda parada para o próximo teste (nem o jest
   * aberto).
   */
  const abertos: (() => void)[] = [];
  const emCurso: Promise<unknown>[] = [];
  const disparar = <T>(p: Promise<T>): Promise<T> => {
    emCurso.push(p);
    return p;
  };
  afterEach(async () => {
    gancho = null;
    for (const abrir of abertos.splice(0)) abrir();
    while (emCurso.length) {
      await Promise.allSettled(emCurso.splice(0));
      await new Promise((r) => setImmediate(r));
    }
    jest.restoreAllMocks();
  });

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  let canalA: string;
  let canalB: string;
  let contatoA: string;
  let conversaA: string;
  let finalidadeA: string;
  let consentimentoA: string;
  let versaoA: string;
  let owner: Session;
  let ownerB: Session;
  let convidado: Session;
  let pidDaGuarda: number | null = null;

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
    metodo: 'post' | 'patch',
    path: string,
    s: Session,
    body: unknown,
    chave?: string,
  ) => {
    const req = request(http)
      [metodo](path)
      .set('Origin', ORIGIN)
      .set('Cookie', s.cookieHeader)
      .set('x-csrf-token', s.csrf);
    if (chave) req.set('Idempotency-Key', chave);
    return req.send(body as object);
  };
  const previa = (items: unknown[], s: Session = owner) =>
    enviar('post', '/api/business-outbound/preview', s, { items });
  const aprovar = (items: unknown[], chave: string = randomUUID(), s: Session = owner) =>
    enviar('post', '/api/business-outbound', s, { items }, chave);

  const alvo = (
    mudanca: Partial<{
      originRef: string;
      channelId: string;
      contactId: string;
      number: string;
      templateVersionId: string;
      purposeId: string;
    }> = {},
  ) => ({
    originRef: `conversation:${conversaA}`,
    channelId: canalA,
    contactId: contatoA,
    number: NUMERO,
    templateVersionId: versaoA,
    purposeId: finalidadeA,
    ...mudanca,
  });
  /** A prévia de um item, que precisa passar, e o item pronto para aprovar. */
  const previsto = async (mudanca: Parameters<typeof alvo>[0] = {}) => {
    const res = await previa([alvo(mudanca)]).expect(200);
    const [item] = res.body.items;
    if (!item.ok) throw new Error(`a prévia recusou: ${item.reason}`);
    return { ...alvo(mudanca), expiresAt: item.expiresAt, approvalHash: item.approvalHash };
  };
  /** Prévia e aprovação de um item; devolve a mensagem. */
  const aprovado = async (mudanca: Parameters<typeof alvo>[0] = {}) => {
    const item = await previsto(mudanca);
    const res = await aprovar([item]).expect(200);
    const [resultado] = res.body.items;
    if (resultado.state !== 'approved') throw new Error(`recusado: ${resultado.reason}`);
    return resultado.messageId as string;
  };

  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const despacho = (messageId: string) =>
    prisma.raw.messageDispatch.findFirst({ where: { messageId } });
  const usos = () =>
    prisma.raw.contentUse.findMany({
      where: { workspaceId: wsA.workspaceId },
      orderBy: { authorizedAt: 'asc' },
    });
  const contador = async () =>
    Number(
      (
        await prisma.raw.usageCounter.findFirst({
          where: { workspaceId: wsA.workspaceId, metric: 'messages_sent' },
          select: { value: true },
        })
      )?.value ?? 0,
    );
  const reservas = () =>
    prisma.raw.usageReservation.count({ where: { workspaceId: wsA.workspaceId } });
  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 400; i++) {
      if (await condicao()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`não aconteceu: ${descricao}`);
  };
  /** Alguém espera a sessão `pid` (a guarda): a mudança está presa atrás dela. */
  const alguemEspera = (pid: number | null) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
        [pid],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a sessão ${pid}`);
  const derrubar = async (pid: number | null) => {
    await observador.query('SELECT pg_terminate_backend($1)', [pid]);
    await ate(async () => {
      const { rows } = await observador.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
        pid,
      ]);
      return rows.length === 0;
    }, `a sessão ${pid} cair`);
  };
  const noWorkspace = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const cls = app.get(ClsService);
    return cls.run(() => {
      cls.set('workspaceId', workspaceId);
      return fn();
    });
  };

  // as mudanças que concorrem com o envio, pelas rotas de verdade
  const revogar = (s: Session = owner) =>
    enviar(
      'post',
      `/api/contacts/${contatoA}/consents/${consentimentoA}/revoke`,
      s,
      { origin: 'phone' },
      randomUUID(),
    );
  const pararNumero = () =>
    enviar(
      'post',
      `/api/contacts/${contatoA}/stop`,
      owner,
      { number: NUMERO, origin: 'phone' },
      randomUUID(),
    );
  const editarContato = (dados: Record<string, unknown>) =>
    enviar('patch', `/api/contacts/${contatoA}`, owner, dados);

  beforeEach(async () => {
    catalogo.limpar();
    meta.reiniciar();
    porta.limpar();
    pidDaGuarda = null;
    gancho = (ponto, contexto) => {
      if (ponto === 'sessao') pidDaGuarda = contexto.pid;
    };
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    const dono = await createUserFixture(prisma, 'dono@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, dono, wsA.roles.owner);
    const donoB = await createUserFixture(prisma, 'dono-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, donoB, wsB.roles.owner);
    const visita = await createUserFixture(prisma, 'convidado@veyra.test');
    await createMembershipFixture(prisma, wsA.workspaceId, visita, wsA.roles.guest);
    const crypto = app.get(CryptoService);
    for (const [ws, waba, telefone, guardar] of [
      [wsA.workspaceId, WABA_A, PHONE_A, (id: string) => (canalA = id)],
      [wsB.workspaceId, WABA_B, PHONE_B, (id: string) => (canalB = id)],
    ] as const) {
      const canal = await prisma.raw.channel.create({
        data: { workspaceId: ws, type: 'whatsapp', name: `WhatsApp ${waba}` },
      });
      guardar(canal.id);
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          phoneNumberId: telefone,
          businessAccountId: waba,
          tokenCipher: crypto.encrypt('token-ficticio'),
        },
      });
    }
    owner = await login('dono@veyra.test');
    ownerB = await login('dono-b@veyra.test');
    convidado = await login('convidado@veyra.test');
    // o contato pelo domínio (a forma normalizada e as chaves do número)
    contatoA = (
      await enviar('post', '/api/contacts', owner, { name: NOME, phones: [NUMERO] }).expect(201)
    ).body.id;
    conversaA = (
      await prisma.raw.conversation.create({
        data: {
          workspaceId: wsA.workspaceId,
          channelId: canalA,
          contactId: contatoA,
          externalAddress: NUMERO,
        },
      })
    ).id;
    finalidadeA = (
      await app.get(ConsentPurposesService).criarVersao('acme', {
        key: 'lembrete',
        description: 'Lembretes de horário marcado',
        category: 'utility',
        fields: ['contato.nome'],
      })
    ).purposeId;
    consentimentoA = (
      await enviar(
        'post',
        `/api/contacts/${contatoA}/consents`,
        owner,
        { channelId: canalA, number: NUMERO, purposeId: finalidadeA, origin: 'in_person' },
        randomUUID(),
      ).expect(201)
    ).body.id;
    catalogo.publicar(WABA_A, lembrete());
    const registro = await app.get(TemplateVersionsService).registrar('acme', {
      channelId: canalA,
      name: 'lembrete_horario',
      language: 'pt_BR',
      vinculos: { 'body.1': 'contato.nome' },
    });
    if (registro.resultado !== 'registrada') throw new Error('o template não foi registrado');
    versaoA = registro.versionId;
    await enviar('post', `/api/templates/versions/${versaoA}/reviews`, owner, {
      purposeId: finalidadeA,
      contentHash: registro.contentHash,
    }).expect(201);
  });

  // ── A prévia e a aprovação ──────────────────────────────────────────────

  describe('a prévia e a aprovação', () => {
    it('a prévia mostra o texto e os valores, com o prazo de 1 h no relógio do banco; a aprovação grava a mensagem, o despacho, a aprovação sem os valores e a trilha sem o número', async () => {
      const antes = Date.now();
      const res = await previa([alvo()]).expect(200);
      const [item] = res.body.items;
      expect(item).toMatchObject({
        index: 0,
        ok: true,
        text: `Ola ${NOME}, seu horario esta confirmado.\n\nClinica Ficticia`,
        values: { 'body.1': NOME },
      });
      expect(item.approvalHash).toMatch(/^[0-9a-f]{64}$/);
      const prazo = new Date(item.expiresAt).getTime() - antes;
      expect(prazo).toBeGreaterThan(55 * 60_000);
      expect(prazo).toBeLessThan(65 * 60_000);
      // a prévia não escreve nada
      expect(await prisma.raw.outboundApproval.count()).toBe(0);
      expect(await prisma.raw.message.count()).toBe(0);

      const aprovacao = await aprovar([
        { ...alvo(), expiresAt: item.expiresAt, approvalHash: item.approvalHash },
      ]).expect(200);
      const [resultado] = aprovacao.body.items;
      expect(resultado).toMatchObject({ index: 0, state: 'approved', reason: null });
      // só ids, estados e motivos: nunca a prévia
      expect(Object.keys(resultado).sort()).toEqual(['index', 'messageId', 'reason', 'state']);
      const mensagem = await prisma.raw.message.findFirst({ where: { id: resultado.messageId } });
      expect(mensagem).toMatchObject({
        conversationId: conversaA,
        direction: 'outbound',
        authorType: 'user',
        body: item.text,
      });
      expect(await despacho(resultado.messageId)).toMatchObject({
        state: 'reserved',
        approvalContactIds: [contatoA],
        fromAiProposal: false,
        templateName: null,
      });
      const gravada = await prisma.raw.outboundApproval.findFirst({
        where: { messageId: resultado.messageId },
      });
      expect(gravada).toMatchObject({
        workspaceId: wsA.workspaceId,
        contactId: contatoA,
        number: NUMERO,
        channelId: canalA,
        phoneNumberId: PHONE_A,
        templateVersionId: versaoA,
        purposeId: finalidadeA,
        consentId: consentimentoA,
        originRef: `conversation:${conversaA}`,
        validityKeys: [],
        approvalHash: item.approvalHash,
      });
      expect(gravada?.expiresAt.toISOString()).toBe(item.expiresAt);
      // os valores não ficam guardados (minimização)
      expect(JSON.stringify(gravada)).not.toContain(NOME);
      const trilha = await prisma.raw.auditLog.findFirst({
        where: { action: 'business_outbound.approved' },
      });
      expect(trilha).toMatchObject({
        entityType: 'outboundApproval',
        entityId: resultado.messageId,
      });
      expect(JSON.stringify(trilha)).not.toContain(NUMERO.slice(1));
      expect(JSON.stringify(trilha)).not.toContain(NOME);
    });

    it('o lote exige a Idempotency-Key; repetir devolve a mesma resposta sem nova mensagem; a mesma chave com outro lote é 409', async () => {
      const item = await previsto();
      await enviar('post', '/api/business-outbound', owner, { items: [item] }).expect(400);
      const chave = randomUUID();
      const primeira = await aprovar([item], chave).expect(200);
      const repetida = await aprovar([item], chave).expect(200);
      expect(repetida.body).toEqual(primeira.body);
      expect(await prisma.raw.message.count()).toBe(1);
      await aprovar([item, item], chave).expect(409);
      expect(await prisma.raw.message.count()).toBe(1);
    });

    it('cada item do lote é processado por si: o recusado não impede o aprovado', async () => {
      const item = await previsto();
      const res = await aprovar([{ ...item, approvalHash: 'f'.repeat(64) }, item]).expect(200);
      expect(res.body.items).toEqual([
        { index: 0, state: 'refused', messageId: null, reason: 'approval_stale' },
        { index: 1, state: 'approved', messageId: expect.any(String), reason: null },
      ]);
      // a reserva do recusado voltou; só a do aprovado continua
      expect(await reservas()).toBe(1);
    });

    it('as recusas do destinatário, na prévia, cada uma com o seu motivo', async () => {
      const motivo = async (mudanca: Parameters<typeof alvo>[0] = {}) =>
        (await previa([alvo(mudanca)]).expect(200)).body.items[0].reason;
      // a conversa da origem é de outro número, ou não existe: a origem do
      // Inbox precisa ser a conversa do alvo, antes de qualquer outra conferência
      expect(await motivo({ number: '+5511977776666' })).toBe('conversation_relinked');
      expect(await motivo({ originRef: `conversation:${randomUUID()}` })).toBe(
        'conversation_relinked',
      );
      // a finalidade sem revisão daquela versão
      const outra = (
        await app.get(ConsentPurposesService).criarVersao('acme', {
          key: 'retorno',
          description: 'Retornos',
          category: 'utility',
          fields: ['contato.nome'],
        })
      ).purposeId;
      expect(await motivo({ purposeId: outra })).toBe('consent_revoked');
      await enviar(
        'post',
        `/api/contacts/${contatoA}/consents`,
        owner,
        { channelId: canalA, number: NUMERO, purposeId: outra, origin: 'in_person' },
        randomUUID(),
      ).expect(201);
      expect(await motivo({ purposeId: outra })).toBe('template_not_reviewed');
      // outro contato com o mesmo número: dois candidatos
      await enviar('post', '/api/contacts', owner, {
        name: 'Bia Ficticia',
        phones: [NUMERO],
      }).expect(201);
      expect(await motivo()).toBe('address_ambiguous');
    });

    it('a revogação e o pedido de parar recusam, cada um com o seu motivo', async () => {
      await revogar().expect(201);
      expect((await previa([alvo()]).expect(200)).body.items[0].reason).toBe('consent_revoked');
      await pararNumero().expect(201);
      // o bloqueio vem antes do consentimento: o motivo é o pedido de parar
      expect((await previa([alvo()]).expect(200)).body.items[0].reason).toBe('opted_out');
    });

    it('o nome que não serve como parâmetro (com tabulação) recusa: nada é cortado nem completado', async () => {
      await prisma.raw.contact.updateMany({
        where: { id: contatoA },
        data: { name: 'Ana\tFicticia' },
      });
      expect((await previa([alvo()]).expect(200)).body.items[0].reason).toBe('field_value_invalid');
    });

    it('o que mudou desde a prévia não é aprovado: o nome, o prazo vencido, o hash forjado e o prazo além do máximo', async () => {
      const item = await previsto();
      // o prazo trocado sem o hash, e o hash forjado: o HMAC não confere
      const alem = new Date(Date.parse(item.expiresAt) + 60_000).toISOString();
      expect((await aprovar([{ ...item, expiresAt: alem }]).expect(200)).body.items[0].reason).toBe(
        'approval_stale',
      );
      expect(
        (await aprovar([{ ...item, approvalHash: '0'.repeat(64) }]).expect(200)).body.items[0]
          .reason,
      ).toBe('approval_stale');
      // os prazos com o hash VÁLIDO para eles (a chave do servidor): só o prazo recusa
      const conferencia = app.get(ConferenciaDoEnvio);
      const conferido = await noWorkspace(wsA.workspaceId, () =>
        conferencia.conferir(prisma.db, wsA.workspaceId, alvo()),
      );
      if (!conferido.ok) throw new Error('a conferência recusou');
      // além do máximo de 1 h: o servidor nunca emitiria esse prazo
      const longe = new Date((await conferencia.agora()).getTime() + 2 * 60 * 60_000);
      expect(
        (
          await aprovar([
            {
              ...alvo(),
              expiresAt: longe.toISOString(),
              approvalHash: conferencia.hash(conferido.conferido.forma, longe),
            },
          ]).expect(200)
        ).body.items[0].reason,
      ).toBe('approval_stale');
      const vencido = new Date(Date.now() - 1_000);
      expect(
        (
          await aprovar([
            {
              ...alvo(),
              expiresAt: vencido.toISOString(),
              approvalHash: conferencia.hash(conferido.conferido.forma, vencido),
            },
          ]).expect(200)
        ).body.items[0].reason,
      ).toBe('approval_expired');
      // o nome mudou entre a prévia e a aprovação: o valor aprovado era outro
      await editarContato({ name: 'Ana Ficticia Souza' }).expect(200);
      expect((await aprovar([item]).expect(200)).body.items[0].reason).toBe('approval_stale');
      expect(await prisma.raw.message.count()).toBe(0);
      expect(await reservas()).toBe(0);
    });

    it('a aprovação relê a Meta antes das travas: o conteúdo trocado diverge a versão; a leitura que falha e o pausado recusam sem divergir', async () => {
      const item = await previsto();
      catalogo.falha = { status: 500 };
      expect((await aprovar([item]).expect(200)).body.items[0].reason).toBe('template_unverified');
      catalogo.publicar(WABA_A, lembrete({ status: 'PAUSED' }));
      expect((await aprovar([item]).expect(200)).body.items[0].reason).toBe('template_unavailable');
      expect(
        (await prisma.raw.messageTemplateVersion.findFirst({ where: { id: versaoA } }))?.status,
      ).toBe('active');
      catalogo.publicar(
        WABA_A,
        lembrete({ components: [{ type: 'BODY', text: 'Outro texto {{1}}.' }] }),
      );
      expect((await aprovar([item]).expect(200)).body.items[0].reason).toBe('template_changed');
      expect(
        (await prisma.raw.messageTemplateVersion.findFirst({ where: { id: versaoA } }))?.status,
      ).toBe('divergent');
      expect(await prisma.raw.message.count()).toBe(0);
    });

    it('UMA aprovação por prévia: repetida no lote, ou com outra chave, devolve a mesma mensagem, sem nova reserva', async () => {
      const item = await previsto();
      const lote = await aprovar([item, item]).expect(200);
      const [a, b] = lote.body.items;
      expect([a.state, b.state]).toEqual(['approved', 'approved']);
      expect(b.messageId).toBe(a.messageId);
      // a repetição nem relê a Meta: a aprovação daquela prévia já existe
      const leituras = catalogo.leituras;
      const outraChave = await aprovar([item]).expect(200);
      expect(catalogo.leituras).toBe(leituras);
      expect(outraChave.body.items[0]).toMatchObject({ state: 'approved', messageId: a.messageId });
      expect(await prisma.raw.message.count()).toBe(1);
      expect(await prisma.raw.outboundApproval.count()).toBe(1);
      expect(await reservas()).toBe(1);
      // o hash desta aprovação com OUTRO alvo não a devolve como se fosse dele
      const outroAlvo = await aprovar([{ ...item, number: '+5511977776666' }]).expect(200);
      expect(outroAlvo.body.items[0]).toMatchObject({ state: 'refused', reason: 'approval_stale' });
      expect(await prisma.raw.message.count()).toBe(1);
    });

    it('a conexão que cai no COMMIT, com a aprovação gravada: o item responde aprovado, não "nada foi gravado"', async () => {
      const item = await previsto();
      const mudancas = app.get(MudancasDeRestricao);
      const original = mudancas.naTransacaoInterativa.bind(mudancas);
      jest.spyOn(mudancas, 'naTransacaoInterativa').mockImplementationOnce(async (db, fn) => {
        await original(db, fn);
        throw new Error('a conexão caiu depois do COMMIT');
      });
      const res = await aprovar([item]).expect(200);
      const gravada = await prisma.raw.outboundApproval.findFirst({});
      expect(res.body.items[0]).toEqual({
        index: 0,
        state: 'approved',
        messageId: gravada?.messageId,
        reason: null,
      });
      expect(await prisma.raw.message.count()).toBe(1);
    });

    it('a CORRIDA da mesma prévia: a busca não a vê, e o único do banco decide — devolve a mensagem que ficou', async () => {
      const item = await previsto();
      const primeira = (await aprovar([item]).expect(200)).body.items[0].messageId as string;
      // a outra aprovação, que olhou antes de a primeira comitar: não acha nada
      const servico = app.get(EnvioDoNegocioService);
      jest
        .spyOn(
          servico as unknown as { aprovacaoDaPrevia: () => Promise<unknown> },
          'aprovacaoDaPrevia',
        )
        .mockResolvedValueOnce(null);
      // a corrida é benigna: não é registrada como falha inesperada
      const erros = jest.spyOn(
        (servico as unknown as { logger: { error: (m: string) => void } }).logger,
        'error',
      );
      const segunda = await aprovar([item]).expect(200);
      expect(segunda.body.items[0]).toMatchObject({ state: 'approved', messageId: primeira });
      expect(erros).not.toHaveBeenCalled();
      expect(await prisma.raw.message.count()).toBe(1);
      expect(await reservas()).toBe(1);
    });

    it('a conferência e a porta só rodam no workspace do contexto (defesa em profundidade)', async () => {
      const conferencia = app.get(ConferenciaDoEnvio);
      await expect(
        noWorkspace(wsB.workspaceId, async () =>
          conferencia.conferir(prisma.db, wsA.workspaceId, alvo()),
        ),
      ).rejects.toThrow(/fora do contexto do workspace/);
      const precondicao = app.get(OutboundPreconditionService);
      porta.validos.set(`${wsA.workspaceId}:${conversaA}`, {
        valid: true,
        contactId: contatoA,
        values: {},
        validityKeys: [],
      });
      expect(
        await noWorkspace(wsB.workspaceId, () =>
          precondicao.consultar(wsA.workspaceId, `teste.pedido:${conversaA}`),
        ),
      ).toEqual({ tipo: 'indisponivel' });
      expect(porta.consultas).toEqual([]);
    });

    it('a falha inesperada num item não derruba o lote: os outros seguem, ele é `not_processed`, sem efeito', async () => {
      // duas prévias do mesmo alvo: prazos, e hashes, diferentes
      const primeira = await previsto();
      await new Promise((r) => setTimeout(r, 5));
      const segunda = await previsto();
      expect(segunda.approvalHash).not.toBe(primeira.approvalHash);
      const conferencia = app.get(ConferenciaDoEnvio);
      const original = conferencia.conferir.bind(conferencia);
      let chamadas = 0;
      jest.spyOn(conferencia, 'conferir').mockImplementation(async (...args) => {
        chamadas += 1;
        // a segunda conferência é a do segundo item, sob as travas
        if (chamadas === 2) throw new Error('falha simulada');
        return original(...args);
      });
      const res = await aprovar([primeira, segunda]).expect(200);
      expect(res.body.items[0]).toMatchObject({ state: 'approved', reason: null });
      expect(res.body.items[1]).toEqual({
        index: 1,
        state: 'refused',
        messageId: null,
        reason: 'not_processed',
      });
      expect(await prisma.raw.message.count()).toBe(1);
      // a reserva do item que falhou voltou
      expect(await reservas()).toBe(1);
    });

    it('a releitura da aprovação e a do despacho têm prazo absoluto (o sinal chega ao catálogo)', async () => {
      const versoes = app.get(TemplateVersionsService);
      const reler = jest.spyOn(versoes, 'reler');
      const messageId = await aprovado();
      await drain();
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      expect(reler).toHaveBeenCalledTimes(2);
      for (const chamada of reler.mock.calls) expect(chamada[1]).toBeInstanceOf(AbortSignal);
    });

    it('a aprovação espera as travas do destinatário: com uma mudança segurando o endereço (ou o nível 0, na origem do vertical), o item é `busy`, sem efeito', async () => {
      const item = await previsto();
      const chave = chaveDeCoincidencia(NUMERO) as string;
      const travas = app.get(TravasDeIdentidade);
      const segurar = async (texto: string) => {
        const c = new Client({ connectionString: TEST_DATABASE_URL });
        await c.connect();
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [texto]);
        return c;
      };
      const endereco = await segurar(
        CHAVE.entidade(wsA.workspaceId, travas.endereco(wsA.workspaceId, chave)),
      );
      try {
        const res = await aprovar([item]).expect(200);
        expect(res.body.items[0]).toMatchObject({ state: 'refused', reason: 'busy' });
      } finally {
        await endereco.query('ROLLBACK');
        await endereco.end();
      }
      // a origem do vertical pode criar a conversa: espera o nível 0 do número
      const pedido = randomUUID();
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: {},
        validityKeys: [],
      });
      const doVertical = await previsto({ originRef: `teste.pedido:${pedido}` });
      const nivelZero = await segurar(
        CHAVE.ingestao(wsA.workspaceId, travas.nivelZero(wsA.workspaceId, chave)),
      );
      try {
        const res = await aprovar([doVertical]).expect(200);
        expect(res.body.items[0]).toMatchObject({ state: 'refused', reason: 'busy' });
      } finally {
        await nivelZero.query('ROLLBACK');
        await nivelZero.end();
      }
      expect(await prisma.raw.message.count()).toBe(0);
      expect(await reservas()).toBe(0);
    });

    it('a aprovação é imutável no client e no banco, e os CHECKs recusam o que está fora do formato', async () => {
      const messageId = await aprovado();
      await expect(
        // o `await` DENTRO do contexto: a consulta do Prisma só roda no `then`
        noWorkspace(
          wsA.workspaceId,
          async () =>
            await prisma.db.outboundApproval.updateMany({
              where: { messageId },
              data: { number: '+5511900000000' },
            }),
        ),
        // o client recusa antes de chegar ao banco (o gatilho é a segunda camada)
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.raw.outboundApproval.updateMany({
          where: { messageId },
          data: { expiresAt: new Date(Date.now() + 86_400_000) },
        }),
      ).rejects.toThrow(/imutável/);
      // a versão e a revisão de uma aprovação não somem sem ela (FKs sem ação)
      await expect(
        prisma.raw.messageTemplateVersion.deleteMany({ where: { id: versaoA } }),
      ).rejects.toThrow(/Foreign key|foreign key/);
      const linha = await prisma.raw.outboundApproval.findFirst({ where: { messageId } });
      // os CHECKs, com a linha da aprovação de antes por base (uma mensagem nova)
      for (const [campo, valor] of [
        ['approvalHash', 'nao-e-hex'],
        ['number', '5511988887777'],
        ['phoneNumberId', 'abc123'],
        ['originRef', 'conversation:nao-e-uuid'],
      ] as const) {
        const mensagem = await prisma.raw.message.create({
          data: {
            workspaceId: wsA.workspaceId,
            conversationId: conversaA,
            channelId: canalA,
            direction: 'outbound',
            authorType: 'user',
            body: 'fictícia',
          },
        });
        await expect(
          prisma.raw.outboundApproval.create({
            data: { ...linha!, messageId: mensagem.id, createdAt: undefined, [campo]: valor },
          }),
        ).rejects.toThrow(/check/i);
      }
    });

    it('a exclusão do workspace (LGPD) leva a aprovação junto: as FKs sem ação não a travam', async () => {
      await aprovado();
      expect(await prisma.raw.outboundApproval.count()).toBe(1);
      await prisma.raw.workspace.delete({ where: { id: wsA.workspaceId } });
      expect(await prisma.raw.outboundApproval.count()).toBe(0);
      expect(
        await prisma.raw.messageTemplateVersion.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
    });

    it('P0: o alvo de outro workspace não existe para a prévia nem para a aprovação, e nada é escrito lá', async () => {
      const contatoB = (
        await enviar('post', '/api/contacts', ownerB, { name: 'Bruno Ficticio', phones: [NUMERO] })
      ).body.id;
      const deB = { channelId: canalB, contactId: contatoB };
      const motivos = (await previa([alvo(deB), alvo({ contactId: contatoB })]).expect(200)).body
        .items;
      expect(motivos.map((i: { reason: string }) => i.reason)).toEqual([
        'no_credential',
        'conversation_relinked',
      ]);
      const item = await previsto();
      const res = await aprovar([{ ...item, ...deB }]).expect(200);
      expect(res.body.items[0]).toMatchObject({ state: 'refused' });
      // e quem é de B não aprova o item de A
      const deA = await aprovar([item], randomUUID(), ownerB).expect(200);
      // a versão de A não existe para B: a mesma recusa da versão que sumiu
      expect(deA.body.items[0]).toMatchObject({ state: 'refused', reason: 'template_unavailable' });
      expect(res.body.items[0].reason).toBe('no_credential');
      expect(await prisma.raw.usageReservation.count()).toBe(0);
      expect(await prisma.raw.message.count({ where: { workspaceId: wsB.workspaceId } })).toBe(0);
      expect(await prisma.raw.outboundApproval.count()).toBe(0);
    });

    it('sem conversations:write, a prévia e o lote são 403', async () => {
      await previa([alvo()], convidado).expect(403);
      await aprovar(
        [{ ...alvo(), expiresAt: new Date().toISOString(), approvalHash: '0'.repeat(64) }],
        randomUUID(),
        convidado,
      ).expect(403);
    });
  });

  // ── As opções do Inbox ──────────────────────────────────────────────────

  describe('as opções do compositor do Inbox', () => {
    const opcoes = (conversationId: string, s: Session = owner) =>
      request(http)
        .get(`/api/business-outbound/options?conversationId=${conversationId}`)
        .set('Origin', ORIGIN)
        .set('Cookie', s.cookieHeader);

    it('a versão ativa e revisada, para a finalidade consentida do número da conversa, com o alvo pronto — que passa na prévia', async () => {
      const res = await opcoes(conversaA).expect(200);
      expect(res.body).toEqual([
        {
          target: alvo(),
          templateVersionId: versaoA,
          name: 'lembrete_horario',
          language: 'pt_BR',
          version: 1,
          category: 'utility',
          purposeId: finalidadeA,
          purposeKey: 'lembrete',
          purposeVersion: 1,
          purposeDescription: 'Lembretes de horário marcado',
        },
      ]);
      // a política aponta o template quando a janela fecha
      const politica = await request(http)
        .get(`/api/conversations/${conversaA}/send-policy`)
        .set('Origin', ORIGIN)
        .set('Cookie', owner.cookieHeader)
        .expect(200);
      expect(politica.body).toMatchObject({ mode: 'template', templates: [] });
      // o alvo vai como veio à prévia
      const [item] = (await previa([res.body[0].target]).expect(200)).body.items;
      expect(item.ok).toBe(true);
    });

    it('a revogada e a divergente não têm opção; a conversa RAI e a de outro workspace são 404; sem a permissão, 403', async () => {
      await revogar().expect(201);
      expect((await opcoes(conversaA).expect(200)).body).toEqual([]);
      await enviar(
        'post',
        `/api/contacts/${contatoA}/consents`,
        owner,
        { channelId: canalA, number: NUMERO, purposeId: finalidadeA, origin: 'in_person' },
        randomUUID(),
      ).expect(201);
      expect((await opcoes(conversaA).expect(200)).body).toHaveLength(1);
      await prisma.raw.messageTemplateVersion.updateMany({
        where: { id: versaoA },
        data: { status: 'divergent' },
      });
      expect((await opcoes(conversaA).expect(200)).body).toEqual([]);
      const rai = await prisma.raw.conversation.create({
        data: {
          workspaceId: wsA.workspaceId,
          channelId: canalA,
          externalAddress: '+5511955554444',
          senderStatus: 'unidentified',
        },
      });
      // a conversa RAI não existe para esta rota, como nas de conversa (C13)
      await opcoes(rai.id).expect(404);
      await opcoes(conversaA, ownerB).expect(404);
      await opcoes(conversaA, convidado).expect(403);
    });
  });

  // ── O despacho ──────────────────────────────────────────────────────────

  describe('o despacho', () => {
    it('caminho feliz: relê, trava, reconfere e envia o template pelo número da credencial; o uso `business_outbound` conclui; cobra uma vez', async () => {
      const messageId = await aprovado();
      const leituras = catalogo.leituras;
      await drain();
      expect(catalogo.leituras).toBe(leituras + 1);
      expect(meta.templates).toEqual([
        {
          phoneNumberId: PHONE_A,
          to: NUMERO,
          name: 'lembrete_horario',
          language: 'pt_BR',
          params: { header: [], body: [{ text: NOME }] },
        },
      ]);
      expect(meta.textos).toBe(0);
      expect(await despacho(messageId)).toMatchObject({
        state: 'sent',
        externalId: 'wamid.NEGOCIO',
        reservationId: null,
      });
      const [uso] = await usos();
      expect([uso.kind, uso.status]).toEqual(['business_outbound', 'concluded']);
      expect(uso.contactIds).toEqual([contatoA]);
      // o endereço do número, pelo HMAC: nunca os dígitos
      expect(uso.entityKeys).toEqual([expect.stringMatching(/^address:[0-9a-f]{64}$/)]);
      expect(JSON.stringify(uso)).not.toContain(NUMERO.slice(1));
      expect(await contador()).toBe(1);
      expect(await reservas()).toBe(0);
    });

    it.each([
      ['a revogação', () => revogar().expect(201), 'failed_permanent', 'consent_revoked'],
      [
        'o número trocado',
        () => editarContato({ phones: ['+5511966665555'] }).expect(200),
        'failed_permanent',
        'address_changed',
      ],
      [
        'o nome trocado',
        () => editarContato({ name: 'Outra Pessoa' }).expect(200),
        'failed_permanent',
        'approval_stale',
      ],
      [
        'o template trocado na Meta',
        async () =>
          catalogo.publicar(
            WABA_A,
            lembrete({ components: [{ type: 'BODY', text: 'Outro texto {{1}}.' }] }),
          ),
        'failed_permanent',
        'template_changed',
      ],
      [
        'a leitura da Meta que falha',
        async () => {
          catalogo.falha = { status: 500 };
        },
        'failed_before_send',
        'template_unverified',
      ],
      [
        'o template pausado na Meta',
        async () => catalogo.publicar(WABA_A, lembrete({ status: 'PAUSED' })),
        'failed_before_send',
        'template_unavailable',
      ],
    ])(
      'MUDANÇA ANTES DAS TRAVAS — %s: nada sai, com o motivo, e a reserva volta',
      async (_, mudar, estado, motivo) => {
        const messageId = await aprovado();
        await mudar();
        await drain();
        expect(meta.templates).toEqual([]);
        expect(await despacho(messageId)).toMatchObject({
          state: estado,
          errorCode: motivo,
          dispatchedAt: null,
          reservationId: null,
        });
        expect(await contador()).toBe(0);
        expect(await reservas()).toBe(0);
      },
    );

    it('a versão que diverge entre a releitura e as travas não sai: o status é relido SOB a guarda', async () => {
      const messageId = await aprovado();
      gancho = async (ponto, contexto) => {
        if (ponto === 'sessao') pidDaGuarda = contexto.pid;
        // a releitura já respondeu `confere`; outra releitura diverge a versão agora
        if (ponto === 'sessao') {
          await prisma.raw.messageTemplateVersion.updateMany({
            where: { id: versaoA },
            data: { status: 'divergent' },
          });
        }
      };
      await drain();
      expect(meta.templates).toEqual([]);
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'template_changed',
        dispatchedAt: null,
      });
    });

    it('o prazo que vence entre a releitura e as travas: `approval_expired`, conferido SOB a guarda', async () => {
      const conferencia = app.get(ConferenciaDoEnvio);
      const conferido = await noWorkspace(wsA.workspaceId, () =>
        conferencia.conferir(prisma.db, wsA.workspaceId, alvo()),
      );
      if (!conferido.ok) throw new Error('a conferência recusou');
      const prazo = new Date((await conferencia.agora()).getTime() + 1_500);
      const res = await aprovar([
        {
          ...alvo(),
          expiresAt: prazo.toISOString(),
          approvalHash: conferencia.hash(conferido.conferido.forma, prazo),
        },
      ]).expect(200);
      const messageId = res.body.items[0].messageId as string;
      gancho = async (ponto, contexto) => {
        if (ponto === 'sessao') pidDaGuarda = contexto.pid;
        // já com as travas, antes da reconferência: o prazo passa aqui
        if (ponto === 'travas') {
          while (Date.now() <= prazo.getTime() + 200) await new Promise((r) => setTimeout(r, 50));
        }
      };
      await drain();
      expect(meta.templates).toEqual([]);
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'approval_expired',
      });
    });

    it('o pedido de parar cancela o despacho que ainda não começou: `canceled`, sem chamar a Meta', async () => {
      const messageId = await aprovado();
      await pararNumero().expect(201);
      await drain();
      expect(meta.templates).toEqual([]);
      expect(await despacho(messageId)).toMatchObject({
        state: 'canceled',
        errorCode: 'stop_requested',
      });
      expect(await reservas()).toBe(0);
    });

    it('o prazo vencido antes do despacho: `approval_expired`, sem reler a Meta', async () => {
      const conferencia = app.get(ConferenciaDoEnvio);
      const conferido = await noWorkspace(wsA.workspaceId, () =>
        conferencia.conferir(prisma.db, wsA.workspaceId, alvo()),
      );
      if (!conferido.ok) throw new Error('a conferência recusou');
      const prazo = new Date((await conferencia.agora()).getTime() + 1_500);
      const res = await aprovar([
        {
          ...alvo(),
          expiresAt: prazo.toISOString(),
          approvalHash: conferencia.hash(conferido.conferido.forma, prazo),
        },
      ]).expect(200);
      const messageId = res.body.items[0].messageId as string;
      await new Promise((r) => setTimeout(r, 2_000));
      const leituras = catalogo.leituras;
      await drain();
      expect(catalogo.leituras).toBe(leituras);
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'approval_expired',
      });
      expect(meta.templates).toEqual([]);
    });

    it('MUDANÇA DURANTE A RECONFERÊNCIA: a revogação espera a guarda, e o envio sai com o que ela viu', async () => {
      const messageId = await aprovado();
      const segue = portao();
      abertos.push(segue.abrir);
      const reconferida = portao();
      gancho = async (ponto, contexto) => {
        if (ponto === 'sessao') pidDaGuarda = contexto.pid;
        if (ponto === 'reconferida') {
          reconferida.abrir();
          await segue.aberto;
        }
      };
      const envio = disparar(drain());
      await reconferida.aberto;
      const revogacao = disparar(revogar().then((r) => r));
      await alguemEspera(pidDaGuarda);
      segue.abrir();
      await envio;
      expect((await revogacao).status).toBe(201);
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      expect(meta.templates).toHaveLength(1);
      expect(
        (await prisma.raw.consent.findFirst({ where: { id: consentimentoA } }))?.revokedAt,
      ).not.toBeNull();
    });

    it('A IMPORTAÇÃO durante a reconferência espera a guarda (os escritores em massa), e o envio sai com o que ela viu', async () => {
      const messageId = await aprovado();
      const segue = portao();
      abertos.push(segue.abrir);
      const reconferida = portao();
      gancho = async (ponto, contexto) => {
        if (ponto === 'sessao') pidDaGuarda = contexto.pid;
        if (ponto === 'reconferida') {
          reconferida.abrir();
          await segue.aberto;
        }
      };
      const envio = disparar(drain());
      await reconferida.aberto;
      // o mesmo número, noutro contato: a importação pega o 1b EXCLUSIVO
      const importacao = disparar(
        enviar(
          'post',
          '/api/contacts/import',
          owner,
          { rows: [{ name: 'Importada Ficticia', phone: NUMERO }] },
          randomUUID(),
        ).then((r) => r),
      );
      await alguemEspera(pidDaGuarda);
      segue.abrir();
      await envio;
      expect((await importacao).status).toBe(201);
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      expect(meta.templates).toHaveLength(1);
    });

    it('MUDANÇA DURANTE A CHAMADA: a revogação espera até o prazo e responde 409; a mensagem sai', async () => {
      const messageId = await aprovado();
      const solta = portao();
      abertos.push(solta.abrir);
      meta.segura = solta.aberto;
      const envio = disparar(drain());
      await meta.entrou.aberto;
      // o MARCADOR já está gravado durante a chamada: um crash daqui em diante
      // nunca leva a reenvio
      expect((await despacho(messageId))?.dispatchedAt).not.toBeNull();
      const revogacao = await revogar();
      expect(revogacao.status).toBe(409);
      solta.abrir();
      await envio;
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      expect(
        (await prisma.raw.consent.findFirst({ where: { id: consentimentoA } }))?.revokedAt,
      ).toBeNull();
    });

    it('a guarda MORRE durante a chamada: `unknown_after_dispatch` (in_doubt), cobrado, e a reentrega não reenvia', async () => {
      const messageId = await aprovado();
      const solta = portao();
      abertos.push(solta.abrir);
      meta.segura = solta.aberto;
      const envio = disparar(drain());
      await meta.entrou.aberto;
      await derrubar(pidDaGuarda);
      solta.abrir();
      await envio;
      const [uso] = await usos();
      expect(uso.status).toBe('in_doubt');
      expect(await despacho(messageId)).toMatchObject({
        state: 'unknown_after_dispatch',
        errorCode: 'in_doubt',
      });
      expect(await contador()).toBe(1);
      await noWorkspace(wsA.workspaceId, () =>
        app.get(WhatsappSendService).dispatch({
          workspaceId: wsA.workspaceId,
          payload: { messageId },
        } as never),
      );
      expect(meta.templates).toHaveLength(1);
    });

    it('CRASH entre o marcador e a chamada: a posse vence, e a nova tentativa não reenvia (`unknown_after_dispatch`)', async () => {
      const messageId = await aprovado();
      // o estado de um processo que morreu DEPOIS do marcador e antes da chamada
      await prisma.raw.messageDispatch.updateMany({
        where: { messageId },
        data: {
          state: 'sending',
          claimToken: randomUUID(),
          dispatchedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() - 60_000),
        },
      });
      await noWorkspace(wsA.workspaceId, () =>
        app.get(WhatsappSendService).dispatch({
          workspaceId: wsA.workspaceId,
          payload: { messageId },
        } as never),
      );
      expect(meta.templates).toEqual([]);
      expect(await despacho(messageId)).toMatchObject({
        state: 'unknown_after_dispatch',
        errorCode: 'lease_expired_in_flight',
      });
    });

    it('CRASH depois da chamada e antes do COMMIT: a persistência falha, o despacho fica incerto com o wamid, e não há novo envio', async () => {
      const messageId = await aprovado();
      jest
        .spyOn(app.get(UsageService), 'settleWithin')
        .mockRejectedValue(new Error('falha simulada'));
      await drain();
      expect(await despacho(messageId)).toMatchObject({
        state: 'unknown_after_dispatch',
        errorCode: 'persistence_failed',
        externalId: 'wamid.NEGOCIO',
      });
      jest.restoreAllMocks();
      await noWorkspace(wsA.workspaceId, () =>
        app.get(WhatsappSendService).dispatch({
          workspaceId: wsA.workspaceId,
          payload: { messageId },
        } as never),
      );
      expect(meta.templates).toHaveLength(1);
    });

    it('a leitura que falhou volta pelo outbox e relê: na segunda, sai', async () => {
      const messageId = await aprovado();
      catalogo.falha = { status: 500 };
      await drain();
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_before_send',
        errorCode: 'template_unverified',
      });
      const evento = await prisma.raw.outboxEvent.findFirst({
        where: { eventType: 'whatsapp.send_pending' },
      });
      await makeRetriableNowById(prisma, evento!.id);
      await drain();
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      expect(meta.templates).toHaveLength(1);
    });
  });

  // ── A pré-condição do vertical (E7) ─────────────────────────────────────

  describe('a pré-condição do vertical (E7)', () => {
    const pedido = randomUUID();
    const agendamento = randomUUID();
    const chave = `teste.agendamento:${agendamento}`;
    const doPedido = { originRef: `teste.pedido:${pedido}` };
    const comCampoDoVertical = async () => {
      // a finalidade do vertical, com um campo dele: a porta tem de devolvê-lo
      const id = (
        await app.get(ConsentPurposesService).criarVersao('acme', {
          key: 'confirmacao',
          description: 'Confirmação de agendamento',
          category: 'utility',
          fields: ['contato.nome', 'pedido.horario'],
        })
      ).purposeId;
      await enviar(
        'post',
        `/api/contacts/${contatoA}/consents`,
        owner,
        { channelId: canalA, number: NUMERO, purposeId: id, origin: 'in_person' },
        randomUUID(),
      ).expect(201);
      await enviar('post', `/api/templates/versions/${versaoA}/reviews`, owner, {
        purposeId: id,
        contentHash: (await prisma.raw.messageTemplateVersion.findFirst({ where: { id: versaoA } }))
          ?.contentHash,
      }).expect(201);
      return id;
    };

    it('vale: a conversa nasce para o número, as chaves entram nas travas e no uso, e a mensagem sai', async () => {
      const purposeId = await comCampoDoVertical();
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      await prisma.raw.conversation.deleteMany({ where: { id: conversaA } });
      const messageId = await aprovado({ ...doPedido, purposeId });
      const aprovacao = await prisma.raw.outboundApproval.findFirst({ where: { messageId } });
      expect(aprovacao?.validityKeys).toEqual([chave]);
      const conversa = await prisma.raw.conversation.findFirst({
        where: {
          id: (await prisma.raw.message.findFirst({ where: { id: messageId } }))!.conversationId,
        },
      });
      expect(conversa).toMatchObject({
        channelId: canalA,
        contactId: contatoA,
        externalAddress: NUMERO,
        senderStatus: 'identified',
      });
      await drain();
      expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
      const [uso] = await usos();
      expect([...uso.entityKeys].sort()).toEqual(
        [expect.stringMatching(/^address:[0-9a-f]{64}$/), `validity:${chave}`].sort(),
      );
      // a porta recebeu o workspace explícito e o id do pedido, em cada passo
      expect(new Set(porta.consultas.map(([ws, id]) => `${ws}:${id}`))).toEqual(
        new Set([`${wsA.workspaceId}:${pedido}`]),
      );
    });

    it('não vale, indisponível e o prefixo desconhecido: recusa na aprovação; no despacho, de vez ou de novo', async () => {
      const purposeId = await comCampoDoVertical();
      const motivo = async (mudanca: Parameters<typeof alvo>[0]) =>
        (await previa([alvo(mudanca)]).expect(200)).body.items[0].reason;
      expect(await motivo({ ...doPedido, purposeId })).toBe('precondition_failed');
      expect(await motivo({ originRef: `outro.pedido:${pedido}`, purposeId })).toBe(
        'precondition_unknown',
      );
      porta.foraDoAr = true;
      expect(await motivo({ ...doPedido, purposeId })).toBe('precondition_unavailable');
      porta.foraDoAr = false;

      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      const indisponivel = await aprovado({ ...doPedido, purposeId });
      porta.foraDoAr = true;
      await drain();
      expect(await despacho(indisponivel)).toMatchObject({
        state: 'failed_before_send',
        errorCode: 'precondition_unavailable',
        dispatchedAt: null,
      });
      porta.foraDoAr = false;
      porta.validos.delete(`${wsA.workspaceId}:${pedido}`);
      const evento = await prisma.raw.outboxEvent.findFirst({
        where: { eventType: 'whatsapp.send_pending' },
      });
      await makeRetriableNowById(prisma, evento!.id);
      await drain();
      expect(await despacho(indisponivel)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'precondition_failed',
        dispatchedAt: null,
      });
      expect(meta.templates).toEqual([]);
    });

    it('as chaves que mudaram desde a aprovação e os campos fora da finalidade não saem', async () => {
      const purposeId = await comCampoDoVertical();
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      const messageId = await aprovado({ ...doPedido, purposeId });
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [`teste.agendamento:${randomUUID()}`],
      });
      await drain();
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'approval_stale',
      });
      // um campo a mais que a finalidade não permite: fora do contrato
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h', 'pedido.medico': 'Dra Ficticia' },
        validityKeys: [chave],
      });
      expect(
        (await previa([alvo({ ...doPedido, purposeId })]).expect(200)).body.items[0].reason,
      ).toBe('precondition_unavailable');
      expect(meta.templates).toEqual([]);
    });

    it('o pedido de OUTRO contato não vale para o alvo: na prévia, na aprovação e no despacho (`precondition_failed`)', async () => {
      const purposeId = await comCampoDoVertical();
      const outroContato = (
        await enviar('post', '/api/contacts', owner, { name: 'Bia Ficticia', phones: [] }).expect(
          201,
        )
      ).body.id as string;
      const resposta = (contactId: string) => ({
        valid: true as const,
        contactId,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      // o pedido é de outro contato: os valores dele não vão a este alvo
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, resposta(outroContato));
      expect(
        (await previa([alvo({ ...doPedido, purposeId })]).expect(200)).body.items[0].reason,
      ).toBe('precondition_failed');
      // aprovado para o contato certo, e o pedido muda de dono antes do despacho
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, resposta(contatoA));
      const item = await previsto({ ...doPedido, purposeId });
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, resposta(outroContato));
      expect((await aprovar([item]).expect(200)).body.items[0].reason).toBe('precondition_failed');
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, resposta(contatoA));
      const messageId = (await aprovar([item]).expect(200)).body.items[0].messageId as string;
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, resposta(outroContato));
      await drain();
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'precondition_failed',
      });
      expect(meta.templates).toEqual([]);
    });

    it('a porta LENTA no despacho: `precondition_unavailable` pelo prazo dela, dentro do orçamento da reconferência', async () => {
      const purposeId = await comCampoDoVertical();
      porta.validos.set(`${wsA.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      const messageId = await aprovado({ ...doPedido, purposeId });
      // no despacho, a porta não responde mais
      jest.spyOn(porta, 'check').mockImplementation(() => new Promise(() => undefined));
      await drain();
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_before_send',
        errorCode: 'precondition_unavailable',
        dispatchedAt: null,
      });
      expect(meta.templates).toEqual([]);
    });

    it('P0: o pedido de outro workspace não vale', async () => {
      const purposeId = await comCampoDoVertical();
      porta.validos.set(`${wsB.workspaceId}:${pedido}`, {
        valid: true,
        contactId: contatoA,
        values: { 'pedido.horario': '10h' },
        validityKeys: [chave],
      });
      expect(
        (await previa([alvo({ ...doPedido, purposeId })]).expect(200)).body.items[0].reason,
      ).toBe('precondition_failed');
      expect(porta.consultas).toEqual([[wsA.workspaceId, pedido]]);
    });
  });

  // ── A guarda ────────────────────────────────────────────────────────────

  it('a guarda aceita o endereço pelo HMAC e a chave de validade, e recusa outra forma de chave', async () => {
    const guarda = app.get(ContentUseGuard);
    for (const chave of [
      'address:123',
      `validity:${randomUUID()}`,
      'conversation:x',
      `address:${'A'.repeat(64)}`,
    ]) {
      await expect(
        noWorkspace(wsA.workspaceId, () =>
          guarda.executar({
            workspaceId: wsA.workspaceId,
            kind: 'business_outbound',
            contactIds: [contatoA],
            entityKeys: [chave],
            prazoMs: 1_000,
            origem: { messageId: randomUUID(), claimToken: randomUUID() },
            reservas: [],
            reconferir: async () => 'liberado',
            iniciar: async () => undefined,
            persistir: async () => undefined,
            persistenciaFalhou: async () => undefined,
          }),
        ),
      ).rejects.toThrow(/entityKeys/);
    }
    expect(await usos()).toEqual([]);
  });
});

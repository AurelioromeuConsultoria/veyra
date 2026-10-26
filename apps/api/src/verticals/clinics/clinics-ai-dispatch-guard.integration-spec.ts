import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../test/integration/db-url';
import { resetDb } from '../../../test/integration/harness';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  makeRetriableNowById,
  seedPermissionCatalog,
} from '../../../test/integration/fixtures';
import type { AuthContext } from '../../common/decorators';
import { CryptoService } from '../../common/crypto.service';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../../channels/meta.transport';
import { WhatsappSendService } from '../../channels/whatsapp-send.service';
import {
  ContentUseGuard,
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
} from '../../content-use/content-use.guard';
import { OrigensDosUsos } from '../../content-use/content-use.orphans';
import { ReconciliacaoDosUsos } from '../../content-use/content-use.reconciler';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../../content-use/content-use.pools';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import { JobsService } from '../../jobs/jobs.service';
import {
  AI_PROPOSAL_REPOSITORY,
  type AiProposalRepository,
} from '../../intelligence/ports/repositories';
import { UsageService } from '../../usage/usage.service';
import type { Db } from '../../prisma/prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsReleasesService } from './clinics-releases.service';

/**
 * G3.2 do ADR-047 (adendo 7 §9): o ENVIO DA MENSAGEM ESCRITA PELA IA sob a
 * guarda de uso externo, contra o transporte falso e a porta REAL do Clinics.
 * Os contatos conferidos na aprovação ficam no despacho e são reconferidos no
 * envio. Determinístico: quem espera quem é conferido em `pg_blocking_pids`, e
 * o envio fica preso num portão. Dados fictícios; nada sai para a Meta.
 */
const CONFIG: ConfigDaGuarda = {
  tamanhoDoPoolDaGuarda: 4,
  tamanhoDoPoolDeRegistro: 3,
  esperaPorSessaoMs: 3_000,
  registroConexaoMs: 1_000,
  registroInstrucaoMs: 800,
  travaMs: 3_000,
  reconferenciaMs: 2_000,
  reconciliacaoMs: 1_000,
  mudancaTravaMs: 3_000,
  mudancaTransacaoMs: 15_000,
  importacaoTravaMs: 3_000,
  ingestaoTravaMs: 2_000,
  ingestaoLoteMs: 10_000,
  workspaceTravaMs: 3_000,
  workspaceTransacaoMs: 15_000,
  prazoDaIaMs: 1_000,
  // o envio com prazo curto: o teste do envio que não respeita o sinal cabe
  prazoDaMetaMs: 1_500,
  prazoDoWebhookMs: 1_000,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/** O transporte falso: conta os envios, guarda o sinal e pode segurar a resposta. */
class MetaFalsa implements MetaTransport {
  envios: { to: string; body?: string }[] = [];
  sinal: AbortSignal | null = null;
  entrou = portao();
  segura: Promise<void> | null = null;
  ignoraSinal = false;
  proximo: SendOutcome = { ok: true, externalId: 'wamid.ENVIADA' };

  reiniciar(): void {
    this.envios = [];
    this.sinal = null;
    this.entrou = portao();
    this.segura = null;
    this.ignoraSinal = false;
    this.lanca = false;
    this.proximo = { ok: true, externalId: 'wamid.ENVIADA' };
  }

  lanca = false;

  async sendText(_c: unknown, to: string, body: string, signal?: AbortSignal) {
    this.envios.push({ to, body });
    this.sinal = signal ?? null;
    this.entrou.abrir();
    if (this.lanca) throw new Error('o transporte lançou depois de começar');
    if (this.segura) {
      if (this.ignoraSinal || !signal) {
        await this.segura;
      } else {
        const abortou = await Promise.race([
          this.segura.then(() => false),
          new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(true))),
        ]);
        // como o transporte real: a requisição caiu sem resposta
        if (abortou) return { ok: false as const, failure: { networkFailure: true } };
      }
    }
    return this.proximo;
  }
  async sendTemplate(_c: unknown, to: string): Promise<SendOutcome> {
    this.envios.push({ to });
    return this.proximo;
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('G3.2 — o envio da mensagem da IA sob a guarda de uso externo (ADR-047 adendos 6 e 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService;
  let observador: Client;
  let ws: string;
  let auth: AuthContext;
  let conversationId: string;
  let contato: string;
  const meta = new MetaFalsa();
  const SLUG = 'acme';

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        { provide: META_TRANSPORT, useValue: meta },
        {
          provide: GANCHOS_DA_GUARDA,
          useValue: (ponto: PontoDaGuarda, contexto: ContextoDoPonto) => gancho?.(ponto, contexto),
        },
      ],
    );
    prisma = app.get(PrismaService);
    cls = app.get(ClsService);
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });

  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  let pidDaGuarda: number | null = null;

  beforeEach(async () => {
    meta.reiniciar();
    pidDaGuarda = null;
    gancho = (ponto, contexto) => {
      if (ponto === 'sessao') pidDaGuarda = contexto.pid;
    };
    jest.restoreAllMocks();
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    const fixture = await createWorkspaceFixture(prisma, SLUG);
    ws = fixture.workspaceId;
    const userId = await createUserFixture(prisma, `dona-${randomUUID().slice(0, 8)}@acme.test`);
    const membershipId = await createMembershipFixture(prisma, ws, userId, fixture.roles.owner);
    auth = { userId, email: 'dona@acme.test', membershipId, workspaceId: ws, sessionId: 'teste' };

    await app.get(ClinicsActivationService).enable(SLUG);
    // com o número da conversa, como a ingestão o deixaria (ADR-052): sem ele, a
    // política de envio recusa o número que saiu do cadastro do contato
    contato = (
      await prisma.raw.contact.create({
        data: {
          workspaceId: ws,
          name: 'Fictício',
          phones: ['+5511900000001'],
          phonesNormalized: ['+5511900000001'],
          phoneMatchKeys: ['00000001'],
        },
      })
    ).id;
    await liberar(contato);
    const canal = await prisma.raw.channel.create({
      data: { workspaceId: ws, type: 'whatsapp', name: 'WhatsApp fictício' },
    });
    await prisma.raw.channelCredential.create({
      data: {
        workspaceId: ws,
        channelId: canal.id,
        phoneNumberId: '100000000000001',
        businessAccountId: 'waba-ficticia',
        tokenCipher: app.get(CryptoService).encrypt('token-ficticio'),
      },
    });
    // a janela de 24 h aberta: o contato falou agora
    conversationId = (
      await prisma.raw.conversation.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          contactId: contato,
          externalAddress: '+5511900000001',
          lastInboundAt: new Date(),
        },
      })
    ).id;
  });

  const noWorkspace = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      cls.set('workspaceId', ws);
      return fn();
    });
  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 400; i++) {
      if (await condicao()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`não aconteceu: ${descricao}`);
  };
  const alguemEspera = (pid: number | null) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
        [pid],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a sessão ${pid}`);
  const esperando = (pid: number | null) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: number }>(
        'SELECT cardinality(pg_blocking_pids($1::int)) AS n',
        [pid],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    }, `a sessão ${pid} esperando`);
  const derrubar = async (pid: number | null) => {
    await observador.query('SELECT pg_terminate_backend($1)', [pid]);
    await ate(async () => {
      const { rows } = await observador.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
        pid,
      ]);
      return rows.length === 0;
    }, `a sessão ${pid} cair`);
  };

  const liberar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).grant(auth, contactId, 'supplier'));
  const revogar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).revoke(auth, contactId));
  const drain = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const contador = async () =>
    Number(
      (
        await prisma.raw.usageCounter.findFirst({
          where: { workspaceId: ws, metric: 'messages_sent' },
          select: { value: true },
        })
      )?.value ?? 0,
    );
  const despacho = (messageId: string) =>
    prisma.raw.messageDispatch.findFirst({ where: { messageId } });
  const usos = () =>
    prisma.raw.contentUse.findMany({
      where: { workspaceId: ws },
      orderBy: { authorizedAt: 'asc' },
    });

  /** A mensagem da IA aprovada: escrita com os contatos da aprovação, como `executeSendMessage`. */
  const mensagemDaIa = (contatosDaAprovacao: string[]) =>
    noWorkspace(async () => {
      const envio = app.get(WhatsappSendService);
      const preparado = await envio.prepareOutbound(ws, { conversationId });
      return (
        prisma.db as unknown as { $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> }
      ).$transaction(async (tx) =>
        envio.writeOutboundWithin(
          tx,
          ws,
          preparado,
          {
            body: 'Temos horário amanhã às 10h.',
            authorType: 'ai',
            authorMembershipId: auth.membershipId as string,
          },
          { contactIds: contatosDaAprovacao },
        ),
      );
    });

  it('caminho feliz: os contatos da aprovação ficam no despacho; o uso `ai_message_dispatch` é registrado antes do envio e conclui com o despacho', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    expect((await despacho(messageId))?.approvalContactIds).toEqual([contato]);
    await drain();
    expect(meta.envios).toHaveLength(1);
    const [uso] = await usos();
    expect([uso.kind, uso.status]).toEqual(['ai_message_dispatch', 'concluded']);
    expect((uso.origin as Record<string, unknown>).messageId).toBe(messageId);
    expect(await despacho(messageId)).toMatchObject({ state: 'sent', reservationId: null });
    expect(await contador()).toBe(1);
  });

  it('o envio reconfere os contatos da APROVAÇÃO, não só o contato atual da conversa', async () => {
    const outro = (await prisma.raw.contact.create({ data: { workspaceId: ws, name: 'Outro' } }))
      .id;
    await liberar(outro);
    const { messageId } = await mensagemDaIa([outro, contato]);
    await revogar(outro); // o contato da conversa continua liberado
    await drain();
    expect(meta.envios).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'content_restricted',
    });
    expect(await contador()).toBe(0);
  });

  it('MUDANÇA PRIMEIRO: o envio espera a revogação e, depois, recusa sem chamar a Meta; a reserva volta', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const restricao = app.get(MudancasDeRestricao);
    const travou = portao();
    const segue = portao();
    const real = restricao.porContato.bind(restricao);
    let primeira = true;
    jest.spyOn(restricao, 'porContato').mockImplementation(async (...args) => {
      const marcados = await real(...args);
      if (primeira) {
        primeira = false;
        travou.abrir();
        await segue.aberto;
      }
      return marcados;
    });
    const revogacao = revogar(contato);
    await travou.aberto;
    const envio = drain();
    try {
      await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
      await esperando(pidDaGuarda);
    } finally {
      segue.abrir();
    }
    await revogacao;
    await envio;
    expect(meta.envios).toEqual([]);
    // o marcador (gravado antes da guarda) sai: a mensagem comprovadamente não foi despachada
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'content_restricted',
      dispatchedAt: null,
    });
    expect(await contador()).toBe(0);
  });

  it('USO PRIMEIRO: a revogação espera o envio em andamento, que conclui `sent`', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const solta = portao();
    meta.segura = solta.aberto;
    const envio = drain();
    await meta.entrou.aberto;
    let revogou = false;
    const revogacao = revogar(contato).then(() => {
      revogou = true;
    });
    try {
      await alguemEspera(pidDaGuarda);
      expect(revogou).toBe(false);
    } finally {
      solta.abrir();
    }
    await envio;
    await revogacao;
    expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
  });

  it('a guarda MORRE durante o envio: o despacho fica `unknown_after_dispatch`, cobrado, e a reentrega NÃO reenvia', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const solta = portao();
    meta.segura = solta.aberto;
    const envio = drain();
    await meta.entrou.aberto;
    await derrubar(pidDaGuarda);
    solta.abrir();
    await envio;
    const [uso] = await usos();
    expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'commit']);
    // a Meta devolveu o wamid antes de a guarda cair: ele fica no despacho
    // incerto e na trilha, para quem triar achar a mensagem no provedor
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'in_doubt',
      reservationId: null,
      externalId: 'wamid.ENVIADA',
    });
    expect(
      await prisma.raw.auditLog.count({
        where: { workspaceId: ws, action: 'message.dispatch_in_doubt', entityId: messageId },
      }),
    ).toBe(1);
    expect(await contador()).toBe(1);
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
    // uma reentrega do evento (o outbox o entregou; o banco não deixa reabrir
    // evento terminal) chega ao despacho de novo: não reenvia
    await noWorkspace(() =>
      app.get(WhatsappSendService).dispatch({
        workspaceId: ws,
        payload: { messageId },
      } as never),
    );
    expect(meta.envios).toHaveLength(1);
    expect(await contador()).toBe(1);
  });

  it('o PRAZO aborta o envio pelo sinal: desfecho ambíguo, `unknown_after_dispatch`, cobrado e sem reenvio', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    meta.segura = new Promise<void>(() => undefined);
    await drain();
    expect(meta.sinal?.aborted).toBe(true);
    expect(await despacho(messageId)).toMatchObject({ state: 'unknown_after_dispatch' });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await contador()).toBe(1);
  });

  it('o envio que IGNORA o sinal e passa do prazo: o próprio processo marca `overran_deadline`, e o despacho fica incerto', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const solta = portao();
    meta.segura = solta.aberto;
    meta.ignoraSinal = true;
    try {
      await drain();
      const [uso] = await usos();
      expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
      expect(await despacho(messageId)).toMatchObject({
        state: 'unknown_after_dispatch',
        externalId: null,
      });
      expect(await contador()).toBe(1);
    } finally {
      solta.abrir();
    }
    // a Meta responde DEPOIS: o desfecho não muda, mas o wamid tardio vai para
    // o despacho incerto e para a trilha
    await ate(
      async () =>
        (await prisma.raw.auditLog.count({
          where: { workspaceId: ws, action: 'message.dispatch_in_doubt', entityId: messageId },
        })) === 1,
      'a trilha do wamid tardio',
    );
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      externalId: 'wamid.ENVIADA',
    });
    expect(meta.envios).toHaveLength(1);
    expect(await contador()).toBe(1);
  });

  it('falha COMPROVADAMENTE antes do envio e transitória: a reserva volta, e a nova tentativa do outbox é um uso novo, pela guarda', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    meta.proximo = { ok: false, failure: { status: 429 } };
    await drain();
    expect(await despacho(messageId)).toMatchObject({ state: 'failed_before_send' });
    expect(await contador()).toBe(0);
    meta.proximo = { ok: true, externalId: 'wamid.SEGUNDA' };
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    await makeRetriableNowById(prisma, evento!.id);
    await drain();
    expect(await despacho(messageId)).toMatchObject({ state: 'sent', externalId: 'wamid.SEGUNDA' });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded', 'concluded']);
    expect(await contador()).toBe(1);
  });

  it('o transporte LANÇA depois de começar: incerto, `unknown_after_dispatch`, cobrado e sem reenvio', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    meta.lanca = true;
    await drain();
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'uncertain',
    });
    expect(await contador()).toBe(1);
    expect(meta.envios).toHaveLength(1);
  });

  it('a PERSISTÊNCIA do envio falha: volta ao SAVEPOINT, a reserva vai pelo teto e o despacho fica incerto', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const usage = app.get(UsageService);
    jest.spyOn(usage, 'settleWithin').mockRejectedValue(new Error('falha simulada'));
    await drain();
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'persistence_failed',
      externalId: 'wamid.ENVIADA',
    });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await contador()).toBe(1);
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('a guarda LANÇA antes de começar: nada sai, o marcador é limpo, a reserva volta e a nova tentativa é do outbox', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    jest
      .spyOn(app.get(ContentUseGuard), 'executar')
      .mockRejectedValueOnce(new Error('defeito simulado antes do início'));
    await drain();
    expect(meta.envios).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_before_send',
      errorCode: 'not_started',
      dispatchedAt: null,
      reservationId: null,
    });
    expect(await contador()).toBe(0);
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
    const evento = await prisma.raw.outboxEvent.findFirst({
      where: { eventType: 'whatsapp.send_pending' },
    });
    await makeRetriableNowById(prisma, evento!.id);
    await drain();
    expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
    expect(meta.envios).toHaveLength(1);
    expect(await contador()).toBe(1);
  });

  it('a varredura de despachos abandonados comita ANTES do detector, que cobra a reserva pelo teto: a mensagem é cobrada uma vez só', async () => {
    const { messageId } = await mensagemDaIa([contato]);
    const reserva = (await despacho(messageId))?.reservationId as string;
    const claimToken = randomUUID();
    // o estado de um processo que morreu DEPOIS de registrar o uso e enviar: o
    // despacho em voo, com marcador e posse vencida, e o uso órfão `authorized`
    await prisma.raw.$executeRaw`
      UPDATE "MessageDispatch"
         SET "state" = 'sending', "claimToken" = ${claimToken}::uuid,
             "dispatchedAt" = now(), "leaseExpiresAt" = now() - interval '20 minutes'
       WHERE "messageId" = ${messageId}::uuid`;
    await prisma.raw.$executeRaw`
      INSERT INTO "ContentUse" ("id", "workspaceId", "kind", "status", "contactIds", "entityKeys",
                                "origin", "reservationIds", "instanceId", "deadlineAt")
      VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'ai_message_dispatch', 'authorized',
              ARRAY[${contato}::uuid], ARRAY[]::text[],
              ${JSON.stringify({ messageId, claimToken })}::jsonb, ARRAY[${reserva}::uuid],
              'teste:morto', now() - interval '1 minute')`;
    const usage = app.get(UsageService);
    const real = usage.settle.bind(usage);
    let detector: { marcados: number } | null = null;
    jest.spyOn(usage, 'settle').mockImplementation(async (...args) => {
      // a varredura já comitou o despacho incerto e vai liquidar: o detector chega antes
      detector ??= await app.get(ReconciliacaoDosUsos).varrer();
      return real(...args);
    });
    await app.get(WhatsappSendService).reapStaleDispatches();
    expect(detector).toMatchObject({ marcados: 1 });
    const [uso] = await usos();
    expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'reconciliation']);
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'abandoned_in_flight',
      reservationId: null,
    });
    expect(await contador()).toBe(1);
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
  });

  /** A aprovação REAL de uma proposta da IA (`executeSendMessage`), editada ou não. */
  const aprovarRascunho = async (editado: boolean) => {
    const run = await prisma.raw.aiRun.create({
      data: {
        workspaceId: ws,
        capability: 'reply_suggestion',
        model: 'claude-sonnet-5',
        contextSummary: 'fictício',
        status: 'ok',
      },
    });
    const proposta = await prisma.raw.aiProposal.create({
      data: {
        workspaceId: ws,
        runId: run.id,
        type: 'send_message',
        payload: { body: 'Temos horário.' },
        rationale: 'r',
        contactId: contato,
        conversationId,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        pendingReplyMark: true,
      },
    });
    const body = editado ? 'Temos horário amanhã, às 10h.' : 'Temos horário.';
    return (await noWorkspace(() =>
      app
        .get<AiProposalRepository>(AI_PROPOSAL_REPOSITORY)
        .executeSendMessage(
          proposta.id,
          run.id,
          { conversationId, body, edited: editado },
          { workspaceId: ws, membershipId: auth.membershipId as string },
          { workspaceId: ws, contactIds: [contato, null], recheck: async () => 'allowed' },
        ),
    )) as { messageId: string };
  };
  const autoria = async (messageId: string) =>
    (await prisma.raw.message.findFirst({ where: { id: messageId } }))?.authorType;

  it('a APROVAÇÃO grava no despacho os contatos que conferiu sob as travas e a origem de IA', async () => {
    const { messageId } = await aprovarRascunho(false);
    expect(await despacho(messageId)).toMatchObject({
      approvalContactIds: [contato],
      fromAiProposal: true,
    });
    expect(await autoria(messageId)).toBe('ai');
  });

  it('o rascunho EDITADO mantém a origem de IA: a autoria é da pessoa, mas o envio sai sob a guarda (decisão de 2026-10-21)', async () => {
    const { messageId } = await aprovarRascunho(true);
    expect(await autoria(messageId)).toBe('user');
    expect(await despacho(messageId)).toMatchObject({ fromAiProposal: true });
    await drain();
    expect(meta.envios).toHaveLength(1);
    const [uso] = await usos();
    expect([uso?.kind, uso?.status]).toEqual(['ai_message_dispatch', 'concluded']);
    expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
    expect(await contador()).toBe(1);
  });

  it('o rascunho EDITADO para contato que ficou restrito depois da aprovação NÃO sai', async () => {
    const { messageId } = await aprovarRascunho(true);
    await revogar(contato);
    await drain();
    expect(meta.envios).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({
      state: 'failed_permanent',
      errorCode: 'content_restricted',
    });
    expect(await contador()).toBe(0);
  });

  it('a mensagem LIVRE escrita por pessoa continua fora da guarda e sai para contato restrito (ADR-048)', async () => {
    await revogar(contato);
    const { messageId } = await noWorkspace(() =>
      app.get(WhatsappSendService).enqueueOutbound(ws, {
        conversationId,
        body: 'Oi, aqui é da clínica.',
        actorMembershipId: auth.membershipId as string,
      }),
    );
    expect(await despacho(messageId)).toMatchObject({ fromAiProposal: false });
    await drain();
    expect(meta.envios).toHaveLength(1);
    expect(await usos()).toEqual([]);
    expect(await despacho(messageId)).toMatchObject({ state: 'sent' });
  });

  it.each([
    ['a varredura periódica', 'abandoned_in_flight'],
    ['a reentrega do evento', 'lease_expired_in_flight'],
    ['as tentativas esgotadas', 'retries_exhausted_in_flight'],
  ])(
    'TRIAGEM, por %s: a guarda abortou e o processo morreu antes de encerrar o despacho — "não saiu", sem cobrança, distinto da entrega desconhecida',
    async (_nome, caminho) => {
      const { messageId } = await mensagemDaIa([contato]);
      const reserva = (await despacho(messageId))?.reservationId as string;
      const claimToken = randomUUID();
      // o estado de um processo que morreu DEPOIS de a guarda abortar (o uso
      // `aborted`, a reserva devolvida) e ANTES do `finish`: o despacho em voo,
      // com marcador e posse vencida
      await noWorkspace(() => app.get(UsageService).release(reserva));
      await prisma.raw.$executeRaw`
        UPDATE "MessageDispatch"
           SET "state" = 'sending', "claimToken" = ${claimToken}::uuid,
               "dispatchedAt" = now(), "leaseExpiresAt" = now() - interval '20 minutes'
         WHERE "messageId" = ${messageId}::uuid`;
      await prisma.raw.$executeRaw`
        INSERT INTO "ContentUse" ("id", "workspaceId", "kind", "status", "contactIds", "entityKeys",
                                  "origin", "reservationIds", "instanceId", "deadlineAt", "finishedAt")
        VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'ai_message_dispatch', 'aborted',
                ARRAY[${contato}::uuid], ARRAY[]::text[],
                ${JSON.stringify({ messageId, claimToken })}::jsonb, ARRAY[${reserva}::uuid],
                'teste:morto', now(), now())`;
      const envio = app.get(WhatsappSendService);
      if (caminho === 'abandoned_in_flight') await envio.reapStaleDispatches();
      if (caminho === 'lease_expired_in_flight') {
        await noWorkspace(() =>
          envio.dispatch({ workspaceId: ws, payload: { messageId } } as never),
        );
      }
      if (caminho === 'retries_exhausted_in_flight') await envio.markExhausted(ws, messageId);
      expect(await despacho(messageId)).toMatchObject({
        state: 'unknown_after_dispatch',
        errorCode: 'not_sent_guard_aborted',
        dispatchedAt: null,
        reservationId: null,
      });
      expect(meta.envios).toEqual([]);
      expect(await contador()).toBe(0);
    },
  );

  it('a escrita recusa contatos da aprovação de OUTRO workspace', async () => {
    const outro = await createWorkspaceFixture(prisma, 'outro');
    const alheio = (
      await prisma.raw.contact.create({ data: { workspaceId: outro.workspaceId, name: 'Alheio' } })
    ).id;
    await expect(mensagemDaIa([alheio])).rejects.toThrow(/Contatos da aprovação/);
    expect(await prisma.raw.messageDispatch.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('o tratador de origem do envio numa transação `raw`, com linhas de OUTRO workspace: só toca o despacho do workspace do uso', async () => {
    const outroWs = await createWorkspaceFixture(prisma, 'outro');
    const { messageId } = await mensagemDaIa([contato]);
    const claimToken = randomUUID();
    await prisma.raw.messageDispatch.updateMany({
      where: { messageId },
      data: { state: 'sending', claimToken },
    });
    const tratador = app.get(OrigensDosUsos).de('ai_message_dispatch');
    const uso = (workspaceId: string) => ({
      id: randomUUID(),
      workspaceId,
      kind: 'ai_message_dispatch' as const,
      contactIds: [],
      entityKeys: [],
      origin: { messageId, claimToken },
      reservationIds: [],
      runMetadata: null,
    });
    await prisma.raw.$transaction(async (tx) => {
      // o mesmo despacho, mas como se o uso fosse do OUTRO workspace: nada muda
      await tratador?.marcarIncerta(tx as unknown as Db, uso(outroWs.workspaceId));
    });
    expect((await despacho(messageId))?.state).toBe('sending');
    await prisma.raw.$transaction(async (tx) => {
      await tratador?.marcarIncerta(tx as unknown as Db, uso(ws));
    });
    expect(await despacho(messageId)).toMatchObject({
      state: 'unknown_after_dispatch',
      errorCode: 'in_doubt',
      claimToken: null,
    });
  });
});

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
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import type { AuthContext } from '../../common/decorators';
import {
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
} from '../../content-use/content-use.guard';
import { OrigensDosUsos } from '../../content-use/content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../../content-use/content-use.pools';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import {
  AI_PROPOSAL_REPOSITORY,
  type AiProposalRepository,
} from '../../intelligence/ports/repositories';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../../intelligence/llm/llm.client';
import type { AiTx } from '../../intelligence/ports/ai-use-guard';
import type { Db } from '../../prisma/prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsReleasesService } from './clinics-releases.service';

/**
 * G3.1 do ADR-047 (adendo 7 §9): a GERAÇÃO DE IA sob a guarda de uso externo,
 * contra o provedor falso e a porta REAL do Clinics. Determinístico: quem
 * espera quem é conferido em `pg_blocking_pids`, e a chamada fica presa num
 * portão até o teste soltar. Dados fictícios; nenhuma chamada sai.
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
  workspaceTravaMs: 3_000,
  workspaceTransacaoMs: 15_000,
  // a IA com prazo curto: o teste da chamada que não respeita o sinal cabe
  prazoDaIaMs: 1_500,
  prazoDaMetaMs: 1_000,
  prazoDoWebhookMs: 1_000,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

const ACAO = JSON.stringify({ title: 'Retornar contato', rationale: 'Sinais.', dueInDays: 1 });

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/** O provedor falso: conta as chamadas, guarda o sinal e pode segurar a resposta. */
class LlmFalso implements LlmClient {
  readonly model = 'claude-sonnet-5';
  chamadas = 0;
  sinal: AbortSignal | null = null;
  entrou = portao();
  segura: Promise<void> | null = null;
  ignoraSinal = false;
  resposta: LlmOutcome = { kind: 'ok', text: ACAO, inputTokens: 500, outputTokens: 100 };

  reiniciar(): void {
    this.chamadas = 0;
    this.sinal = null;
    this.entrou = portao();
    this.segura = null;
    this.ignoraSinal = false;
    this.resposta = { kind: 'ok', text: ACAO, inputTokens: 500, outputTokens: 100 };
  }

  async complete(_request: LlmRequest, signal?: AbortSignal): Promise<LlmOutcome> {
    this.chamadas += 1;
    this.sinal = signal ?? null;
    this.entrou.abrir();
    if (this.segura) {
      if (this.ignoraSinal || !signal) {
        await this.segura;
      } else {
        await Promise.race([
          this.segura,
          new Promise<never>((_, rejeitar) =>
            signal.addEventListener('abort', () => rejeitar(new Error('abortado pelo prazo'))),
          ),
        ]);
      }
    }
    return this.resposta;
  }
}

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('G3.1 — a geração de IA sob a guarda de uso externo (ADR-047 adendos 6 e 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService;
  let observador: Client;
  let fixture: WorkspaceFixture;
  let ws: string;
  let auth: AuthContext;
  const llm = new LlmFalso();
  const SLUG = 'acme';

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        { provide: LLM_CLIENT, useValue: llm },
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
    llm.reiniciar();
    pidDaGuarda = null;
    gancho = (ponto, contexto) => {
      if (ponto === 'sessao') pidDaGuarda = contexto.pid;
    };
    jest.restoreAllMocks();
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    fixture = await createWorkspaceFixture(prisma, SLUG);
    ws = fixture.workspaceId;
    const userId = await createUserFixture(prisma, `dona-${randomUUID().slice(0, 8)}@acme.test`);
    const membershipId = await createMembershipFixture(prisma, ws, userId, fixture.roles.owner);
    auth = { userId, email: 'dona@acme.test', membershipId, workspaceId: ws, sessionId: 'teste' };
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

  const contato = async () =>
    (await prisma.raw.contact.create({ data: { workspaceId: ws, name: 'Contato fictício' } })).id;
  const liberar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).grant(auth, contactId, 'supplier'));
  const revogar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).revoke(auth, contactId));
  const proximaAcao = (contactId: string) =>
    noWorkspace(() => app.get(IntelligenceService).suggestNextAction(auth, contactId));
  const contador = async (metric: 'ai_runs' | 'ai_cost_cents') =>
    Number(
      (
        await prisma.raw.usageCounter.findFirst({
          where: { workspaceId: ws, metric },
          select: { value: true },
        })
      )?.value ?? 0,
    );
  const usos = () =>
    prisma.raw.contentUse.findMany({
      where: { workspaceId: ws },
      orderBy: { authorizedAt: 'asc' },
    });
  const run = (id: string | null) =>
    prisma.raw.aiRun.findFirst({ where: { id: id ?? undefined, workspaceId: ws } });

  /** Contato liberado com o Clinics ativo: a IA pode usá-lo. */
  const contatoLiberado = async () => {
    await app.get(ClinicsActivationService).enable(SLUG);
    const c = await contato();
    await liberar(c);
    return c;
  };

  it('caminho feliz: registro `ai_generation` comitado antes da chamada, com o id do run na origem; run, proposta e reservas na transação da guarda', async () => {
    const c = await contatoLiberado();
    let registroNoInicio: string | null = null;
    llm.segura = (async () => {
      await llm.entrou.aberto;
      const { rows } = await observador.query<{ status: string }>(
        `SELECT "status" FROM "ContentUse" WHERE "workspaceId" = $1`,
        [ws],
      );
      registroNoInicio = rows[0]?.status ?? null;
    })();
    const resultado = await proximaAcao(c);
    expect(resultado.status).toBe('proposed');
    expect(registroNoInicio).toBe('authorized');
    const [uso] = await usos();
    expect([uso.kind, uso.status]).toEqual(['ai_generation', 'concluded']);
    expect((uso.origin as Record<string, unknown>).runId).toBe(resultado.runId);
    expect(uso.runMetadata).toEqual({
      capability: 'next_action',
      model: 'claude-sonnet-5',
      promptVersion: expect.any(Number),
      costCeilingCents: expect.any(Number),
    });
    expect((await run(resultado.runId))?.status).toBe('ok');
    expect(await contador('ai_runs')).toBe(1);
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('USO PRIMEIRO: revogar a liberação espera a geração; o run e a proposta comitam, e a expiração os alcança depois', async () => {
    const c = await contatoLiberado();
    const solta = portao();
    llm.segura = solta.aberto;
    const geracao = proximaAcao(c);
    await llm.entrou.aberto;
    let revogou = false;
    const revogacao = revogar(c).then(() => {
      revogou = true;
    });
    try {
      await alguemEspera(pidDaGuarda);
      expect(revogou).toBe(false);
    } finally {
      solta.abrir();
    }
    const resultado = await geracao;
    expect(resultado.status).toBe('proposed');
    await revogacao;
    // a proposta comitou ANTES da revogação, e a limpeza dela a expirou
    const proposta = await prisma.raw.aiProposal.findFirst({ where: { id: resultado.proposalId } });
    expect(proposta?.status).toBe('expired');
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
  });

  it('MUDANÇA PRIMEIRO: a geração espera a revogação e, depois, recusa SEM chamar o provedor; as reservas voltam', async () => {
    const c = await contatoLiberado();
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
    const revogacao = revogar(c);
    await travou.aberto;
    const geracao = proximaAcao(c);
    try {
      await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
      await esperando(pidDaGuarda);
    } finally {
      segue.abrir();
    }
    await revogacao;
    const resultado = await geracao;
    expect(resultado.status).toBe('content_restricted');
    expect(llm.chamadas).toBe(0);
    expect(await contador('ai_runs')).toBe(0);
    expect(await contador('ai_cost_cents')).toBe(0);
  });

  it('a guarda MORRE durante a chamada: o run fica `unknown_after_dispatch` com o id pré-gerado, a proposta não nasce e as reservas são cobradas pelo teto', async () => {
    const c = await contatoLiberado();
    const solta = portao();
    llm.segura = solta.aberto;
    const geracao = proximaAcao(c);
    await llm.entrou.aberto;
    await derrubar(pidDaGuarda);
    solta.abrir();
    const resultado = await geracao;
    expect(resultado.status).toBe('unavailable');
    const [uso] = await usos();
    expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'commit']);
    const registro = await run(resultado.runId);
    expect([registro?.status, registro?.reasonCode]).toEqual([
      'unknown_after_dispatch',
      'in_doubt',
    ]);
    expect(registro?.id).toBe((uso.origin as Record<string, unknown>).runId);
    expect(await prisma.raw.aiProposal.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await contador('ai_runs')).toBe(1);
    expect(await contador('ai_cost_cents')).toBeGreaterThan(0); // o teto reservado
    // o run em dúvida registra o teto cobrado: o histórico fecha com o contador
    expect(registro?.costCents).toBe(await contador('ai_cost_cents'));
    expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('o PRAZO aborta a chamada pelo sinal: desfecho incerto, run de erro com custo incerto e reservas pelo teto', async () => {
    const c = await contatoLiberado();
    llm.segura = new Promise<void>(() => undefined); // nunca responde sozinha
    const resultado = await proximaAcao(c);
    expect(llm.sinal?.aborted).toBe(true);
    expect(resultado.status).toBe('unavailable');
    const registro = await run(resultado.runId);
    expect([registro?.status, registro?.reasonCode]).toEqual(['error', 'provider_unknown_cost']);
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await contador('ai_runs')).toBe(1);
    // o custo incerto é o teto, no run e no contador
    expect(registro?.costCents).toBeGreaterThan(0);
    expect(registro?.costCents).toBe(await contador('ai_cost_cents'));
  });

  it('a chamada que IGNORA o sinal e passa do prazo: o próprio processo marca `overran_deadline`, e o run fica em dúvida', async () => {
    const c = await contatoLiberado();
    const solta = portao();
    llm.segura = solta.aberto;
    llm.ignoraSinal = true;
    try {
      const resultado = await proximaAcao(c);
      expect(resultado.status).toBe('unavailable');
      const [uso] = await usos();
      expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
      expect((await run(resultado.runId))?.status).toBe('unknown_after_dispatch');
    } finally {
      solta.abrir();
    }
  });

  it('o REGISTRO falha: nada sai, as reservas voltam, e nenhum run `not_started` é gravado (o detector decide se o registro comitou)', async () => {
    const c = await contatoLiberado();
    gancho = (ponto, contexto) => {
      if (ponto === 'sessao') pidDaGuarda = contexto.pid;
      if (ponto === 'registro_aberto') throw new Error('registro falhou antes do commit');
    };
    const resultado = await proximaAcao(c);
    expect([resultado.status, resultado.runId]).toEqual(['unavailable', null]);
    expect(llm.chamadas).toBe(0);
    expect(await prisma.raw.aiRun.count({ where: { workspaceId: ws } })).toBe(0);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await contador('ai_runs')).toBe(0);
  });

  it('sem provedor configurado: nenhuma chamada saiu, o run é erro `provider_unavailable` e as reservas acertam por zero', async () => {
    const c = await contatoLiberado();
    llm.resposta = { kind: 'no_provider' };
    const resultado = await proximaAcao(c);
    expect(resultado.status).toBe('unavailable');
    expect((await run(resultado.runId))?.reasonCode).toBe('provider_unavailable');
    expect(await contador('ai_runs')).toBe(0);
    expect(await contador('ai_cost_cents')).toBe(0);
  });

  it('a PERSISTÊNCIA falha: volta ao SAVEPOINT, o run fica `unknown_after_dispatch`, a proposta não nasce e as reservas vão pelo teto', async () => {
    const c = await contatoLiberado();
    const propostas = app.get<AiProposalRepository>(AI_PROPOSAL_REPOSITORY);
    jest.spyOn(propostas, 'createWithin').mockRejectedValue(new Error('falha simulada'));
    const resultado = await proximaAcao(c);
    expect(resultado.status).toBe('unavailable');
    expect((await run(resultado.runId))?.status).toBe('unknown_after_dispatch');
    expect(await prisma.raw.aiProposal.count({ where: { workspaceId: ws } })).toBe(0);
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await contador('ai_runs')).toBe(1);
  });

  it('rascunho CONCORRENTE na transação da guarda: a inserção espera o outro, vê o conflito e responde `concurrent` SEM abortar a transação', async () => {
    const canal = await prisma.raw.channel.create({
      data: { workspaceId: ws, type: 'internal', name: 'Interno fictício' },
    });
    const conversa = await prisma.raw.conversation.create({
      data: { workspaceId: ws, channelId: canal.id },
    });
    const novoRun = async () =>
      (
        await prisma.raw.aiRun.create({
          data: {
            workspaceId: ws,
            capability: 'reply_suggestion',
            model: 'claude-sonnet-5',
            contextSummary: 'fictício',
            status: 'ok',
          },
        })
      ).id;
    const runDoOutro = await novoRun();
    const runDesta = await novoRun();
    const outra = new Client({ connectionString: TEST_DATABASE_URL });
    await outra.connect();
    try {
      // o rascunho da OUTRA geração, ainda sem commit: esta não o vê ao ler
      await outra.query('BEGIN');
      await outra.query(
        `INSERT INTO "AiProposal" ("id","workspaceId","runId","type","payload","rationale",
           "conversationId","expiresAt","pendingReplyMark")
         VALUES ($1, $2, $3, 'send_message', '{"body":"x"}', 'r', $4, now() + interval '1 hour', true)`,
        [randomUUID(), ws, runDoOutro, conversa.id],
      );
      const {
        rows: [{ pid }],
      } = await outra.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const repositorio = app.get<AiProposalRepository>(AI_PROPOSAL_REPOSITORY);
      const desta = noWorkspace(() =>
        (
          prisma.db as unknown as { $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> }
        ).$transaction(async (tx) => {
          const criada = await repositorio.createReplySupersedingWithin(
            tx as unknown as AiTx,
            { workspaceId: ws, membershipId: auth.membershipId as string },
            {
              runId: runDesta,
              payload: { body: 'y' },
              rationale: 'r',
              conversationId: conversa.id,
              expiresAt: new Date(Date.now() + 60 * 60_000),
            },
          );
          // a transação continua viva depois do conflito
          const vivas = await tx.aiProposal.count({ where: { conversationId: conversa.id } });
          return { criada, vivas };
        }),
      );
      await alguemEspera(pid); // a inserção espera a outra pelo índice único
      await outra.query('COMMIT');
      expect(await desta).toEqual({ criada: 'concurrent', vivas: 1 });
    } finally {
      await outra.query('ROLLBACK').catch(() => undefined);
      await outra.end();
    }
  });

  it('o tratador de origem da IA numa transação `raw`, com linhas de OUTRO workspace: só escreve no workspace do uso, e nunca liga nem altera o que é do outro', async () => {
    const outro = await createWorkspaceFixture(prisma, 'outro');
    const contatoDoOutro = (
      await prisma.raw.contact.create({
        data: { workspaceId: outro.workspaceId, name: 'Do outro' },
      })
    ).id;
    const runDoOutro = (
      await prisma.raw.aiRun.create({
        data: {
          workspaceId: outro.workspaceId,
          capability: 'next_action',
          model: 'claude-sonnet-5',
          contextSummary: 'do outro workspace',
          status: 'ok',
        },
      })
    ).id;
    const tratador = app.get(OrigensDosUsos).de('ai_generation');
    const novo = randomUUID();
    const uso = (runId: string) => ({
      id: randomUUID(),
      workspaceId: ws,
      kind: 'ai_generation' as const,
      contactIds: [],
      entityKeys: [],
      origin: { runId, contactId: contatoDoOutro, conversationId: null, promptVersionId: null },
      reservationIds: [],
      runMetadata: { capability: 'next_action', model: 'claude-sonnet-5', promptVersion: 1 },
    });
    await prisma.raw.$transaction(async (tx) => {
      // um run novo, com o contato do OUTRO workspace na origem: o contato não existe aqui
      await tratador?.marcarIncerta(tx as unknown as Db, uso(novo));
      // o id de um run do OUTRO workspace: não cria nem altera nada
      await tratador?.marcarIncerta(tx as unknown as Db, uso(runDoOutro));
    });
    const criado = await prisma.raw.aiRun.findFirst({ where: { id: novo } });
    expect([criado?.workspaceId, criado?.contactId, criado?.status]).toEqual([
      ws,
      null,
      'unknown_after_dispatch',
    ]);
    const intacto = await prisma.raw.aiRun.findFirst({ where: { id: runDoOutro } });
    expect([intacto?.workspaceId, intacto?.status]).toEqual([outro.workspaceId, 'ok']);
    expect(await prisma.raw.aiRun.count({ where: { workspaceId: outro.workspaceId } })).toBe(1);
  });
});

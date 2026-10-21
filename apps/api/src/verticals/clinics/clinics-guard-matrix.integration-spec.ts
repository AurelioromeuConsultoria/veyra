import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { WhatsappSendService } from '../../channels/whatsapp-send.service';
import {
  META_TRANSPORT,
  type FetchOutcome,
  type MetaTransport,
  type SendOutcome,
} from '../../channels/meta.transport';
import type { AuthContext } from '../../common/decorators';
import { CryptoService } from '../../common/crypto.service';
import { ContactsService } from '../../contacts/contacts.service';
import {
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
} from '../../content-use/content-use.guard';
import { ReconciliacaoDosUsos } from '../../content-use/content-use.reconciler';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../../content-use/content-use.pools';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import { DealsService } from '../../deals/deals.service';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmOutcome,
  type LlmRequest,
} from '../../intelligence/llm/llm.client';
import {
  AI_PROPOSAL_REPOSITORY,
  type AiProposalRepository,
} from '../../intelligence/ports/repositories';
import { JobsService } from '../../jobs/jobs.service';
import { OutboxService } from '../../outbox/outbox.service';
import type { Db } from '../../prisma/prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TasksService } from '../../tasks/tasks.service';
import { UsageService } from '../../usage/usage.service';
import type { SafeFetchResult } from '../../webhooks/safe-http';
import { WEBHOOK_TRANSPORT, WebhooksService } from '../../webhooks/webhooks.service';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsPatientsService } from './clinics-patients.service';
import { ClinicsReleasesService } from './clinics-releases.service';

/**
 * G4 do ADR-047 (adendo 7 §10): a validação do CONJUNTO, com os três
 * consumidores REAIS no mesmo app — a geração de IA (G3.1), o envio da
 * mensagem de origem da IA (G3.2) e a entrega de webhook (G3.3) — contra as
 * mudanças da G2, os detectores com os tratadores reais, o isolamento entre
 * workspaces e a transição dos despachos antigos. Provedor, Meta e destino
 * falsos seguram a chamada num portão; a porta é a REAL do Clinics. Quem
 * espera quem é conferido em `pg_blocking_pids`, nunca por sono. Dados
 * fictícios; nada sai para a rede.
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
  mudancaTravaMs: 5_000,
  mudancaTransacaoMs: 15_000,
  workspaceTravaMs: 5_000,
  workspaceTransacaoMs: 15_000,
  // as chamadas presas no portão cabem nos prazos
  prazoDaIaMs: 3_000,
  prazoDaMetaMs: 3_000,
  prazoDoWebhookMs: 3_000,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

const ACAO = JSON.stringify({ title: 'Retornar contato', rationale: 'Sinais.', dueInDays: 1 });
const EVENTOS = ['contact.updated', 'deal.created', 'task.created'];

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/** Uma chamada externa falsa: conta, abre o portão de entrada e pode segurar a resposta. */
class Chamada {
  vezes = 0;
  entrou = portao();
  segura: Promise<void> | null = null;

  reiniciar(): void {
    this.vezes = 0;
    this.entrou = portao();
    this.segura = null;
  }

  async passar(): Promise<void> {
    this.vezes += 1;
    this.entrou.abrir();
    if (this.segura) await this.segura;
  }
}

class LlmFalso implements LlmClient {
  readonly model = 'claude-sonnet-5';
  readonly chamada = new Chamada();
  async complete(_request: LlmRequest): Promise<LlmOutcome> {
    await this.chamada.passar();
    return { kind: 'ok', text: ACAO, inputTokens: 500, outputTokens: 100 };
  }
}

class MetaFalsa implements MetaTransport {
  readonly chamada = new Chamada();
  // um wamid por envio, como a Meta: o despacho tem unicidade por `externalId`
  async sendText(): Promise<SendOutcome> {
    await this.chamada.passar();
    return { ok: true, externalId: `wamid.FICTICIO-${randomUUID()}` };
  }
  async sendTemplate(): Promise<SendOutcome> {
    await this.chamada.passar();
    return { ok: true, externalId: `wamid.FICTICIO-${randomUUID()}` };
  }
  async fetchMedia(): Promise<FetchOutcome> {
    return { ok: false, failure: { status: 400 } };
  }
}

class DestinoFalso {
  readonly chamada = new Chamada();
  async post(): Promise<SafeFetchResult> {
    await this.chamada.passar();
    return { status: 200, durationMs: 1 };
  }
}

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('G4 — a validação do conjunto: matriz uso × mudança, recuperação, isolamento e transição (ADR-047 adendo 7 §10)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService;
  let observador: Client;
  let fixture: WorkspaceFixture;
  let ws: string;
  let auth: AuthContext;
  let conversationId: string;
  let contatoDaConversa: string;
  const llm = new LlmFalso();
  const meta = new MetaFalsa();
  const destino = new DestinoFalso();
  const SLUG = 'acme';

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        { provide: LLM_CLIENT, useValue: llm },
        { provide: META_TRANSPORT, useValue: meta },
        { provide: WEBHOOK_TRANSPORT, useValue: () => destino.post() },
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
    llm.chamada.reiniciar();
    meta.chamada.reiniciar();
    destino.chamada.reiniciar();
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
    // o canal e a conversa do envio da IA, com a janela de 24 h aberta
    contatoDaConversa = await contato();
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
    conversationId = (
      await prisma.raw.conversation.create({
        data: {
          workspaceId: ws,
          channelId: canal.id,
          contactId: contatoDaConversa,
          externalAddress: '+5511900000001',
          lastInboundAt: new Date(),
        },
      })
    ).id;
  });

  // ── utilidades ────────────────────────────────────────────────────────────

  const noWorkspace = <T>(fn: () => Promise<T>, workspaceId = ws): Promise<T> =>
    cls.run(() => {
      cls.set('workspaceId', workspaceId);
      return fn();
    });
  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 500; i++) {
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
  const capturar = <T>(promessa: Promise<T>) => {
    const estado = { terminou: false, erro: null as unknown };
    const p = promessa.then(
      (valor) => {
        estado.terminou = true;
        return valor;
      },
      (erro: unknown) => {
        estado.terminou = true;
        estado.erro = erro;
        return undefined;
      },
    );
    return { p, estado };
  };
  /** Pausa a PRIMEIRA chamada da primitiva logo depois das travas: a mudança fica aberta, segurando-as. */
  function pausarDepoisDasTravas(metodo: 'porContato' | 'doWorkspaceInteiro') {
    const restricao = app.get(MudancasDeRestricao);
    const travou = portao();
    const segue = portao();
    const real = (restricao[metodo] as (...args: unknown[]) => Promise<unknown>).bind(restricao);
    let primeira = true;
    jest.spyOn(restricao, metodo).mockImplementation((async (...args: unknown[]) => {
      const resultado = await real(...args);
      if (primeira) {
        primeira = false;
        travou.abrir();
        await segue.aberto;
      }
      return resultado;
    }) as never);
    return { travou, segue };
  }

  // ── dados fictícios ───────────────────────────────────────────────────────

  async function contato(workspaceId?: string) {
    return (
      await prisma.raw.contact.create({
        data: { workspaceId: workspaceId ?? ws, name: 'Contato fictício' },
      })
    ).id;
  }
  const ativar = () => app.get(ClinicsActivationService).enable(SLUG);
  const desativar = () => app.get(ClinicsActivationService).disable(SLUG);
  const liberar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).grant(auth, contactId, 'supplier'));
  const revogar = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsReleasesService).revoke(auth, contactId));
  const tornarPaciente = (contactId: string) =>
    noWorkspace(() => app.get(ClinicsPatientsService).create(auth, contactId));
  const excluirContato = (contactId: string) =>
    noWorkspace(() => app.get(ContactsService).remove(auth, contactId));
  const trocarContatoDoDeal = (dealId: string, contactId: string | null) =>
    noWorkspace(() => app.get(DealsService).update(auth, dealId, { contactId }));
  const trocarTarefa = (taskId: string, input: { contactId?: string | null; dealId?: string }) =>
    noWorkspace(() => app.get(TasksService).update(auth, taskId, input));
  const deal = async (contactId: string | null) =>
    (
      await prisma.raw.deal.create({
        data: {
          workspaceId: ws,
          title: 'Oportunidade fictícia',
          pipelineId: fixture.pipelineId,
          stageId: Object.values(fixture.stages)[0],
          position: 0,
          contactId,
        },
      })
    ).id;
  const tarefa = async (dealId: string | null) =>
    (
      await prisma.raw.task.create({
        data: { workspaceId: ws, title: 'Tarefa fictícia', contactId: null, dealId },
      })
    ).id;
  const webhook = async () =>
    (
      await prisma.raw.webhook.create({
        data: {
          workspaceId: ws,
          url: 'https://destino.veyra.test/hook',
          events: EVENTOS,
          secretCipher: app.get(CryptoService).encrypt('segredo-ficticio'),
        },
      })
    ).id;
  const evento = (eventType: string, entityId: string) =>
    prisma.raw.outboxEvent.create({
      data: {
        workspaceId: ws,
        eventType,
        payload: { id: entityId },
        dedupeKey: `${eventType}:${entityId}:${randomUUID()}`,
      },
    });
  const usos = (workspaceId = ws) =>
    prisma.raw.contentUse.findMany({ where: { workspaceId }, orderBy: { authorizedAt: 'asc' } });
  const contador = async (metric: string) =>
    Number(
      (
        await prisma.raw.usageCounter.findFirst({
          where: { workspaceId: ws, metric: metric as never },
          select: { value: true },
        })
      )?.value ?? 0,
    );
  const despacho = (messageId: string) =>
    prisma.raw.messageDispatch.findFirst({ where: { messageId } });

  /** A mensagem da IA aprovada, escrita como `executeSendMessage` a escreve. */
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
  const drenar = async () => {
    for (let i = 0; i < 5; i++) {
      const { delivered } = await app.get(JobsService).dispatchPending();
      if (delivered === 0) break;
    }
  };
  const entregarWebhooks = async () => {
    const outbox = app.get(OutboxService);
    const entregador = app.get(WebhooksService);
    for (const claimed of await outbox.claimBatch(100)) await entregador.deliver(claimed);
  };

  // ── os consumidores reais ─────────────────────────────────────────────────

  /**
   * Um consumidor real: prepara o cenário (com o Clinics ativo quando o par
   * pede), inicia o uso com a chamada presa no portão e confere o desfecho.
   */
  type Consumidor = {
    chamada: Chamada;
    iniciar: (alvo: Alvo) => Promise<unknown>;
    /** `resultado`: o que o uso devolveu a quem pediu (a geração devolve o desfecho) */
    concluiu: (alvo: Alvo, resultado: unknown) => Promise<void>;
    recusou: (alvo: Alvo, resultado: unknown) => Promise<void>;
  };
  type Alvo = { contato: string; messageId?: string; eventoId?: string };

  const IA: Consumidor = {
    chamada: llm.chamada,
    iniciar: (alvo) =>
      noWorkspace(() => app.get(IntelligenceService).suggestNextAction(auth, alvo.contato)),
    concluiu: async (_alvo, resultado) => {
      expect(llm.chamada.vezes).toBe(1);
      // o run comitou com a proposta ANTES da mudança (excluir o contato o
      // apaga depois, em cascata): o desfecho é o que a geração devolveu
      expect((resultado as { status: string }).status).toBe('proposed');
      const lista = await usos();
      expect(lista.map((u) => [u.kind, u.status])).toEqual([['ai_generation', 'concluded']]);
    },
    recusou: async (alvo, resultado) => {
      expect(llm.chamada.vezes).toBe(0);
      expect(await contador('ai_runs')).toBe(0);
      // a pessoa recebe a recusa (nunca um 409), e a recusa fica registrada —
      // sem a referência ao contato, se ele foi excluído
      expect((resultado as { status: string }).status).toBe('content_restricted');
      const runs = await prisma.raw.aiRun.findMany({ where: { workspaceId: ws } });
      expect(runs.map((r) => [r.status, r.reasonCode])).toEqual([
        ['refused', 'content_restricted'],
      ]);
      const existe = await prisma.raw.contact.count({ where: { id: alvo.contato } });
      expect(runs[0].contactId).toBe(existe > 0 ? alvo.contato : null);
    },
  };

  const ENVIO: Consumidor = {
    chamada: meta.chamada,
    iniciar: () => drenar(),
    concluiu: async (alvo) => {
      expect(meta.chamada.vezes).toBe(1);
      expect((await despacho(alvo.messageId as string))?.state).toBe('sent');
      expect((await usos()).map((u) => [u.kind, u.status])).toEqual([
        ['ai_message_dispatch', 'concluded'],
      ]);
    },
    recusou: async (alvo) => {
      expect(meta.chamada.vezes).toBe(0);
      expect(await despacho(alvo.messageId as string)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });
      expect(await contador('messages_sent')).toBe(0);
    },
  };

  /** Prepara o alvo de um consumidor de IA: o contato liberado (e, no envio, a mensagem aprovada). */
  const alvoDaIa = async (consumidor: Consumidor): Promise<Alvo> => {
    await ativar();
    if (consumidor === ENVIO) {
      await liberar(contatoDaConversa);
      const { messageId } = await mensagemDaIa([contatoDaConversa]);
      return { contato: contatoDaConversa, messageId };
    }
    const c = await contato();
    await liberar(c);
    return { contato: c };
  };

  // ── 1. matriz: IA (geração e envio) × mudanças ────────────────────────────

  type MudancaDaIa = [
    nome: string,
    metodo: 'porContato' | 'doWorkspaceInteiro',
    mudar: (alvo: Alvo) => Promise<unknown>,
    consumidores: Consumidor[],
  ];
  const MUDANCAS_DA_IA: MudancaDaIa[] = [
    ['revogar a liberação', 'porContato', (a) => revogar(a.contato), [IA, ENVIO]],
    ['tornar paciente', 'porContato', (a) => tornarPaciente(a.contato), [IA, ENVIO]],
    // o envio pressupõe conversa: excluir o contato a apaga em cascata
    ['excluir o contato', 'porContato', (a) => excluirContato(a.contato), [IA]],
    [
      'desativar o Clinics (o workspace inteiro)',
      'doWorkspaceInteiro',
      () => desativar(),
      [IA, ENVIO],
    ],
  ];
  const CASOS_DA_IA = MUDANCAS_DA_IA.flatMap(([nome, metodo, mudar, consumidores]) =>
    consumidores.map(
      (consumidor) =>
        [
          `${consumidor === IA ? 'geração de IA' : 'envio da IA'} × ${nome}`,
          consumidor,
          metodo,
          mudar,
        ] as const,
    ),
  );

  describe('1. matriz uso × mudança — USO PRIMEIRO: a mudança espera; o uso conclui; a mudança comita depois', () => {
    it.each(CASOS_DA_IA)('%s', async (_nome, consumidor, _metodo, mudar) => {
      const alvo = await alvoDaIa(consumidor);
      const solta = portao();
      consumidor.chamada.segura = solta.aberto;
      const uso = capturar(consumidor.iniciar(alvo));
      let mudanca: ReturnType<typeof capturar> | undefined;
      try {
        await consumidor.chamada.entrou.aberto;
        mudanca = capturar(mudar(alvo));
        await alguemEspera(pidDaGuarda);
        expect(mudanca.estado.terminou).toBe(false);
      } finally {
        solta.abrir();
      }
      const resultado = await uso.p;
      await mudanca?.p;
      expect(uso.estado.erro).toBeNull();
      expect(mudanca?.estado.erro).toBeNull();
      await consumidor.concluiu(alvo, resultado);
    });
  });

  describe('1. matriz uso × mudança — MUDANÇA PRIMEIRO: o uso espera e, depois do commit, recusa sem chamar', () => {
    it.each(CASOS_DA_IA)('%s', async (_nome, consumidor, metodo, mudar) => {
      const alvo = await alvoDaIa(consumidor);
      const pausa = pausarDepoisDasTravas(metodo);
      const mudanca = capturar(mudar(alvo));
      await pausa.travou.aberto;
      const uso = capturar(consumidor.iniciar(alvo));
      try {
        await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
        await esperando(pidDaGuarda);
      } finally {
        pausa.segue.abrir();
      }
      await mudanca.p;
      const resultado = await uso.p;
      expect(mudanca.estado.erro).toBeNull();
      expect(uso.estado.erro).toBeNull();
      await consumidor.recusou(alvo, resultado);
    });
  });

  describe('1. matriz uso × mudança — ENVIO × EXCLUIR O CONTATO da conversa (a cascata apaga conversa, mensagem e despacho)', () => {
    it('USO PRIMEIRO: a exclusão espera o envio em andamento, que sai; depois a cascata apaga o despacho', async () => {
      const alvo = await alvoDaIa(ENVIO);
      const solta = portao();
      meta.chamada.segura = solta.aberto;
      const envio = capturar(drenar());
      let mudanca: ReturnType<typeof capturar> | undefined;
      try {
        await meta.chamada.entrou.aberto;
        mudanca = capturar(excluirContato(alvo.contato));
        await alguemEspera(pidDaGuarda);
        expect(mudanca.estado.terminou).toBe(false);
      } finally {
        solta.abrir();
      }
      await envio.p;
      await mudanca?.p;
      expect(envio.estado.erro).toBeNull();
      expect(mudanca?.estado.erro).toBeNull();
      expect(meta.chamada.vezes).toBe(1);
      expect(await despacho(alvo.messageId as string)).toBeNull();
    });

    it('MUDANÇA PRIMEIRO: o worker já reivindicou o despacho (corpo e endereço em memória); a guarda espera a exclusão e, com o contato apagado, a porta o recusa — nada sai', async () => {
      const alvo = await alvoDaIa(ENVIO);
      const pausa = pausarDepoisDasTravas('porContato');
      const mudanca = capturar(excluirContato(alvo.contato));
      await pausa.travou.aberto;
      const envio = capturar(drenar());
      try {
        await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
        await esperando(pidDaGuarda);
      } finally {
        pausa.segue.abrir();
      }
      await mudanca.p;
      await envio.p;
      expect(mudanca.estado.erro).toBeNull();
      expect(envio.estado.erro).toBeNull();
      expect(meta.chamada.vezes).toBe(0);
      expect(await despacho(alvo.messageId as string)).toBeNull();
      expect(await usos()).toEqual([]);
    });
  });

  // ── 1. matriz: webhook × mudanças ─────────────────────────────────────────

  type CasoDoWebhook = [
    nome: string,
    metodo: 'porContato' | 'doWorkspaceInteiro',
    preparar: () => Promise<{ eventoId: string; mudar: () => Promise<unknown> }>,
    /** o que a mudança primeiro deixa: o evento suprimido (`delivered`) ou devolvido (`pending`) */
    depoisDaMudanca: 'delivered' | 'pending',
  ];
  const CASOS_DO_WEBHOOK: CasoDoWebhook[] = [
    [
      'webhook de deal sem contato × trocar o contato do deal',
      'porContato',
      async () => {
        await ativar();
        const d = await deal(null);
        const c = await contato();
        const ev = await evento('deal.created', d);
        return { eventoId: ev.id, mudar: () => trocarContatoDoDeal(d, c) };
      },
      'pending',
    ],
    [
      'webhook de tarefa sem contato × trocar o contato da tarefa',
      'porContato',
      async () => {
        await ativar();
        const t = await tarefa(null);
        const c = await contato();
        const ev = await evento('task.created', t);
        return { eventoId: ev.id, mudar: () => trocarTarefa(t, { contactId: c }) };
      },
      'pending',
    ],
    [
      'webhook de tarefa × trocar o deal da tarefa (o deal novo tem contato)',
      'porContato',
      async () => {
        await ativar();
        const d1 = await deal(null);
        const d2 = await deal(await contato());
        const t = await tarefa(d1);
        const ev = await evento('task.created', t);
        return { eventoId: ev.id, mudar: () => trocarTarefa(t, { dealId: d2 }) };
      },
      'pending',
    ],
    [
      'webhook de contato sem o Clinics × ativar o Clinics (o workspace inteiro)',
      'doWorkspaceInteiro',
      async () => {
        const c = await contato();
        const ev = await evento('contact.updated', c);
        return { eventoId: ev.id, mudar: () => ativar() };
      },
      'delivered',
    ],
  ];

  describe('1. matriz uso × mudança — WEBHOOK, USO PRIMEIRO', () => {
    it.each(CASOS_DO_WEBHOOK)('%s', async (_nome, _metodo, preparar) => {
      await webhook();
      const { eventoId, mudar } = await preparar();
      const solta = portao();
      destino.chamada.segura = solta.aberto;
      const entrega = capturar(entregarWebhooks());
      let mudanca: ReturnType<typeof capturar> | undefined;
      try {
        await destino.chamada.entrou.aberto;
        mudanca = capturar(mudar());
        await alguemEspera(pidDaGuarda);
        expect(mudanca.estado.terminou).toBe(false);
      } finally {
        solta.abrir();
      }
      await entrega.p;
      await mudanca?.p;
      expect(entrega.estado.erro).toBeNull();
      expect(mudanca?.estado.erro).toBeNull();
      expect(destino.chamada.vezes).toBe(1);
      expect((await prisma.raw.outboxEvent.findFirst({ where: { id: eventoId } }))?.status).toBe(
        'delivered',
      );
      expect((await usos()).map((u) => [u.kind, u.status])).toEqual([
        ['webhook_delivery', 'concluded'],
      ]);
    });
  });

  describe('1. matriz uso × mudança — WEBHOOK, MUDANÇA PRIMEIRO: nada sai', () => {
    it.each(CASOS_DO_WEBHOOK)('%s', async (_nome, metodo, preparar, depois) => {
      await webhook();
      const { eventoId, mudar } = await preparar();
      const pausa = pausarDepoisDasTravas(metodo);
      const mudanca = capturar(mudar());
      await pausa.travou.aberto;
      const entrega = capturar(entregarWebhooks());
      try {
        await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
        await esperando(pidDaGuarda);
      } finally {
        pausa.segue.abrir();
      }
      await mudanca.p;
      await entrega.p;
      expect(mudanca.estado.erro).toBeNull();
      expect(destino.chamada.vezes).toBe(0);
      expect(await prisma.raw.webhookDelivery.count()).toBe(0);
      expect((await prisma.raw.outboxEvent.findFirst({ where: { id: eventoId } }))?.status).toBe(
        depois,
      );
    });
  });

  // ── 2. recuperação de falhas com os tratadores reais ──────────────────────

  type Orfao = { usoId: string; conferir: (detector: string) => Promise<void> };

  /** Um uso `authorized` órfão, com o registro de origem como o processo morto o deixou. */
  const ORFAOS: [string, (prazo: 'vencido' | 'vivo') => Promise<Orfao>][] = [
    [
      'geração de IA',
      async (prazo) => {
        const c = await contato();
        await liberar(c);
        const usage = app.get(UsageService);
        const teto = 7;
        const reservas = await noWorkspace(async () => {
          await usage.ensureCounterRow(ws, 'ai_runs');
          await usage.ensureCounterRow(ws, 'ai_cost_cents');
          const r1 = await usage.reserve(ws, 'ai_runs', 1);
          const r2 = await usage.reserve(ws, 'ai_cost_cents', teto);
          return [r1, r2].map((r) => (r as { reservationId: string }).reservationId);
        });
        const runId = randomUUID();
        const usoId = await inserirOrfao(prazo, {
          kind: 'ai_generation',
          contactIds: [c],
          entityKeys: [],
          origin: { runId, contactId: c },
          runMetadata: {
            capability: 'next_action',
            model: 'claude-sonnet-5',
            promptVersion: 1,
            costCeilingCents: teto,
          },
          reservationIds: reservas,
        });
        return {
          usoId,
          conferir: async () => {
            const run = await prisma.raw.aiRun.findFirst({ where: { id: runId } });
            expect([run?.status, run?.workspaceId, run?.costCents]).toEqual([
              'unknown_after_dispatch',
              ws,
              teto,
            ]);
            expect(await contador('ai_runs')).toBe(1);
            expect(await contador('ai_cost_cents')).toBe(teto);
          },
        };
      },
    ],
    [
      'envio da IA',
      async (prazo) => {
        await liberar(contatoDaConversa);
        const { messageId } = await mensagemDaIa([contatoDaConversa]);
        const reserva = (await despacho(messageId))?.reservationId as string;
        const claimToken = randomUUID();
        // em voo, com marcador e posse ainda viva: nenhuma varredura o toca
        await prisma.raw.$executeRaw`
          UPDATE "MessageDispatch"
             SET "state" = 'sending', "claimToken" = ${claimToken}::uuid,
                 "dispatchedAt" = now(), "leaseExpiresAt" = now() + interval '1 hour'
           WHERE "messageId" = ${messageId}::uuid`;
        const usoId = await inserirOrfao(prazo, {
          kind: 'ai_message_dispatch',
          contactIds: [contatoDaConversa],
          entityKeys: [],
          origin: { messageId, claimToken },
          runMetadata: null,
          reservationIds: [reserva],
        });
        return {
          usoId,
          conferir: async () => {
            expect(await despacho(messageId)).toMatchObject({
              state: 'unknown_after_dispatch',
              errorCode: 'in_doubt',
              reservationId: null,
            });
            expect(await contador('messages_sent')).toBe(1);
            expect(meta.chamada.vezes).toBe(0);
          },
        };
      },
    ],
    [
      'entrega de webhook',
      async (prazo) => {
        const webhookId = await webhook();
        const d = await deal(null);
        const ev = await evento('deal.created', d);
        const deliveryId = randomUUID();
        const usoId = await inserirOrfao(prazo, {
          kind: 'webhook_delivery',
          contactIds: [],
          entityKeys: [`deal:${d}`],
          origin: { deliveryId, webhookId, outboxEventId: ev.id },
          runMetadata: { attempt: 1 },
          reservationIds: [],
        });
        return {
          usoId,
          conferir: async () => {
            const entrega = await prisma.raw.webhookDelivery.findFirst({
              where: { id: deliveryId },
            });
            expect([entrega?.workspaceId, entrega?.error, entrega?.attempt]).toEqual([
              ws,
              'in_doubt',
              1,
            ]);
          },
        };
      },
    ],
  ];

  async function inserirOrfao(
    prazo: 'vencido' | 'vivo',
    uso: {
      kind: string;
      contactIds: string[];
      entityKeys: string[];
      origin: Record<string, string>;
      runMetadata: Record<string, string | number> | null;
      reservationIds: string[];
    },
  ): Promise<string> {
    const id = randomUUID();
    await observador.query(
      `INSERT INTO "ContentUse" ("id","workspaceId","kind","status","contactIds","entityKeys",
         "origin","reservationIds","runMetadata","instanceId","deadlineAt")
       VALUES ($1, $2, $3::"ContentUseKind", 'authorized', $4::uuid[], $5::text[], $6::jsonb,
         $7::uuid[], $8::jsonb, 'processo-morto',
         now() + ($9::int * interval '1 minute'))`,
      [
        id,
        ws,
        uso.kind,
        uso.contactIds,
        uso.entityKeys,
        JSON.stringify(uso.origin),
        uso.reservationIds,
        uso.runMetadata === null ? null : JSON.stringify(uso.runMetadata),
        prazo === 'vencido' ? -1 : 60,
      ],
    );
    return id;
  }

  /** Os detectores: quem tem PROVA de que a guarda do uso acabou. */
  const DETECTORES: [string, string, (tipo: string) => Promise<unknown>, 'vencido' | 'vivo'][] = [
    [
      'a mudança que segura as travas',
      'change',
      async (tipo) => {
        // o contato do registro (IA) ou o deal da entrega (webhook)
        const uso = (await usos()).find((u) => u.status === 'authorized');
        if (tipo === 'entrega de webhook') {
          const d = (uso?.entityKeys[0] as string).slice('deal:'.length);
          return trocarContatoDoDeal(d, await contato());
        }
        return revogar(uso?.contactIds[0] as string);
      },
      'vivo',
    ],
    [
      'a reconciliação (prazo vencido, sem guarda viva)',
      'reconciliation',
      () => app.get(ReconciliacaoDosUsos).varrer(),
      'vencido',
    ],
    ['a desativação (o workspace inteiro)', 'workspace_change', () => desativar(), 'vivo'],
  ];
  const CASOS_DE_RECUPERACAO = ORFAOS.flatMap(([tipo, criar]) =>
    DETECTORES.map(
      ([nome, detector, detectar, prazo]) =>
        [`${tipo} × ${nome}`, tipo, criar, detector, detectar, prazo] as const,
    ),
  );

  describe('2. recuperação de falhas: o órfão de cada tipo, marcado por cada detector, com o tratador real', () => {
    it.each(CASOS_DE_RECUPERACAO)('%s', async (_nome, tipo, criar, detector, detectar, prazo) => {
      await ativar();
      const orfao = await criar(prazo);
      await detectar(tipo);
      const uso = await prisma.raw.contentUse.findFirst({ where: { id: orfao.usoId } });
      expect([uso?.status, uso?.detectedBy]).toEqual(['in_doubt', detector]);
      await orfao.conferir(detector);
      // as reservas do uso foram cobradas pelo teto, uma vez: nenhuma sobra
      expect(await prisma.raw.usageReservation.count({ where: { workspaceId: ws } })).toBe(0);
      expect(
        await prisma.raw.auditLog.count({
          where: { workspaceId: ws, action: 'content_use.in_doubt', entityId: orfao.usoId },
        }),
      ).toBe(1);
    });
  });

  // ── 3. isolamento ─────────────────────────────────────────────────────────

  describe('3. isolamento entre workspaces', () => {
    it('a geração de IA presa no workspace B não segura a revogação no A', async () => {
      await ativar();
      const cA = await contato();
      await liberar(cA);
      const outro = await createWorkspaceFixture(prisma, 'outro');
      const userB = await createUserFixture(prisma, `b-${randomUUID().slice(0, 8)}@outro.test`);
      const membershipB = await createMembershipFixture(
        prisma,
        outro.workspaceId,
        userB,
        outro.roles.owner,
      );
      const authB: AuthContext = {
        userId: userB,
        email: 'b@outro.test',
        membershipId: membershipB,
        workspaceId: outro.workspaceId,
        sessionId: 'teste-b',
      };
      const cB = await contato(outro.workspaceId);
      const solta = portao();
      llm.chamada.segura = solta.aberto;
      const geracaoB = capturar(
        noWorkspace(
          () => app.get(IntelligenceService).suggestNextAction(authB, cB),
          outro.workspaceId,
        ),
      );
      try {
        await llm.chamada.entrou.aberto; // a guarda do B segura as travas do B
        await revogar(cA); // a do A não espera
        expect(
          await prisma.raw.clinicsContactRelease.count({
            where: { workspaceId: ws, contactId: cA },
          }),
        ).toBe(0);
      } finally {
        solta.abrir();
      }
      await geracaoB.p;
      expect(geracaoB.estado.erro).toBeNull();
      expect((await usos(outro.workspaceId)).map((u) => u.status)).toEqual(['concluded']);
    });

    it('o envio da IA preso no workspace B não segura a revogação no A', async () => {
      await ativar();
      await liberar(contatoDaConversa);
      const outro = await createWorkspaceFixture(prisma, 'outro');
      const wsB = outro.workspaceId;
      const userB = await createUserFixture(prisma, `b-${randomUUID().slice(0, 8)}@outro.test`);
      const membershipB = await createMembershipFixture(prisma, wsB, userB, outro.roles.owner);
      const cB = await contato(wsB);
      const canalB = await prisma.raw.channel.create({
        data: { workspaceId: wsB, type: 'whatsapp', name: 'WhatsApp fictício B' },
      });
      await prisma.raw.channelCredential.create({
        data: {
          workspaceId: wsB,
          channelId: canalB.id,
          phoneNumberId: '100000000000002',
          businessAccountId: 'waba-ficticia-b',
          tokenCipher: app.get(CryptoService).encrypt('token-ficticio-b'),
        },
      });
      const conversaB = await prisma.raw.conversation.create({
        data: {
          workspaceId: wsB,
          channelId: canalB.id,
          contactId: cB,
          externalAddress: '+5511900000002',
          lastInboundAt: new Date(),
        },
      });
      const { messageId: mensagemB } = await noWorkspace(async () => {
        const envio = app.get(WhatsappSendService);
        const preparado = await envio.prepareOutbound(wsB, { conversationId: conversaB.id });
        return (
          prisma.db as unknown as { $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> }
        ).$transaction(async (tx) =>
          envio.writeOutboundWithin(
            tx,
            wsB,
            preparado,
            { body: 'Mensagem fictícia do B.', authorType: 'ai', authorMembershipId: membershipB },
            { contactIds: [cB] },
          ),
        );
      }, wsB);
      const solta = portao();
      meta.chamada.segura = solta.aberto;
      const envioB = capturar(drenar());
      try {
        await meta.chamada.entrou.aberto; // a guarda do B segura as travas do B
        await revogar(contatoDaConversa); // a do A não espera
        expect(
          await prisma.raw.clinicsContactRelease.count({
            where: { workspaceId: ws, contactId: contatoDaConversa },
          }),
        ).toBe(0);
      } finally {
        solta.abrir();
      }
      await envioB.p;
      expect(envioB.estado.erro).toBeNull();
      expect((await despacho(mensagemB))?.state).toBe('sent');
      expect((await usos(wsB)).map((u) => [u.kind, u.status])).toEqual([
        ['ai_message_dispatch', 'concluded'],
      ]);
    });

    it('a desativação no A marca só os órfãos do A; o do B continua `authorized`', async () => {
      await ativar();
      const outro = await createWorkspaceFixture(prisma, 'outro');
      const orfaoDoB = randomUUID();
      await observador.query(
        `INSERT INTO "ContentUse" ("id","workspaceId","kind","status","contactIds","entityKeys",
           "origin","reservationIds","instanceId","deadlineAt")
         VALUES ($1, $2, 'ai_generation', 'authorized', '{}', '{}', '{}'::jsonb, '{}',
           'processo-morto', now() + interval '1 hour')`,
        [orfaoDoB, outro.workspaceId],
      );
      const orfaoDoA = await inserirOrfao('vivo', {
        kind: 'ai_generation',
        contactIds: [],
        entityKeys: [],
        origin: {},
        runMetadata: null,
        reservationIds: [],
      });
      await desativar();
      const status = async (id: string) =>
        (await prisma.raw.contentUse.findFirst({ where: { id } }))?.status;
      expect(await status(orfaoDoA)).toBe('in_doubt');
      expect(await status(orfaoDoB)).toBe('authorized');
    });
  });

  // ── 4. transição dos despachos anteriores à G3.2 ──────────────────────────

  describe('4. transição: o despacho anterior à G3.2 tem COBERTURA LIMITADA', () => {
    /** O estado de um despacho escrito pelo código anterior à G3.2: sem a fotografia nem a origem. */
    const comoAntigo = (messageId: string) =>
      prisma.raw.$executeRaw`
        UPDATE "MessageDispatch" SET "approvalContactIds" = NULL, "fromAiProposal" = false
         WHERE "messageId" = ${messageId}::uuid`;
    const classificacaoDoRunbook = async () =>
      Number(
        (
          await observador.query<{ n: string }>(
            // a mesma consulta do runbook (DEPLOY_STAGING §4, passo 3)
            `SELECT count(*)::text AS n FROM "MessageDispatch" d
               JOIN "Message" m ON m."workspaceId" = d."workspaceId" AND m."id" = d."messageId"
              WHERE d."state" IN ('reserved', 'failed_before_send', 'sending')
                AND d."approvalContactIds" IS NULL
                AND (m."authorType" = 'ai' OR d."fromAiProposal")`,
          )
        ).rows[0].n,
      );

    it('rascunho SEM edição (`authorType = ai`): continua sob a guarda, mas reconfere só o contato da CONVERSA — o contato só da aprovação não é visto', async () => {
      await ativar();
      const daAprovacao = await contato();
      await liberar(daAprovacao);
      await liberar(contatoDaConversa);
      const { messageId } = await mensagemDaIa([daAprovacao, contatoDaConversa]);
      await comoAntigo(messageId);
      // uma mensagem LIVRE de pessoa, também antiga: não é de origem da IA
      const { messageId: livre } = await noWorkspace(() =>
        app.get(WhatsappSendService).enqueueOutbound(ws, {
          conversationId,
          body: 'Oi, aqui é da clínica.',
          actorMembershipId: auth.membershipId as string,
        }),
      );
      await comoAntigo(livre);
      // a consulta do runbook conta só a de origem da IA como cobertura limitada
      expect(await classificacaoDoRunbook()).toBe(1);
      await revogar(daAprovacao);
      await drenar();
      // o LIMITE, fixado: o contato só da aprovação não está mais no despacho
      // (a mensagem livre também sai, pela regra da pessoa)
      expect(meta.chamada.vezes).toBe(2);
      expect((await despacho(messageId))?.state).toBe('sent');
      expect((await usos()).map((u) => [u.kind, u.contactIds])).toEqual([
        ['ai_message_dispatch', [contatoDaConversa]],
      ]);
    });

    it('rascunho SEM edição antigo: o contato da conversa revogado continua barrando', async () => {
      await ativar();
      await liberar(contatoDaConversa);
      const { messageId } = await mensagemDaIa([contatoDaConversa]);
      await comoAntigo(messageId);
      await revogar(contatoDaConversa);
      await drenar();
      expect(meta.chamada.vezes).toBe(0);
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });
    });

    it('rascunho EDITADO antigo com trilha: o preenchimento da migration lhe dá a origem de IA, e ele não sai para contato restrito', async () => {
      await ativar();
      await liberar(contatoDaConversa);
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
          contactId: contatoDaConversa,
          conversationId,
          expiresAt: new Date(Date.now() + 60 * 60_000),
          pendingReplyMark: true,
        },
      });
      const { messageId } = (await noWorkspace(() =>
        app.get<AiProposalRepository>(AI_PROPOSAL_REPOSITORY).executeSendMessage(
          proposta.id,
          run.id,
          { conversationId, body: 'Temos horário amanhã, às 10h.', edited: true },
          { workspaceId: ws, membershipId: auth.membershipId as string },
          {
            workspaceId: ws,
            contactIds: [contatoDaConversa, null],
            recheck: async () => 'allowed',
          },
        ),
      )) as { messageId: string };
      await comoAntigo(messageId);
      // o preenchimento, exatamente como a migration o aplica
      const preenchimento = readFileSync(
        join(
          __dirname,
          '../../../prisma/migrations/20261021090100_message_dispatch_ai_origin_backfill/migration.sql',
        ),
        'utf8',
      );
      await observador.query(preenchimento);
      expect((await despacho(messageId))?.fromAiProposal).toBe(true);
      await revogar(contatoDaConversa);
      await drenar();
      expect(meta.chamada.vezes).toBe(0);
      expect(await despacho(messageId)).toMatchObject({
        state: 'failed_permanent',
        errorCode: 'content_restricted',
      });
    });
  });
});

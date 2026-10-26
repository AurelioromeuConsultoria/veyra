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
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import type { AuthContext } from '../../common/decorators';
import { CryptoService } from '../../common/crypto.service';
import {
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
} from '../../content-use/content-use.guard';
import { OrigensDosUsos } from '../../content-use/content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../../content-use/content-use.pools';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import { DealsService } from '../../deals/deals.service';
import { MAX_ATTEMPTS, OutboxService } from '../../outbox/outbox.service';
import type { Db } from '../../prisma/prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { SafeFetchResult } from '../../webhooks/safe-http';
import { WEBHOOK_TRANSPORT, WebhooksService } from '../../webhooks/webhooks.service';
import { ClinicsActivationService } from './clinics-activation.service';

/**
 * G3.3 do ADR-047 (adendo 7 §9): a ENTREGA DE WEBHOOK sob a guarda de uso
 * externo — uma guarda por destino e por tentativa, com as travas do evento,
 * do deal da tarefa e da entidade raiz da cadeia, contra o destino falso e a
 * porta REAL do Clinics na reconferência. Determinístico: quem espera quem é
 * conferido em `pg_blocking_pids`, e o POST fica preso num portão. Dados
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
  mudancaTravaMs: 4_000,
  mudancaTransacaoMs: 15_000,
  ingestaoTravaMs: 2_000,
  ingestaoLoteMs: 10_000,
  workspaceTravaMs: 4_000,
  workspaceTransacaoMs: 15_000,
  prazoDaIaMs: 1_000,
  prazoDaMetaMs: 1_000,
  // o POST preso no portão cabe nele; o teste do prazo espera por ele
  prazoDoWebhookMs: 2_500,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

const EVENTOS = ['contact.updated', 'deal.created', 'task.created'];

function portao() {
  let abrir!: () => void;
  const aberto = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { aberto, abrir };
}

/** O destino falso: conta os POSTs, guarda o sinal e pode segurar a resposta. */
class DestinoFalso {
  chamadas: { url: string; sinal: AbortSignal | null }[] = [];
  entrou = portao();
  segura: Promise<void> | null = null;
  ignoraSinal = false;
  status = 200;

  reiniciar(): void {
    this.chamadas = [];
    this.entrou = portao();
    this.segura = null;
    this.ignoraSinal = false;
    this.status = 200;
  }

  async post(
    url: string,
    _body: string,
    _headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<SafeFetchResult> {
    this.chamadas.push({ url, sinal: signal ?? null });
    this.entrou.abrir();
    if (this.segura) {
      if (this.ignoraSinal || !signal) {
        await this.segura;
      } else {
        const abortou = await Promise.race([
          this.segura.then(() => false),
          new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(true))),
        ]);
        // como o transporte real: a requisição caiu pelo prazo
        if (abortou) throw new Error('Entrega abortada pelo prazo');
      }
    }
    return { status: this.status, durationMs: 1 };
  }
}

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('G3.3 — a entrega de webhook sob a guarda de uso externo (ADR-047 adendos 6 e 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService;
  let observador: Client;
  let fixture: WorkspaceFixture;
  let ws: string;
  let auth: AuthContext;
  const destino = new DestinoFalso();
  const SLUG = 'acme';

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        {
          provide: WEBHOOK_TRANSPORT,
          useValue: (...args: Parameters<DestinoFalso['post']>) => destino.post(...args),
        },
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
    destino.reiniciar();
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

  const noWorkspace = <T>(fn: () => Promise<T>, workspaceId = ws): Promise<T> =>
    cls.run(() => {
      cls.set('workspaceId', workspaceId);
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
  /**
   * Uma espera SEM prazo próprio, com diagnóstico: se não terminar em `ms`, a
   * falha diz QUAL etapa travou e o estado do destino, da guarda e do banco.
   * O teste em cadeia falhou por timeout de 30 s, de forma intermitente (b48 da
   * F3.1 e duas vezes na F3.2), sem dizer onde (ADR-048 adendo 7).
   */
  const etapa = async <T>(rotulo: string, promessa: Promise<T>, ms = 20_000): Promise<T> => {
    let relogio: NodeJS.Timeout | undefined;
    const prazo = new Promise<never>((_, rejeitar) => {
      relogio = setTimeout(() => {
        void observador
          .query(
            `SELECT pid, state, coalesce(wait_event_type, '-') AS espera,
                    pg_blocking_pids(pid) AS bloqueado_por, left(query, 120) AS consulta
               FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'`,
          )
          .then(({ rows }) =>
            rejeitar(
              new Error(
                `etapa travada: ${rotulo} — destino com ${destino.chamadas.length} POST(s), ` +
                  `guarda ${pidDaGuarda}, sessões: ${JSON.stringify(rows)}`,
              ),
            ),
          );
      }, ms);
    });
    try {
      return await Promise.race([promessa, prazo]);
    } finally {
      clearTimeout(relogio);
    }
  };
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

  // ── dados fictícios ───────────────────────────────────────────────────────

  const ativarClinics = () => app.get(ClinicsActivationService).enable(SLUG);
  const contato = async (workspaceId = ws) =>
    (await prisma.raw.contact.create({ data: { workspaceId, name: 'Contato fictício' } })).id;
  const deal = async (contactId: string | null, f: WorkspaceFixture = fixture) =>
    (
      await prisma.raw.deal.create({
        data: {
          workspaceId: f.workspaceId,
          title: 'Oportunidade fictícia',
          pipelineId: f.pipelineId,
          stageId: Object.values(f.stages)[0],
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
  const webhook = async (nome: string, workspaceId = ws) =>
    (
      await prisma.raw.webhook.create({
        data: {
          workspaceId,
          url: `https://${nome}.veyra.test/hook`,
          events: EVENTOS,
          secretCipher: app.get(CryptoService).encrypt('segredo-ficticio'),
        },
      })
    ).id;
  /** Evento direto no outbox; a raiz de uma cadeia fica fora do alcance do claim. */
  const evento = (
    eventType: string,
    entityId: string,
    opcoes: { workspaceId?: string; chainId?: string; raiz?: boolean; tentativas?: number } = {},
  ) =>
    prisma.raw.outboxEvent.create({
      data: {
        workspaceId: opcoes.workspaceId ?? ws,
        eventType,
        payload: { id: entityId },
        dedupeKey: `${eventType}:${entityId}:${randomUUID()}`,
        chainId: opcoes.chainId ?? null,
        attempts: opcoes.tentativas ?? 0,
        ...(opcoes.raiz ? { nextRetryAt: new Date(Date.now() + 3_600_000) } : {}),
      },
    });
  const entregar = async () => {
    const outbox = app.get(OutboxService);
    const entregador = app.get(WebhooksService);
    for (const claimed of await outbox.claimBatch(100)) await entregador.deliver(claimed);
  };
  const trocarContatoDoDeal = (dealId: string, contactId: string | null) =>
    noWorkspace(() => app.get(DealsService).update(auth, dealId, { contactId }));
  const usos = (workspaceId = ws) =>
    prisma.raw.contentUse.findMany({ where: { workspaceId }, orderBy: { authorizedAt: 'asc' } });
  const entregas = (workspaceId = ws) =>
    prisma.raw.webhookDelivery.findMany({ where: { workspaceId }, orderBy: { attempt: 'asc' } });
  const linhaDo = (id: string) => prisma.raw.outboxEvent.findFirst({ where: { id } });
  const falhasDos = async () =>
    (await prisma.raw.webhook.findMany({ where: { workspaceId: ws } })).map((w) => w.failureCount);

  /** Pausa a PRIMEIRA chamada de `porContato` logo depois das travas. */
  function pausarAMudancaDepoisDasTravas() {
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
    return { travou, segue };
  }

  it('caminho feliz, deal SEM contato num workspace com o Clinics: o uso trava o workspace e `deal:<id>`, registra antes do POST e conclui com a entrega', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    await evento('deal.created', d);
    await entregar();
    expect(destino.chamadas).toHaveLength(1);
    expect(destino.chamadas[0].sinal).not.toBeNull();
    const [uso] = await usos();
    expect([uso.kind, uso.status]).toEqual(['webhook_delivery', 'concluded']);
    expect(uso.contactIds).toEqual([]);
    expect(uso.entityKeys).toEqual([`deal:${d}`]);
    expect(uso.runMetadata).toEqual({ attempt: 1 });
    const [entrega] = await entregas();
    // a entrega tem o id gerado ANTES da guarda, o mesmo da origem do uso
    expect((uso.origin as Record<string, unknown>).deliveryId).toBe(entrega.id);
    expect([entrega.responseStatus, entrega.error]).toEqual([200, null]);
  });

  it('USO PRIMEIRO: trocar o contato do deal espera a entrega do deal sem contato; a entrega conclui e a troca comita depois', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    const c = await contato();
    await evento('deal.created', d);
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    let troca: ReturnType<typeof capturar> | undefined;
    try {
      await destino.entrou.aberto; // o POST começou, sob as travas
      troca = capturar(trocarContatoDoDeal(d, c));
      await alguemEspera(pidDaGuarda);
      expect(troca.estado.terminou).toBe(false);
    } finally {
      solta.abrir();
    }
    await entrega;
    await troca?.p;
    expect(troca?.estado.erro).toBeNull();
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect((await entregas()).map((e) => e.responseStatus)).toEqual([200]);
  });

  it('MUDANÇA PRIMEIRO: o deal ganha um contato enquanto a entrega espera as travas — a reconferência o vê fora do conjunto travado, nada sai, ninguém é penalizado, e a nova tentativa é suprimida', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    const c = await contato();
    const ev = await evento('deal.created', d);
    const pausa = pausarAMudancaDepoisDasTravas();
    const troca = trocarContatoDoDeal(d, c);
    await pausa.travou.aberto;
    const entrega = entregar();
    try {
      await ate(async () => pidDaGuarda !== null, 'sessão da guarda');
      await esperando(pidDaGuarda);
    } finally {
      pausa.segue.abrir();
    }
    await troca;
    await entrega;
    expect(destino.chamadas).toEqual([]);
    expect(await entregas()).toEqual([]);
    expect(await falhasDos()).toEqual([0]);
    const linha = await linhaDo(ev.id);
    expect(linha?.status).toBe('pending');
    expect(linha?.lastError).toMatch(/de quem é o evento mudou/);
    // a nova tentativa resolve de novo: o contato é restrito, e o evento é suprimido
    await makeRetriableNowById(prisma, ev.id);
    await entregar();
    expect(destino.chamadas).toEqual([]);
    expect((await linhaDo(ev.id))?.status).toBe('delivered');
  });

  it('a TAREFA trava também o deal dela: trocar o contato do deal espera a entrega de `task.created`', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    const t = await tarefa(d);
    const c = await contato();
    await evento('task.created', t);
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    let troca: ReturnType<typeof capturar> | undefined;
    try {
      await destino.entrou.aberto;
      troca = capturar(trocarContatoDoDeal(d, c));
      await alguemEspera(pidDaGuarda);
      expect(troca.estado.terminou).toBe(false);
    } finally {
      solta.abrir();
    }
    await entrega;
    await troca?.p;
    const [uso] = await usos();
    expect([...uso.entityKeys].sort()).toEqual([`deal:${d}`, `task:${t}`].sort());
    expect(uso.status).toBe('concluded');
  });

  it('em CADEIA, a entidade RAIZ também é travada: trocar o contato do deal raiz espera a entrega da tarefa derivada', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const raizDeal = await deal(null);
    const t = await tarefa(null);
    const c = await contato();
    const raiz = await evento('deal.created', raizDeal, { raiz: true });
    await evento('task.created', t, { chainId: raiz.id });
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    let troca: ReturnType<typeof capturar> | undefined;
    try {
      await etapa('a entrega chegar ao destino', destino.entrou.aberto);
      troca = capturar(trocarContatoDoDeal(raizDeal, c));
      await alguemEspera(pidDaGuarda);
      expect(troca.estado.terminou).toBe(false);
    } finally {
      solta.abrir();
    }
    await etapa('a entrega terminar', entrega);
    await etapa('a troca do contato terminar', troca?.p ?? Promise.resolve());
    const [uso] = await usos();
    expect([...uso.entityKeys].sort()).toEqual([`deal:${raizDeal}`, `task:${t}`].sort());
  });

  it('uma guarda nova por DESTINO: dois webhooks, dois usos, cada um com a sua entrega', async () => {
    await ativarClinics();
    await webhook('destino-a');
    await webhook('destino-b');
    const d = await deal(null);
    await evento('deal.created', d);
    await entregar();
    expect(destino.chamadas).toHaveLength(2);
    const lista = await usos();
    expect(lista.map((u) => [u.kind, u.status])).toEqual([
      ['webhook_delivery', 'concluded'],
      ['webhook_delivery', 'concluded'],
    ]);
    const origens = lista.map((u) => (u.origin as Record<string, string>).deliveryId).sort();
    expect(origens).toEqual((await entregas()).map((e) => e.id).sort());
    expect(new Set(lista.map((u) => (u.origin as Record<string, string>).webhookId)).size).toBe(2);
  });

  it('uma guarda nova por TENTATIVA: a falha do destino volta pelo outbox, e a nova tentativa é outro uso, com `attempt` 2', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    const ev = await evento('deal.created', d);
    destino.status = 500;
    await entregar();
    expect((await linhaDo(ev.id))?.status).toBe('pending');
    destino.status = 200;
    await makeRetriableNowById(prisma, ev.id);
    await entregar();
    expect((await linhaDo(ev.id))?.status).toBe('delivered');
    const lista = await usos();
    expect(lista.map((u) => u.runMetadata)).toEqual([{ attempt: 1 }, { attempt: 2 }]);
    expect(lista.map((u) => u.status)).toEqual(['concluded', 'concluded']);
    expect((await entregas()).map((e) => [e.attempt, e.responseStatus])).toEqual([
      [1, 500],
      [2, 200],
    ]);
  });

  it('ENTRE DESTINOS: o deal ganha um contato depois do 1º destino — a guarda do 2º o vê, e ele não recebe', async () => {
    await ativarClinics();
    await webhook('destino-a');
    await webhook('destino-b');
    const d = await deal(null);
    const c = await contato();
    const ev = await evento('deal.created', d);
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    let troca: ReturnType<typeof capturar> | undefined;
    try {
      await destino.entrou.aberto; // o 1º POST, sob a guarda do 1º destino
      troca = capturar(trocarContatoDoDeal(d, c));
      await alguemEspera(pidDaGuarda);
    } finally {
      solta.abrir();
    }
    await entrega;
    await troca?.p;
    expect(troca?.estado.erro).toBeNull();
    expect(destino.chamadas).toHaveLength(1);
    expect((await entregas()).map((e) => e.responseStatus)).toEqual([200]);
    expect(await falhasDos()).toEqual([0, 0]);
    expect((await linhaDo(ev.id))?.status).toBe('pending');
    // a nova tentativa: o 2º destino não recebe nunca — o contato é restrito
    await makeRetriableNowById(prisma, ev.id);
    await entregar();
    expect(destino.chamadas).toHaveLength(1);
    expect((await linhaDo(ev.id))?.status).toBe('delivered');
  });

  it('a guarda MORRE durante o POST, na ÚLTIMA tentativa: o uso fica em dúvida, a entrega nasce como falha incerta com o id gerado antes, e o evento morre SEM penalizar o destino', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    // a tentativa que vai ao ar é a última: só uma falha DO DESTINO contaria
    // para a pausa, e "em dúvida" é falha do EVENTO
    const ev = await evento('deal.created', d, { tentativas: MAX_ATTEMPTS - 1 });
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    await destino.entrou.aberto;
    await derrubar(pidDaGuarda);
    solta.abrir();
    await entrega;
    const [uso] = await usos();
    expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'commit']);
    const [incerta] = await entregas();
    expect(incerta.id).toBe((uso.origin as Record<string, string>).deliveryId);
    expect([incerta.error, incerta.responseStatus, incerta.attempt]).toEqual([
      'in_doubt',
      null,
      MAX_ATTEMPTS,
    ]);
    const linha = await linhaDo(ev.id);
    expect(linha?.status).toBe('dead');
    expect(linha?.lastError).toMatch(/em dúvida/);
    expect(await falhasDos()).toEqual([0]);
  });

  it('o PRAZO aborta o POST pelo sinal: falha do destino, gravada sob a guarda, e o uso conclui', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    await evento('deal.created', d);
    destino.segura = new Promise<void>(() => undefined);
    await entregar();
    expect(destino.chamadas[0].sinal?.aborted).toBe(true);
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    const [entrega] = await entregas();
    expect([entrega.responseStatus, entrega.error]).toEqual([null, 'Entrega abortada pelo prazo']);
  });

  it('o POST que IGNORA o sinal e passa do prazo: o próprio processo marca `overran_deadline`, e a entrega nasce incerta', async () => {
    await ativarClinics();
    await webhook('destino-a');
    const d = await deal(null);
    await evento('deal.created', d);
    const solta = portao();
    destino.segura = solta.aberto;
    destino.ignoraSinal = true;
    try {
      await entregar();
      const [uso] = await usos();
      expect([uso.status, uso.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
      expect((await entregas()).map((e) => e.error)).toEqual(['in_doubt']);
    } finally {
      solta.abrir();
    }
  });

  it('workspace SEM o Clinics: o evento de contato sai sob a guarda, com o contato travado', async () => {
    await webhook('destino-a');
    const c = await contato();
    await evento('contact.updated', c);
    await entregar();
    expect(destino.chamadas).toHaveLength(1);
    const [uso] = await usos();
    expect([uso.kind, uso.status, uso.contactIds]).toEqual(['webhook_delivery', 'concluded', [c]]);
  });

  it('a ATIVAÇÃO do Clinics (o workspace inteiro) espera a entrega em andamento; depois dela, o evento de contato é suprimido', async () => {
    await webhook('destino-a');
    const c = await contato();
    await evento('contact.updated', c);
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    let ativacao: ReturnType<typeof capturar> | undefined;
    try {
      await destino.entrou.aberto;
      ativacao = capturar(ativarClinics());
      await alguemEspera(pidDaGuarda);
      expect(ativacao.estado.terminou).toBe(false);
    } finally {
      solta.abrir();
    }
    await entrega;
    await ativacao?.p;
    expect(ativacao?.estado.erro).toBeNull();
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    const depois = await evento('contact.updated', c);
    await entregar();
    expect(destino.chamadas).toHaveLength(1);
    expect((await linhaDo(depois.id))?.status).toBe('delivered');
  });

  it('ISOLAMENTO: a entrega presa no workspace B não segura a troca de contato do deal no A', async () => {
    await ativarClinics();
    const outro = await createWorkspaceFixture(prisma, 'outro');
    await webhook('destino-b', outro.workspaceId);
    const dB = await deal(null, outro);
    await evento('deal.created', dB, { workspaceId: outro.workspaceId });
    const dA = await deal(null);
    const cA = await contato();
    const solta = portao();
    destino.segura = solta.aberto;
    const entrega = entregar();
    try {
      await destino.entrou.aberto; // a entrega do B segura as travas do B
      await trocarContatoDoDeal(dA, cA); // a do A não espera
      expect(
        (await prisma.raw.deal.findFirst({ where: { workspaceId: ws, id: dA } }))?.contactId,
      ).toBe(cA);
    } finally {
      solta.abrir();
    }
    await entrega;
    const [usoB] = await usos(outro.workspaceId);
    expect([usoB.workspaceId, usoB.entityKeys]).toEqual([outro.workspaceId, [`deal:${dB}`]]);
    expect(await usos()).toEqual([]);
  });

  it('o tratador de origem numa transação `raw`, com linhas de OUTRO workspace: só cria a entrega incerta no workspace do uso', async () => {
    const outro = await createWorkspaceFixture(prisma, 'outro');
    const webhookId = await webhook('destino-a');
    const d = await deal(null);
    const ev = await evento('deal.created', d);
    await webhook('destino-b', outro.workspaceId);
    const tratador = app.get(OrigensDosUsos).de('webhook_delivery');
    const deliveryId = randomUUID();
    const uso = (workspaceId: string) => ({
      id: randomUUID(),
      workspaceId,
      kind: 'webhook_delivery' as const,
      contactIds: [],
      entityKeys: [`deal:${d}`],
      origin: { deliveryId, webhookId, outboxEventId: ev.id },
      reservationIds: [],
      runMetadata: { attempt: 1 },
    });
    await prisma.raw.$transaction(async (tx) => {
      // as mesmas ids, mas como se o uso fosse do OUTRO workspace: nada nasce
      await tratador?.marcarIncerta(tx as unknown as Db, uso(outro.workspaceId));
    });
    expect(await prisma.raw.webhookDelivery.count()).toBe(0);
    await prisma.raw.$transaction(async (tx) => {
      await tratador?.marcarIncerta(tx as unknown as Db, uso(ws));
      // repetido: idempotente
      await tratador?.marcarIncerta(tx as unknown as Db, uso(ws));
    });
    const lista = await prisma.raw.webhookDelivery.findMany();
    expect(lista.map((e) => [e.id, e.workspaceId, e.error, e.attempt])).toEqual([
      [deliveryId, ws, 'in_doubt', 1],
    ]);
  });
});

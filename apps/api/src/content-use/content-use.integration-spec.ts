import type { INestApplication } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createTestApp } from '../../test/integration/app';
import { TEST_DATABASE_URL } from '../../test/integration/db-url';
import { resetDb } from '../../test/integration/harness';
import { createWorkspaceFixture, seedPermissionCatalog } from '../../test/integration/fixtures';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import {
  ContentUseGuard,
  GANCHOS_DA_GUARDA,
  ehIncerto,
  type ContextoDoPonto,
  type PontoDaGuarda,
  type UsoExterno,
  type Veredito,
  orcamentoDaGuarda,
} from './content-use.guard';
import { OrigensDosUsos, UsosOrfaos, type UsoRegistrado } from './content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from './content-use.pools';
import { ReconciliacaoDosUsos } from './content-use.reconciler';
import { CHAVE, travarParaMudanca, travarWorkspaceInteiro } from './restriction-locks';
import { COORDENACAO } from './coordination-sql';

/**
 * A GUARDA de uso externo (ADR-047 adendos 6 e 7, G′), com falhas DETERMINÍSTICAS:
 * os pontos de teste param a guarda onde a falha precisa acontecer, e uma
 * conexão observadora derruba a sessão, segura travas ou confere o banco.
 * Operação falsa, dados fictícios. Os critérios obrigatórios da aprovação:
 * registro comitado antes da chamada (falha impede o envio); reconciliação só
 * com prova de que a guarda acabou; resultados, auditoria e reservas
 * consistentes com reinício, conclusão tardia e dois detectores.
 */
const CONFIG: ConfigDaGuarda = {
  tamanhoDoPoolDaGuarda: 3,
  tamanhoDoPoolDeRegistro: 2,
  esperaPorSessaoMs: 3_000,
  registroConexaoMs: 1_000,
  registroInstrucaoMs: 800,
  travaMs: 300,
  reconferenciaMs: 1_000,
  reconciliacaoMs: 1_000,
  mudancaTravaMs: 1_000,
  mudancaTransacaoMs: 5_000,
  ingestaoTravaMs: 2_000,
  ingestaoLoteMs: 10_000,
  workspaceTravaMs: 1_000,
  workspaceTransacaoMs: 5_000,
  prazoDaIaMs: 1_000,
  prazoDaMetaMs: 1_000,
  prazoDoWebhookMs: 1_000,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

type TxRunner = { $transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> };
type TxRunnerComOpcoes = {
  $transaction<T>(fn: (tx: Db) => Promise<T>, options?: { timeout?: number }): Promise<T>;
};

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('Guarda de uso externo (ADR-047 adendos 6 e 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let guarda: ContentUseGuard;
  let usage: UsageService;
  let orfaos: UsosOrfaos;
  let reconciliacao: ReconciliacaoDosUsos;
  let cls: ClsService;
  let observador: Client;
  let ws: string;
  const origensMarcadas: string[] = [];
  let origemQueFalha: string | null = null;

  beforeAll(async () => {
    app = await createTestApp(
      [],
      [
        { provide: CONFIG_DA_GUARDA, useValue: CONFIG },
        {
          provide: GANCHOS_DA_GUARDA,
          useValue: (ponto: PontoDaGuarda, contexto: ContextoDoPonto) => gancho?.(ponto, contexto),
        },
      ],
    );
    prisma = app.get(PrismaService);
    guarda = app.get(ContentUseGuard);
    usage = app.get(UsageService);
    orfaos = app.get(UsosOrfaos);
    reconciliacao = app.get(ReconciliacaoDosUsos);
    cls = app.get(ClsService);
    // a especificação REAL do tipo `ai_generation` (registrada pelo módulo da
    // IA na subida), com o tratador espiado: conta as marcações e falha sob
    // demanda
    const especificacao = app.get(OrigensDosUsos).de('ai_generation');
    if (!especificacao) throw new Error('ai_generation sem especificação registrada');
    const tratadorReal = especificacao.marcarIncerta.bind(especificacao);
    jest.spyOn(especificacao, 'marcarIncerta').mockImplementation(async (tx, uso) => {
      if (uso.id === origemQueFalha) throw new Error('tratador de origem com defeito');
      origensMarcadas.push(uso.id);
      await tratadorReal(tx, uso);
    });
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });

  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  beforeEach(async () => {
    gancho = null;
    origemQueFalha = null;
    origensMarcadas.length = 0;
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    ws = (await createWorkspaceFixture(prisma, 'acme')).workspaceId;
  });

  const noWorkspace = <T>(fn: () => Promise<T>): Promise<T> =>
    cls.run(() => {
      cls.set('workspaceId', ws);
      return fn();
    });

  const reservar = (quanto = 1) =>
    noWorkspace(async () => {
      const r = await usage.reserve(ws, 'ai_runs', quanto);
      if (r === 'quota_exceeded') throw new Error('quota');
      return r.reservationId;
    });

  const contador = async () =>
    Number(
      (
        await prisma.raw.usageCounter.findFirst({
          where: { workspaceId: ws, metric: 'ai_runs' },
          select: { value: true },
        })
      )?.value ?? 0,
    );

  const reservaExiste = async (id: string) =>
    (await prisma.raw.usageReservation.count({ where: { id } })) > 0;

  const usos = () =>
    prisma.raw.contentUse.findMany({
      where: { workspaceId: ws },
      orderBy: { authorizedAt: 'asc' },
    });

  const incidentes = (id: string, action = 'content_use.in_doubt') =>
    prisma.raw.auditLog.count({ where: { workspaceId: ws, action, entityId: id } });

  /** Espera o registro aparecer, comitado, e vence o prazo dele pelo relógio do banco. */
  const registroComPrazoVencido = async () => {
    for (let i = 0; i < 300 && (await usos()).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const [registro] = await usos();
    if (!registro) throw new Error('o registro não apareceu');
    await observador.query(
      `UPDATE "ContentUse" SET "deadlineAt" = now() - interval '1 second' WHERE "id" = $1`,
      [registro.id],
    );
    return registro.id;
  };

  /** A reserva venceu: a varredura de reservas pode devolvê-la. */
  const vencerReserva = (id: string) =>
    prisma.raw.usageReservation.updateMany({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

  /** Uma operação falsa e o que ela viu. */
  function falso(opcoes: {
    contactIds?: string[];
    entityKeys?: string[];
    reservas?: string[];
    veredito?: Veredito;
    reconferir?: (tx: Db) => Promise<Veredito>;
    prazoMs?: number;
    iniciar?: (signal: AbortSignal) => Promise<string>;
    persistir?: (tx: Db) => Promise<void>;
  }) {
    const visto = {
      iniciou: false,
      registroNoInicio: null as string | null,
      persistenciaFalhou: false,
      sequencia: [] as string[],
    };
    const uso: UsoExterno<string, string> = {
      workspaceId: ws,
      kind: 'ai_generation',
      contactIds: opcoes.contactIds ?? [randomUUID()],
      entityKeys: opcoes.entityKeys,
      prazoMs: opcoes.prazoMs ?? 1_000,
      origem: { runId: randomUUID() },
      reservas: opcoes.reservas ?? [],
      metadadosDoRun: {
        capability: 'conversation_summary',
        model: 'claude-sonnet-5',
        promptVersion: 1,
      },
      reconferir: (tx) =>
        opcoes.reconferir ? opcoes.reconferir(tx) : Promise.resolve(opcoes.veredito ?? 'liberado'),
      iniciar: async (signal) => {
        visto.iniciou = true;
        visto.sequencia.push('inicio');
        // o registro precisa estar COMITADO e visível de outra conexão
        const { rows } = await observador.query<{ status: string }>(
          `SELECT "status" FROM "ContentUse" WHERE "workspaceId" = $1`,
          [ws],
        );
        visto.registroNoInicio = rows[0]?.status ?? null;
        return opcoes.iniciar ? opcoes.iniciar(signal) : 'ok';
      },
      persistir: async (tx, desfecho) => {
        if (opcoes.persistir) await opcoes.persistir(tx);
        for (const reserva of opcoes.reservas ?? []) {
          await usage.settleWithin(tx, ws, reserva, ehIncerto(desfecho) ? 1 : 1);
        }
        return ehIncerto(desfecho) ? 'incerto' : desfecho;
      },
      persistenciaFalhou: async () => {
        visto.persistenciaFalhou = true;
      },
    };
    return { uso, visto };
  }

  /** Um portão que o teste abre quando quiser. */
  function portao() {
    let abrir!: (erro?: Error) => void;
    const aberto = new Promise<void>((resolve, reject) => {
      abrir = (erro) => (erro ? reject(erro) : resolve());
    });
    return { aberto, abrir };
  }

  const derrubar = (pid: number | null) =>
    observador.query('SELECT pg_terminate_backend($1)', [pid]);

  const esperarDerrubada = async (pid: number | null, tentativas = 200) => {
    for (let i = 0; i < tentativas; i++) {
      const { rows } = await observador.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
        pid,
      ]);
      if (rows.length === 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('a sessão da guarda não caiu');
  };

  /** Um uso `authorized` órfão: o processo morreu depois do registro. */
  async function orfao(escopo: {
    contactIds?: string[];
    entityKeys?: string[];
    reservas?: string[];
  }): Promise<string> {
    const id = randomUUID();
    await observador.query(
      `INSERT INTO "ContentUse" ("id","workspaceId","kind","status","contactIds","entityKeys",
         "origin","reservationIds","instanceId","deadlineAt")
       VALUES ($1, $2, 'ai_generation', 'authorized', $3::uuid[], $4::text[], '{}'::jsonb, $5::uuid[],
         'morto', now() - interval '1 second')`,
      [id, ws, escopo.contactIds ?? [], escopo.entityKeys ?? [], escopo.reservas ?? []],
    );
    return id;
  }

  it('caminho feliz: o registro está COMITADO antes da chamada, e o uso termina concluído', async () => {
    const reserva = await reservar();
    const { uso, visto } = falso({ reservas: [reserva] });
    const resultado = await noWorkspace(() => guarda.executar(uso));
    expect(resultado).toEqual({ tipo: 'concluido', valor: 'ok', persistido: true });
    expect(visto.registroNoInicio).toBe('authorized');
    const [registro] = await usos();
    expect(registro.status).toBe('concluded');
    expect(registro.runMetadata).toEqual({
      capability: 'conversation_summary',
      model: 'claude-sonnet-5',
      promptVersion: 1,
    });
    expect(await reservaExiste(reserva)).toBe(false); // acertada pelo real
    expect(await contador()).toBe(1);
  });

  it('a ordem dos passos: travas → reconferência → registro → prova de vida → início, sem I/O entre a prova e o início', async () => {
    const { uso, visto } = falso({});
    gancho = (ponto) => {
      visto.sequencia.push(ponto);
    };
    await noWorkspace(() => guarda.executar(uso));
    expect(visto.sequencia).toEqual([
      'sessao',
      'trava_do_uso',
      'travas',
      'reconferida',
      'registro_antes_do_insert',
      'registro_aberto',
      'registro_comitado',
      'antes_da_prova',
      'inicio',
      'desfecho',
      'persistido',
      'antes_do_commit',
    ]);
  });

  it('reconferência restrita: não registra, não chama, e a reserva volta', async () => {
    const reserva = await reservar();
    const { uso, visto } = falso({ reservas: [reserva], veredito: 'restrito' });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'restrito',
    });
    expect(visto.iniciou).toBe(false);
    expect(await usos()).toHaveLength(0);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
  });

  it('mudança segurando a trava do contato: a guarda espera o `lock_timeout` e não começa', async () => {
    const contato = randomUUID();
    const reserva = await reservar();
    await observador.query('BEGIN');
    await observador.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      CHAVE.contato(ws, contato),
    ]);
    try {
      const { uso, visto } = falso({ contactIds: [contato], reservas: [reserva] });
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
        tipo: 'nao_comecou',
        motivo: 'trava',
      });
      expect(visto.iniciou).toBe(false);
      expect(await usos()).toHaveLength(0);
      expect(await contador()).toBe(0);
    } finally {
      await observador.query('ROLLBACK');
    }
  });

  it('FALHA DE REGISTRO impede o envio: a lápide fica `aborted` e a reserva volta', async () => {
    const reserva = await reservar();
    gancho = (ponto) => {
      if (ponto === 'registro_aberto') throw new Error('registro falhou antes do commit');
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'registro',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
  });

  it('commit AMBÍGUO do registro (comitou, o cliente viu erro): a lápide vira o registro em `aborted`, e a reserva volta uma vez', async () => {
    const reserva = await reservar();
    gancho = (ponto) => {
      if (ponto === 'registro_comitado') throw new Error('a resposta do COMMIT se perdeu');
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'registro',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await contador()).toBe(0);
  });

  it('registro AINDA comitando quando a guarda desiste: a lápide ESPERA o registro e o deixa `aborted`', async () => {
    const reserva = await reservar();
    const segura = portao();
    let pidDoRegistro: number | undefined;
    let pidDaGuarda: number | null = null;
    let xidDoRegistro: string | null = null;
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_aberto') {
        pidDoRegistro = contexto.pidDoRegistro;
        pidDaGuarda = contexto.pid;
        const { rows } = await observador.query<{ xid: string | null }>(
          'SELECT backend_xid::text AS xid FROM pg_stat_activity WHERE pid = $1',
          [pidDoRegistro],
        );
        xidDoRegistro = rows[0]?.xid ?? null;
        await segura.aberto; // o INSERT está feito, o COMMIT ainda não
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    const execucao = noWorkspace(() => guarda.executar(uso));
    // o portão SEMPRE abre: sem isso, uma asserção que falha deixa a linha do
    // registro travada e o TRUNCATE do teste seguinte espera para sempre
    try {
      // a guarda desiste do registro (prazo) e a lápide fica esperando a linha dele
      for (let i = 0; i < 300; i++) {
        const { rows } = await observador.query<{ bloqueado: boolean }>(
          'SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS bloqueado',
          [pidDoRegistro ?? 0, pidDaGuarda ?? 0],
        );
        if (rows[0]?.bloqueado) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const { rows } = await observador.query<{ bloqueado: boolean }>(
        'SELECT $1::int = ANY (pg_blocking_pids($2::int)) AS bloqueado',
        [pidDoRegistro ?? 0, pidDaGuarda ?? 0],
      );
      expect(rows[0].bloqueado).toBe(true);
    } finally {
      segura.abrir(); // o registro comita agora
    }
    expect(await execucao).toEqual({ tipo: 'nao_comecou', motivo: 'registro' });
    expect(visto.iniciou).toBe(false);
    // o registro de fato COMITOU `authorized` — e a lápide o transicionou
    const { rows: transacao } = await observador.query<{ status: string }>(
      'SELECT pg_xact_status($1::text::xid8) AS status',
      [xidDoRegistro],
    );
    expect(transacao[0].status).toBe('committed');
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await contador()).toBe(0);
  });

  it('registro ATRASADO, depois da lápide: esbarra nela pelo índice único (23505) e nunca vira `authorized`', async () => {
    const atrasa = portao();
    const recusado = portao();
    let codigo: string | undefined;
    let inseriu = false;
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_antes_do_insert') await atrasa.aberto;
      if (ponto === 'registro_recusado') {
        codigo = contexto.codigo;
        recusado.abrir();
      }
      if (ponto === 'registro_aberto') inseriu = true;
    };
    // sem reserva: o `FOR SHARE` do registro seguraria a devolução da lápide
    const { uso, visto } = falso({});
    try {
      // a guarda desiste no prazo do registro e a lápide comita primeiro
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
        tipo: 'nao_comecou',
        motivo: 'registro',
      });
    } finally {
      atrasa.abrir(); // o registro atrasado tenta agora, na conexão ainda viva
    }
    await recusado.aberto;
    expect(codigo).toBe('23505');
    expect(inseriu).toBe(false);
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
  });

  it('PROVA DE VIDA falha depois do registro: o uso vira `aborted` e a reserva volta', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_da_prova') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'prova_de_vida',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await contador()).toBe(0);
  });

  it('prova de vida falha com M ANTES: o uso fica `in_doubt` (marcado por M) e a reserva fica cobrada — uma vez', async () => {
    const contato = randomUUID();
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_da_prova') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
        await noWorkspace(() =>
          (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
            await travarParaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
            await orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
          }),
        );
      }
    };
    const { uso, visto } = falso({ contactIds: [contato], reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    expect(visto.iniciou).toBe(false);
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'change']);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1); // cobrada pelo teto, e não devolvida depois
  });

  it('PERSISTÊNCIA falha com a guarda viva: o uso termina `concluded`, sem `in_doubt` falso, e a reserva fica cobrada pelo teto', async () => {
    const reserva = await reservar();
    const { uso, visto } = falso({
      reservas: [reserva],
      persistir: async () => {
        throw new Error('a persistência falhou');
      },
    });
    const resultado = await noWorkspace(() => guarda.executar(uso));
    expect(resultado).toEqual({ tipo: 'concluido', valor: undefined, persistido: false });
    expect(visto.persistenciaFalhou).toBe(true);
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1);
  });

  it('a persistência roda NA conexão da guarda: com a guarda morta no meio da persistência, nenhum resultado legível comita', async () => {
    const marca = `resultado-${randomUUID().slice(0, 8)}`;
    let pidDaGuarda: number | null = null;
    gancho = (ponto, contexto) => {
      if (ponto === 'desfecho') pidDaGuarda = contexto.pid;
    };
    const { uso } = falso({
      persistir: async (tx) => {
        // a guarda morre AQUI, já dentro da persistência: escrever por outra
        // conexão comitaria o resultado depois que as travas soltaram
        await derrubar(pidDaGuarda);
        await esperarDerrubada(pidDaGuarda);
        await tx.tag.create({ data: { name: marca } } as never);
      },
    });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    expect(await prisma.raw.tag.count({ where: { name: marca } })).toBe(0);
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'commit']);
    expect(origensMarcadas).toEqual([registro.id]);
  });

  it('`COMMIT` da guarda falha: o próprio processo marca `in_doubt` (commit), cobra a reserva e abre o incidente', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_do_commit') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'commit']);
    expect(await contador()).toBe(1);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(
      await prisma.raw.auditLog.count({
        where: { workspaceId: ws, action: 'content_use.in_doubt', entityId: registro.id },
      }),
    ).toBe(1);
  });

  it('processo MORTO depois do registro e antes do envio: a reconciliação marca `in_doubt`, cobra e audita — e a volta tardia do processo não desfaz', async () => {
    const reserva = await reservar();
    const morto = portao();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_da_prova') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
        await morto.aberto; // o processo "morreu" aqui
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    const execucao = noWorkspace(() => guarda.executar(uso));
    try {
      await registroComPrazoVencido();
      expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
      const [registro] = await usos();
      expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'reconciliation']);
      expect(origensMarcadas).toEqual([registro.id]);
      expect(await contador()).toBe(1);
      expect(await reservaExiste(reserva)).toBe(false);
      expect(await incidentes(registro.id)).toBe(1);
    } finally {
      morto.abrir(new Error('o processo voltou'));
    }
    expect(await execucao).toEqual({ tipo: 'em_duvida' });
    expect(visto.iniciou).toBe(false);
    expect(await contador()).toBe(1); // nada devolvido depois da marcação
    expect((await usos()).map((u) => u.status)).toEqual(['in_doubt']);
  });

  it('guarda VIVA com prazo vencido (congelada abaixo dos prazos de sessão), sem contato: a reconciliação NÃO marca, e o uso termina `concluded`', async () => {
    const solta = portao();
    const { uso } = falso({
      contactIds: [], // webhook de deal sem contato: a guarda vale mesmo assim
      prazoMs: 5_000,
      iniciar: async () => {
        await solta.aberto;
        return 'ok';
      },
    });
    const execucao = noWorkspace(() => guarda.executar(uso));
    try {
      await registroComPrazoVencido(); // o prazo vencido só ESCOLHE o candidato
      expect(await reconciliacao.varrer()).toEqual({ marcados: 0, vivos: 1, falhas: 0 });
    } finally {
      solta.abrir();
    }
    expect(await execucao).toEqual({ tipo: 'concluido', valor: 'ok', persistido: true });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
  });

  it('guarda congelada ALÉM dos prazos de sessão: o servidor derruba a sessão, a reconciliação marca, e a conclusão tardia fica registrada', async () => {
    const descongela = portao();
    const congelou = portao();
    let pidDaGuarda: number | null = null;
    gancho = async (ponto, contexto) => {
      if (ponto === 'desfecho') {
        pidDaGuarda = contexto.pid;
        congelou.abrir();
        await descongela.aberto; // o processo inteiro congelou aqui
      }
    };
    const { uso } = falso({ prazoMs: 100 });
    const execucao = noWorkspace(() => guarda.executar(uso));
    try {
      await congelou.aberto;
      // `idle_in_transaction_session_timeout` = prazo (100) + margem (1500): o
      // servidor derruba a sessão sozinho
      await esperarDerrubada(pidDaGuarda, 500);
      expect((await reconciliacao.varrer()).marcados).toBe(1);
    } finally {
      descongela.abrir();
    }
    expect(await execucao).toEqual({ tipo: 'em_duvida' });
    const [registro] = await usos();
    expect(registro.status).toBe('in_doubt');
    expect(registro.lateAttemptAt).not.toBeNull();
    expect(
      await prisma.raw.auditLog.count({
        where: { workspaceId: ws, action: 'content_use.late_conclusion', entityId: registro.id },
      }),
    ).toBe(1);
  });

  it('órfão com OUTRO uso vivo no mesmo contato: a reconciliação marca o órfão, sem inanição', async () => {
    const contato = randomUUID();
    const solta = portao();
    const vivo = falso({
      contactIds: [contato],
      prazoMs: 5_000,
      iniciar: async () => {
        await solta.aberto;
        return 'ok';
      },
    });
    const execucao = noWorkspace(() => guarda.executar(vivo.uso));
    for (let i = 0; i < 200 && (await usos()).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const idDoOrfao = await orfao({ contactIds: [contato] });
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
    expect((await prisma.raw.contentUse.findFirst({ where: { id: idDoOrfao } }))?.status).toBe(
      'in_doubt',
    );
    solta.abrir();
    expect((await execucao).tipo).toBe('concluido');
  });

  it('M marca o órfão pelo CONTATO e pela ENTIDADE; a mudança do WORKSPACE marca o resto', async () => {
    const c1 = randomUUID();
    const porContato = await orfao({ contactIds: [c1] });
    const porEntidade = await orfao({ entityKeys: ['deal:d1'] });
    const resto = await orfao({ contactIds: [randomUUID()] });
    const status = async (id: string) =>
      (await prisma.raw.contentUse.findFirst({ where: { id } }))?.detectedBy;

    await noWorkspace(() =>
      (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        await travarParaMudanca(tx, { workspaceId: ws, contactIds: [c1] });
        expect(await orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, contactIds: [c1] })).toBe(
          1,
        );
      }),
    );
    await noWorkspace(() =>
      (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        await travarParaMudanca(tx, { workspaceId: ws, entityKeys: ['deal:d1'] });
        expect(
          await orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, entityKeys: ['deal:d1'] }),
        ).toBe(1);
      }),
    );
    expect([await status(porContato), await status(porEntidade), await status(resto)]).toEqual([
      'change',
      'change',
      null,
    ]);
    await prisma.raw.$transaction(async (tx) => {
      await travarWorkspaceInteiro(tx as unknown as Db, ws);
      expect(await orfaos.marcarOrfaosDoWorkspace(tx as unknown as Db, ws)).toBe(1);
    });
    expect(await status(resto)).toBe('workspace_change');
  });

  it('DOIS detectores no mesmo órfão (M e reconciliação, ao mesmo tempo): uma só cobrança, um só incidente, sem deadlock', async () => {
    const contato = randomUUID();
    const reserva = await reservar();
    const id = await orfao({ contactIds: [contato], reservas: [reserva] });
    // M marca e SEGURA o commit; a reconciliação entra e fica esperando a linha
    const segura = portao();
    let pidDeM = 0;
    const marcou = portao();
    const mudanca = noWorkspace(() =>
      (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>(COORDENACAO.pidDaSessao());
        pidDeM = pid;
        await travarParaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
        await orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
        marcou.abrir();
        await segura.aberto;
      }),
    );
    await marcou.aberto;
    const varredura = reconciliacao.varrer();
    for (let i = 0; i < 300; i++) {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE $1::int = ANY (pg_blocking_pids(pid))`,
        [pidDeM],
      );
      if (Number(rows[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const { rows: bloqueados } = await observador.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))`,
      [pidDeM],
    );
    expect(Number(bloqueados[0].n)).toBeGreaterThan(0); // a reconciliação espera a linha de M
    segura.abrir();
    await Promise.all([mudanca, varredura]);
    expect((await prisma.raw.contentUse.findFirst({ where: { id } }))?.status).toBe('in_doubt');
    expect(await contador()).toBe(1);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await incidentes(id)).toBe(1);
    expect(origensMarcadas).toEqual([id]); // a origem muda DEPOIS da transição, uma vez
  });

  it('N usos simultâneos, com N acima do tamanho de cada pool: todos terminam, sem espera circular', async () => {
    const execucoes = Array.from({ length: 6 }, () =>
      noWorkspace(() => guarda.executar(falso({ contactIds: [randomUUID()] }).uso)),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resultados = await Promise.race([
      Promise.all(execucoes),
      new Promise<never>((_, rejeitar) => {
        timer = setTimeout(() => rejeitar(new Error('espera circular')), 15_000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(resultados.every((r) => r.tipo === 'concluido')).toBe(true);
  });

  it('a varredura de reservas NÃO devolve a reserva de um uso ainda `authorized`', async () => {
    const reserva = await reservar();
    await prisma.raw.usageReservation.updateMany({
      where: { id: reserva },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const id = await orfao({ reservas: [reserva] });
    await usage.purgeExpiredReservations();
    expect(await reservaExiste(reserva)).toBe(true);
    await prisma.raw.contentUse.updateMany({ where: { id }, data: { status: 'concluded' } });
    await usage.purgeExpiredReservations();
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
  });

  it('retenção: `concluded` e `aborted` saem depois de 30 dias; `in_doubt`, depois da retenção da auditoria', async () => {
    const linhas: [string, string][] = [
      ['concluded', '31 days'],
      ['aborted', '31 days'],
      ['in_doubt', '31 days'],
      ['in_doubt', '400 days'],
      ['concluded', '1 day'],
    ];
    for (const [status, idade] of linhas) {
      const id = await orfao({});
      await observador.query(
        `UPDATE "ContentUse" SET "status" = $2::"ContentUseStatus", "authorizedAt" = now() - $3::interval
          WHERE "id" = $1`,
        [id, status, idade],
      );
    }
    expect(await reconciliacao.expurgar(365)).toBe(3);
    expect((await usos()).map((u) => u.status)).toEqual(['in_doubt', 'concluded']);
  });

  it('SAVEPOINT: um ERRO DE BANCO na persistência desfaz o resultado E o acerto da quota; a reserva é cobrada pelo teto e o uso termina `concluded`', async () => {
    const reserva = await reservar(2);
    const marca = `resultado-${randomUUID().slice(0, 8)}`;
    const { uso, visto } = falso({ reservas: [reserva] });
    uso.persistir = async (tx) => {
      await usage.settleWithin(tx, ws, reserva, 1); // o real seria 1
      await tx.tag.create({ data: { name: marca } } as never);
      // violação de unicidade: a transação do banco fica abortada até o SAVEPOINT
      await tx.tag.create({ data: { name: marca } } as never);
      return 'nunca';
    };
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'concluido',
      valor: undefined,
      persistido: false,
    });
    expect(visto.persistenciaFalhou).toBe(true);
    expect(await prisma.raw.tag.count({ where: { name: marca } })).toBe(0);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(2); // o teto, não o real desfeito
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
  });

  it('fumaça: os prazos internos consumidos quase inteiros não fazem a transação expirar (a prova da soma é o teste de unidade do orçamento)', async () => {
    gancho = async (ponto) => {
      if (ponto === 'registro_aberto') await new Promise((r) => setTimeout(r, 500)); // de 800
    };
    const { uso } = falso({
      prazoMs: 1_000,
      reconferir: async () => {
        await new Promise((r) => setTimeout(r, 850)); // de 1000
        return 'liberado';
      },
      iniciar: async () => {
        await new Promise((r) => setTimeout(r, 850)); // de 1000
        return 'ok';
      },
      persistir: async () => {
        await new Promise((r) => setTimeout(r, 1_400)); // sob o prazo ocioso (1000 + 1500)
      },
    });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'concluido',
      valor: 'ok',
      persistido: true,
    });
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
  });

  it('a última instrução da sessão da guarda antes do início é a PROVA DE VIDA', async () => {
    let pidDaGuarda: number | null = null;
    let ultima: { query: string; state: string } | undefined;
    gancho = (ponto, contexto) => {
      if (ponto === 'antes_da_prova') pidDaGuarda = contexto.pid;
    };
    const { uso } = falso({
      iniciar: async () => {
        const { rows } = await observador.query<{ query: string; state: string }>(
          'SELECT "query", "state" FROM pg_stat_activity WHERE "pid" = $1',
          [pidDaGuarda],
        );
        ultima = rows[0];
        return 'ok';
      },
    });
    expect((await noWorkspace(() => guarda.executar(uso))).tipo).toBe('concluido');
    expect(ultima).toEqual({ query: 'SELECT 1 AS vivo', state: 'idle in transaction' });
  });

  it('a varredura de reservas devolveu a reserva antes do registro: o registro recusa, nada é enviado e nada é devolvido duas vezes', async () => {
    const reserva = await reservar();
    await vencerReserva(reserva);
    gancho = async (ponto) => {
      if (ponto === 'reconferida') expect(await usage.purgeExpiredReservations()).toBe(1);
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'registro',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['aborted']);
    expect(await contador()).toBe(0);
  });

  it('a chamada passa do prazo e da folga sem responder: o próprio processo marca `in_doubt` (overran_deadline), cobra e abre o incidente — a resposta tardia é ignorada', async () => {
    const reserva = await reservar();
    const solta = portao();
    const { uso } = falso({
      reservas: [reserva],
      prazoMs: 100,
      // ignora o sinal de aborto
      iniciar: async () => {
        await solta.aberto;
        return 'tarde';
      },
    });
    try {
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    } finally {
      solta.abrir();
    }
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
    expect(await contador()).toBe(1);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(origensMarcadas).toEqual([registro.id]);
    expect(await incidentes(registro.id)).toBe(1);
    expect(await reconciliacao.varrer()).toEqual({ marcados: 0, vivos: 0, falhas: 0 });
  });

  it('a LÁPIDE falha depois de um registro ambíguo que COMITOU: não começa, nada volta na hora; a reconciliação cobra pelo teto', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_comitado') throw new Error('a resposta do COMMIT se perdeu');
      if (ponto === 'antes_da_lapide') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'registro',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => u.status)).toEqual(['authorized']);
    expect(await reservaExiste(reserva)).toBe(true);
    expect(await contador()).toBe(1);
    // a varredura de reservas não devolve a reserva de um uso `authorized`
    await vencerReserva(reserva);
    expect(await usage.purgeExpiredReservations()).toBe(0);
    await registroComPrazoVencido();
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
    expect((await usos()).map((u) => [u.status, u.detectedBy])).toEqual([
      ['in_doubt', 'reconciliation'],
    ]);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1);
  });

  it('a LÁPIDE falha depois de um registro que NÃO comitou: não começa; a varredura de reservas devolve a reserva, uma vez', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_aberto') throw new Error('registro falhou antes do commit');
      if (ponto === 'antes_da_lapide') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'registro',
    });
    expect(visto.iniciou).toBe(false);
    expect(await usos()).toHaveLength(0);
    expect(await reservaExiste(reserva)).toBe(true); // nada volta sem a lápide
    expect(await contador()).toBe(1);
    await vencerReserva(reserva);
    expect(await usage.purgeExpiredReservations()).toBe(1);
    expect(await usage.purgeExpiredReservations()).toBe(0);
    expect(await contador()).toBe(0);
  });

  it('passo 12, registro PERDIDO (fora da premissa de durabilidade): o processo recria o uso `in_doubt` (missing_record), cobra e abre o incidente', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'desfecho') {
        await observador.query('DELETE FROM "ContentUse" WHERE "id" = $1', [contexto.useId]);
      }
    };
    const { uso, visto } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    expect(visto.iniciou).toBe(true);
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'missing_record']);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1);
    expect(origensMarcadas).toEqual([registro.id]);
    expect(await incidentes(registro.id)).toBe(1);
  });

  it('passo 12, o COMMIT comitou e o cliente viu erro: a transição condicional acha `concluded` e o resultado vale', async () => {
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_do_commit') throw new Error('a resposta do COMMIT se perdeu');
      if (ponto === 'passo_12') {
        // o que o COMMIT perdido teria deixado
        await observador.query(
          `UPDATE "ContentUse" SET "status" = 'concluded', "finishedAt" = now() WHERE "id" = $1`,
          [contexto.useId],
        );
      }
    };
    const { uso } = falso({});
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'concluido',
      valor: 'ok',
      persistido: true,
    });
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['concluded', null]);
    expect(await incidentes(registro.id)).toBe(0);
  });

  it('passo 12 sem resposta (a linha presa do outro lado de uma partição): "em dúvida" SEM marcar, e a reconciliação decide pela prova', async () => {
    const reserva = await reservar();
    const presa = new Client({ connectionString: TEST_DATABASE_URL });
    await presa.connect();
    try {
      gancho = async (ponto, contexto) => {
        if (ponto === 'antes_do_commit') throw new Error('o COMMIT falhou');
        if (ponto === 'passo_12') {
          await presa.query('BEGIN');
          await presa.query('SELECT 1 FROM "ContentUse" WHERE "id" = $1 FOR UPDATE', [
            contexto.useId,
          ]);
        }
      };
      const { uso } = falso({ reservas: [reserva] });
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
      expect((await usos()).map((u) => u.status)).toEqual(['authorized']);
      expect(await reservaExiste(reserva)).toBe(true);
    } finally {
      await presa.query('ROLLBACK').catch(() => undefined);
      await presa.end();
    }
    await registroComPrazoVencido();
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'reconciliation']);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1);
    expect(await incidentes(registro.id)).toBe(1);
  });

  it('a reconciliação pagina pelo cursor: guardas vivas com prazo vencido não escondem os órfãos de depois', async () => {
    const solta = portao();
    const vivos = [0, 1].map(() =>
      falso({
        prazoMs: 5_000,
        iniciar: async () => {
          await solta.aberto;
          return 'ok';
        },
      }),
    );
    const execucoes = vivos.map((v) => noWorkspace(() => guarda.executar(v.uso)));
    try {
      for (let i = 0; i < 300 && (await usos()).length < 2; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // os vivos vencem PRIMEIRO na ordem do cursor; o órfão vem depois
      await observador.query(
        `UPDATE "ContentUse" SET "deadlineAt" = now() - interval '1 minute' WHERE "workspaceId" = $1`,
        [ws],
      );
      const id = await orfao({});
      expect(await reconciliacao.varrer(1)).toEqual({ marcados: 1, vivos: 2, falhas: 0 });
      expect((await prisma.raw.contentUse.findFirst({ where: { id } }))?.status).toBe('in_doubt');
    } finally {
      solta.abrir();
    }
    expect((await Promise.all(execucoes)).map((r) => r.tipo)).toEqual(['concluido', 'concluido']);
  });

  it('PRAZO insuficiente antes da prova: `aborted` NA transação da guarda, sob as travas — a mudança que esperava não acha nada para marcar', async () => {
    const contato = randomUUID();
    const reserva = await reservar();
    // prazo do tipo 5 s: o que sobra entre o registro e a prova é de ~3 s, e o
    // prazo ocioso (6,5 s) não derruba a sessão parada no ponto
    let mudanca: Promise<number> | null = null;
    gancho = async (ponto, contexto) => {
      if (ponto !== 'registro_comitado') return;
      mudanca = noWorkspace(() =>
        (prisma.db as unknown as TxRunnerComOpcoes).$transaction(
          async (tx) => {
            await travarParaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
            return orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
          },
          { timeout: 20_000 },
        ),
      );
      // M espera a trava compartilhada da guarda
      for (let i = 0; i < 300; i++) {
        const { rows } = await observador.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))`,
          [contexto.pid],
        );
        if (Number(rows[0].n) > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      // consome o orçamento: passa do que pode sobrar antes da prova
      const o = orcamentoDaGuarda(CONFIG, 5_000, 2);
      await new Promise((r) => setTimeout(r, o.transacao - o.antesDaProva + 300));
    };
    const { uso, visto } = falso({ contactIds: [contato], reservas: [reserva], prazoMs: 5_000 });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'prazo',
    });
    expect(await mudanca).toBe(0);
    expect(visto.iniciou).toBe(false);
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['aborted', null]);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
    expect(await incidentes(registro.id)).toBe(0);
  });

  it('PROVA DE VIDA lenta: a segunda conferência (só pelo relógio) vê o orçamento curto e o uso vira `aborted`, sem começar', async () => {
    const reserva = await reservar();
    // prazo do tipo 5 s: a primeira conferência passa; a espera no ponto
    // simula uma prova que levou ~3,9 s, e a segunda conferência recusa
    gancho = async (ponto) => {
      if (ponto !== 'antes_da_prova') return;
      // passa do que pode sobrar DEPOIS da prova (a primeira conferência já passou)
      const o = orcamentoDaGuarda(CONFIG, 5_000, 2);
      await new Promise((r) => setTimeout(r, o.transacao - o.depoisDaProva + 300));
    };
    const { uso, visto } = falso({ reservas: [reserva], prazoMs: 5_000 });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'prazo',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => [u.status, u.detectedBy])).toEqual([['aborted', null]]);
    expect(await contador()).toBe(0);
  });

  it('`FOR SHARE` × `SKIP LOCKED`: a varredura de reservas que chega no meio do registro PULA a reserva presa, sem esperar e sem devolvê-la', async () => {
    const reserva = await reservar();
    await vencerReserva(reserva);
    let varredura: number | 'esperou' | null = null;
    gancho = async (ponto) => {
      if (ponto !== 'registro_aberto') return;
      // o INSERT está feito e a reserva presa (FOR SHARE); o COMMIT ainda não
      let timer: ReturnType<typeof setTimeout> | undefined;
      varredura = await Promise.race([
        usage.purgeExpiredReservations(),
        new Promise<'esperou'>((resolve) => {
          timer = setTimeout(() => resolve('esperou'), 300);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    const { uso } = falso({ reservas: [reserva] });
    expect((await noWorkspace(() => guarda.executar(uso))).tipo).toBe('concluido');
    expect(varredura).toBe(0); // pulou, sem esperar o registro
    expect((await usos()).map((u) => u.status)).toEqual(['concluded']);
    expect(await contador()).toBe(1); // acertada pelo real, uma vez
  });

  it('o COMMIT do `aborted` por prazo FALHA: o passo 6 grava o `aborted`, devolve as reservas e mantém o motivo', async () => {
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_comitado') {
        const o = orcamentoDaGuarda(CONFIG, 5_000, 2);
        await new Promise((r) => setTimeout(r, o.transacao - o.antesDaProva + 300));
      }
      if (ponto === 'antes_do_commit') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso, visto } = falso({ reservas: [reserva], prazoMs: 5_000 });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'prazo',
    });
    expect(visto.iniciou).toBe(false);
    expect((await usos()).map((u) => [u.status, u.detectedBy])).toEqual([['aborted', null]]);
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
  });

  it('o COMMIT do `aborted` por prazo CHEGA ao banco e o cliente vê erro: o passo 6 acha o `aborted` e responde "não começou", sem em-dúvida falso', async () => {
    gancho = async (ponto, contexto) => {
      if (ponto === 'registro_comitado') {
        const o = orcamentoDaGuarda(CONFIG, 5_000, 2);
        await new Promise((r) => setTimeout(r, o.transacao - o.antesDaProva + 300));
      }
      if (ponto === 'antes_do_commit') throw new Error('a resposta do COMMIT se perdeu');
      if (ponto === 'passo_6') {
        // o que o COMMIT perdido teria deixado
        await observador.query(
          `UPDATE "ContentUse" SET "status" = 'aborted', "finishedAt" = now() WHERE "id" = $1`,
          [contexto.useId],
        );
      }
    };
    const { uso } = falso({ prazoMs: 5_000 });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({
      tipo: 'nao_comecou',
      motivo: 'prazo',
    });
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['aborted', null]);
    expect(await incidentes(registro.id)).toBe(0);
  });

  it('`overran_deadline` com o COMMIT perdido: o passo 12 acha o `in_doubt` da própria guarda e NÃO registra conclusão tardia', async () => {
    const solta = portao();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_do_commit') throw new Error('a resposta do COMMIT se perdeu');
      if (ponto === 'passo_12') {
        await observador.query(
          `UPDATE "ContentUse" SET "status" = 'in_doubt', "detectedBy" = 'overran_deadline',
             "finishedAt" = now() WHERE "id" = $1`,
          [contexto.useId],
        );
      }
    };
    const { uso } = falso({
      prazoMs: 100,
      iniciar: async () => {
        await solta.aberto; // ignora o sinal
        return 'tarde';
      },
    });
    try {
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    } finally {
      solta.abrir();
    }
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
    expect(registro.lateAttemptAt).toBeNull();
    expect(await incidentes(registro.id, 'content_use.late_conclusion')).toBe(0);
  });

  it('`overran_deadline` com a guarda PERDIDA antes de marcar, e M marcando primeiro: em dúvida, sem conclusão tardia falsa', async () => {
    const contato = randomUUID();
    const solta = portao();
    gancho = async (ponto, contexto) => {
      if (ponto !== 'desfecho') return;
      // a chamada passou do prazo; a sessão da guarda cai, e M marca o órfão
      await derrubar(contexto.pid);
      await esperarDerrubada(contexto.pid);
      await noWorkspace(() =>
        (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
          await travarParaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
          await orfaos.marcarOrfaosDaMudanca(tx, { workspaceId: ws, contactIds: [contato] });
        }),
      );
    };
    const { uso } = falso({
      contactIds: [contato],
      prazoMs: 100,
      iniciar: async () => {
        await solta.aberto; // ignora o sinal
        return 'tarde';
      },
    });
    try {
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    } finally {
      solta.abrir();
    }
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'change']);
    expect(registro.lateAttemptAt).toBeNull();
    expect(await incidentes(registro.id, 'content_use.late_conclusion')).toBe(0);
    expect(await incidentes(registro.id)).toBe(1);
  });

  it('`overran_deadline` com o COMMIT que NÃO chegou: o passo 12 marca com o mesmo detector', async () => {
    const solta = portao();
    const reserva = await reservar();
    gancho = async (ponto, contexto) => {
      if (ponto === 'antes_do_commit') {
        await derrubar(contexto.pid);
        await esperarDerrubada(contexto.pid);
      }
    };
    const { uso } = falso({
      reservas: [reserva],
      prazoMs: 100,
      iniciar: async () => {
        await solta.aberto;
        return 'tarde';
      },
    });
    try {
      expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    } finally {
      solta.abrir();
    }
    const [registro] = await usos();
    expect([registro.status, registro.detectedBy]).toEqual(['in_doubt', 'overran_deadline']);
    expect(registro.lateAttemptAt).toBeNull();
    expect(await incidentes(registro.id)).toBe(1);
    expect(await contador()).toBe(1);
    expect(await reservaExiste(reserva)).toBe(false);
  });

  it('passo 12 que FALHA por outro motivo (pool cheio, banco fora): "em dúvida" sem lançar, e a reconciliação decide', async () => {
    const reserva = await reservar();
    gancho = (ponto) => {
      if (ponto === 'antes_do_commit') throw new Error('o COMMIT falhou');
      if (ponto === 'passo_12') throw new Error('o pool principal não responde');
    };
    const { uso } = falso({ reservas: [reserva] });
    expect(await noWorkspace(() => guarda.executar(uso))).toEqual({ tipo: 'em_duvida' });
    expect((await usos()).map((u) => u.status)).toEqual(['authorized']);
    await registroComPrazoVencido();
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(1);
  });

  it('reconciliação: um candidato com a linha PRESA além do prazo falha sozinho, e o órfão seguinte é marcado', async () => {
    const preso = await orfao({});
    const seguinte = await orfao({});
    await observador.query(
      `UPDATE "ContentUse" SET "deadlineAt" = now() - interval '1 minute' WHERE "id" = $1`,
      [preso],
    );
    const presa = new Client({ connectionString: TEST_DATABASE_URL });
    await presa.connect();
    try {
      await presa.query('BEGIN');
      await presa.query('SELECT 1 FROM "ContentUse" WHERE "id" = $1 FOR UPDATE', [preso]);
      expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 1 });
    } finally {
      await presa.query('ROLLBACK').catch(() => undefined);
      await presa.end();
    }
    const status = async (id: string) =>
      (await prisma.raw.contentUse.findFirst({ where: { id } }))?.status;
    expect([await status(preso), await status(seguinte)]).toEqual(['authorized', 'in_doubt']);
    // na rodada seguinte, sem a trava, ele é marcado
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 0 });
    expect(await status(preso)).toBe('in_doubt');
  });

  it('reconciliação: um tratador de origem com defeito desfaz só o candidato dele, e o órfão seguinte é marcado', async () => {
    const defeituoso = await orfao({});
    const seguinte = await orfao({});
    await observador.query(
      `UPDATE "ContentUse" SET "deadlineAt" = now() - interval '1 minute' WHERE "id" = $1`,
      [defeituoso],
    );
    origemQueFalha = defeituoso;
    expect(await reconciliacao.varrer()).toEqual({ marcados: 1, vivos: 0, falhas: 1 });
    const status = async (id: string) =>
      (await prisma.raw.contentUse.findFirst({ where: { id } }))?.status;
    // a transição, as reservas e a auditoria do defeituoso voltaram juntas
    expect([await status(defeituoso), await status(seguinte)]).toEqual(['authorized', 'in_doubt']);
    expect(await incidentes(defeituoso)).toBe(0);
    expect(origensMarcadas).toEqual([seguinte]);
  });

  it('"só ids" e a ESPECIFICAÇÃO do tipo: texto livre, chave ou valor fora da lista fechada, e tipo sem registro, recusados antes de qualquer trava', async () => {
    const reserva = await reservar();
    const comTexto = falso({ reservas: [reserva] }).uso;
    comTexto.metadadosDoRun = { capability: 'resumo da conversa com Maria' };
    await expect(noWorkspace(() => guarda.executar(comTexto))).rejects.toThrow(/metadadosDoRun/);
    // a reserva do uso recusado volta já, sem esperar a varredura
    expect(await reservaExiste(reserva)).toBe(false);
    expect(await contador()).toBe(0);
    const chaveRuim = falso({}).uso;
    chaveRuim.origem = { 'run id': randomUUID() };
    await expect(noWorkspace(() => guarda.executar(chaveRuim))).rejects.toThrow(/origem/);
    expect(await usos()).toHaveLength(0);
    // um e-mail não é identificador nem id de modelo
    const comEmail = falso({}).uso;
    comEmail.metadadosDoRun = { model: 'maria.silva@exemplo.com' };
    await expect(noWorkspace(() => guarda.executar(comEmail))).rejects.toThrow(/metadadosDoRun/);
    // um nome de uma palavra só passa no formato, mas não na lista fechada
    const comNome = falso({}).uso;
    comNome.metadadosDoRun = { capability: 'Maria' };
    await expect(noWorkspace(() => guarda.executar(comNome))).rejects.toThrow(/metadadosDoRun/);
    // chave fora da especificação do tipo
    const chaveFora = falso({}).uso;
    chaveFora.metadadosDoRun = { versao: 3 };
    await expect(noWorkspace(() => guarda.executar(chaveFora))).rejects.toThrow(/metadadosDoRun/);
    const origemFora = falso({}).uso;
    origemFora.origem = { dealId: randomUUID() };
    await expect(noWorkspace(() => guarda.executar(origemFora))).rejects.toThrow(/origem/);
    // tipo sem especificação registrada: desde a G3.3 os três tipos têm
    // registro, então a ausência é simulada na consulta da guarda
    const semRegistro = falso({}).uso;
    jest.spyOn(app.get(OrigensDosUsos), 'de').mockReturnValueOnce(undefined);
    await expect(noWorkspace(() => guarda.executar(semRegistro))).rejects.toThrow(
      /tipo sem registro/,
    );
    expect(await usos()).toHaveLength(0);
    // dentro da especificação: começa
    const valido = falso({}).uso;
    valido.metadadosDoRun = {
      capability: 'next_action',
      model: 'claude-sonnet-5',
      promptVersion: 3,
    };
    expect((await noWorkspace(() => guarda.executar(valido))).tipo).toBe('concluido');
  });

  it('o client protegido executa o modelo RECONSTRUÍDO, nunca o `text` de um objeto forjado', async () => {
    await noWorkspace(async () => {
      const forjado = {
        sql: '',
        strings: ['SELECT 1 AS vivo'],
        values: [],
        text: 'SELECT count(*)::int AS vivo FROM "Contact"',
      };
      const linhas = await prisma.db.$queryRaw<{ vivo: number }[]>(forjado as never);
      expect(linhas).toEqual([{ vivo: 1 }]);
      // um `Prisma.Sql` como valor seria emendado no texto: recusado
      const emendado = {
        strings: ["SELECT set_config('lock_timeout', ", ', true)'],
        values: [Prisma.raw("'0'); DROP TABLE x; --")],
        sql: '',
      };
      await expect(prisma.db.$queryRaw(emendado as never)).rejects.toThrow(/SQL cru/);
    });
  });

  it('o client protegido aceita SÓ os modelos de coordenação como SQL cru', async () => {
    await noWorkspace(async () => {
      await expect(prisma.db.$queryRaw(Prisma.sql`SELECT 1`)).rejects.toThrow(/SQL cru/);
      await (prisma.db as unknown as TxRunner).$transaction(async (tx) => {
        await travarParaMudanca(tx, { workspaceId: ws, contactIds: [randomUUID()] });
      });
    });
  });

  // usado só pelo tipo
  void ({} as UsoRegistrado);
});

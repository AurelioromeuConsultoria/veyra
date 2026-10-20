import type { INestApplication } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@nestjs/common';
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
import { postgresErrorCode } from '../../common/prisma-exception.filter';
import { ContactsService } from '../../contacts/contacts.service';
import {
  ContentUseGuard,
  GANCHOS_DA_GUARDA,
  type ContextoDoPonto,
  type PontoDaGuarda,
  type UsoExterno,
  type Veredito,
} from '../../content-use/content-use.guard';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../../content-use/content-use.pools';
import { MudancasDeRestricao } from '../../content-use/restriction-changes';
import { DealsService } from '../../deals/deals.service';
import { ContentRestrictionService } from '../../extensions/content-restriction';
import { IntelligenceService } from '../../intelligence/intelligence.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TasksService } from '../../tasks/tasks.service';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsPatientsService } from './clinics-patients.service';
import { ClinicsReleasesService } from './clinics-releases.service';

/**
 * G2 do ADR-047 (adendo 6 §6 e §10; adendo 7 §8): as MUDANÇAS de restrição e
 * as APROVAÇÕES na mesma primitiva de travas, contra usos falsos sob a guarda
 * real e a porta REAL do Clinics na reconferência. Determinístico: quem espera
 * quem é conferido no `pg_locks`/`pg_blocking_pids`, nunca por sono. Prazos
 * curtos, para a espera estourada caber no teste. Dados fictícios.
 */
const CONFIG: ConfigDaGuarda = {
  tamanhoDoPoolDaGuarda: 4,
  tamanhoDoPoolDeRegistro: 3,
  esperaPorSessaoMs: 3_000,
  registroConexaoMs: 1_000,
  registroInstrucaoMs: 800,
  // o uso espera a mudança até 2 s: a mudança primeiro cabe nessa janela
  travaMs: 2_000,
  reconferenciaMs: 2_000,
  reconciliacaoMs: 1_000,
  // a mudança espera o uso até 3 s e responde 55P03 (409): folga para a
  // ativação terminar o catálogo e a matriz com a bateria no mesmo banco
  mudancaTravaMs: 3_000,
  mudancaTransacaoMs: 15_000,
  workspaceTravaMs: 3_000,
  workspaceTransacaoMs: 15_000,
  prazoDaIaMs: 1_000,
  prazoDaMetaMs: 1_000,
  prazoDoWebhookMs: 1_000,
  persistenciaMs: 2_000,
  margemOciosaMs: 1_500,
  margemDoPrazoMs: 0,
  folgaDaTransacaoMs: 4_000,
};

let gancho: ((ponto: PontoDaGuarda, contexto: ContextoDoPonto) => Promise<void> | void) | null =
  null;

describe('G2 — mudanças de restrição e aprovações na primitiva de travas (ADR-047 adendos 6 e 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cls: ClsService;
  let guarda: ContentUseGuard;
  let porta: ContentRestrictionService;
  let restricao: MudancasDeRestricao;
  let observador: Client;
  let fixture: WorkspaceFixture;
  let ws: string;
  let auth: AuthContext;
  const SLUG = 'acme';

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
    cls = app.get(ClsService);
    guarda = app.get(ContentUseGuard);
    porta = app.get(ContentRestrictionService);
    restricao = app.get(MudancasDeRestricao);
    observador = new Client({ connectionString: TEST_DATABASE_URL });
    await observador.connect();
  });

  afterAll(async () => {
    await observador.end();
    await app.close();
  });

  beforeEach(async () => {
    gancho = null;
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

  /** Um portão que o teste abre quando quiser. */
  function portao() {
    let abrir!: () => void;
    const aberto = new Promise<void>((resolve) => {
      abrir = resolve;
    });
    return { aberto, abrir };
  }

  const ate = async (condicao: () => Promise<boolean>, descricao: string) => {
    for (let i = 0; i < 400; i++) {
      if (await condicao()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`não aconteceu: ${descricao}`);
  };

  /** Alguma sessão espera uma trava segurada por `pid`. */
  const alguemEspera = (pid: number | null) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))',
        [pid],
      );
      return Number(rows[0].n) > 0;
    }, `alguém esperando a sessão ${pid}`);

  /** A sessão `pid` está esperando uma trava. */
  const esperando = (pid: number | null) =>
    ate(async () => {
      const { rows } = await observador.query<{ n: number }>(
        'SELECT cardinality(pg_blocking_pids($1::int)) AS n',
        [pid],
      );
      return Number(rows[0]?.n ?? 0) > 0;
    }, `a sessão ${pid} esperando`);

  /** Há alguma trava consultiva pedida e ainda não concedida. */
  const travaConsultivaPendente = () =>
    ate(async () => {
      const { rows } = await observador.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
      );
      return Number(rows[0].n) > 0;
    }, 'uma trava consultiva pedida e não concedida');

  // ── dados fictícios ───────────────────────────────────────────────────────

  const contato = async (nome = 'Contato fictício') =>
    (await prisma.raw.contact.create({ data: { workspaceId: ws, name: nome } })).id;

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

  const tarefa = async (contactId: string | null, dealId: string | null = null) =>
    (
      await prisma.raw.task.create({
        data: { workspaceId: ws, title: 'Tarefa fictícia', contactId, dealId },
      })
    ).id;

  const ativarClinics = () => app.get(ClinicsActivationService).enable(SLUG);
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

  const usos = () =>
    prisma.raw.contentUse.findMany({
      where: { workspaceId: ws },
      orderBy: { authorizedAt: 'asc' },
    });

  /** Um uso `authorized` órfão: o processo morreu depois do registro. */
  const orfao = async (escopo: { contactIds?: string[]; entityKeys?: string[] }) => {
    const id = randomUUID();
    await observador.query(
      `INSERT INTO "ContentUse" ("id","workspaceId","kind","status","contactIds","entityKeys",
         "origin","reservationIds","instanceId","deadlineAt")
       VALUES ($1, $2, 'ai_generation', 'authorized', $3::uuid[], $4::text[], '{}'::jsonb, '{}',
         'morto', now() + interval '1 hour')`,
      [id, ws, escopo.contactIds ?? [], escopo.entityKeys ?? []],
    );
    return id;
  };
  const statusDo = async (id: string) => {
    const uso = await prisma.raw.contentUse.findFirst({ where: { id } });
    return [uso?.status, uso?.detectedBy];
  };

  /**
   * Um uso falso sob a guarda real. A reconferência pergunta à porta REAL do
   * Clinics pelos contatos de AGORA (`contatos()`), como o webhook fará na G3;
   * a chamada fica presa até o teste soltar.
   */
  function usoFalso(
    contatos: () => Promise<string[]> | string[],
    opcoes: { entityKeys?: string[]; contatosDoRegistro?: string[] } = {},
  ) {
    const iniciou = portao();
    const solta = portao();
    const visto = { pid: null as number | null, chamou: false };
    gancho = (ponto, contexto) => {
      if (ponto === 'sessao') visto.pid = contexto.pid;
    };
    const uso: UsoExterno<string, string> = {
      workspaceId: ws,
      kind: 'ai_generation',
      contactIds: opcoes.contatosDoRegistro ?? [],
      entityKeys: opcoes.entityKeys,
      prazoMs: 5_000,
      origem: { runId: randomUUID() },
      reservas: [],
      reconferir: async (): Promise<Veredito> => {
        const ids = await contatos();
        if (ids.length === 0) return 'liberado';
        const { restricted, unavailable } = await porta.check(ws, 'ai', ids);
        if (unavailable) return 'indisponivel';
        return restricted.some(Boolean) ? 'restrito' : 'liberado';
      },
      iniciar: async () => {
        visto.chamou = true;
        iniciou.abrir();
        await solta.aberto;
        return 'ok';
      },
      persistir: async (_tx, desfecho) => (typeof desfecho === 'string' ? desfecho : 'incerto'),
      persistenciaFalhou: async () => undefined,
    };
    return {
      uso,
      visto,
      iniciou,
      solta,
      executar: () => noWorkspace(() => guarda.executar(uso)),
    };
  }

  /**
   * Pausa a PRIMEIRA chamada da primitiva logo depois de ela pegar as travas:
   * a mudança fica aberta, segurando-as. As chamadas seguintes passam direto.
   */
  function pausarDepoisDasTravas(metodo: 'porContato' | 'doWorkspaceInteiro' | 'paraAprovacao') {
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

  /** Pausa a PRIMEIRA chamada de `validateReferences`: entre a leitura e a escrita do PATCH. */
  function pausarEntreLeituraEEscrita(servico: object) {
    const leu = portao();
    const segue = portao();
    const alvo = servico as { validateReferences: (...args: unknown[]) => Promise<unknown> };
    const real = alvo.validateReferences.bind(servico);
    let primeira = true;
    jest.spyOn(alvo, 'validateReferences').mockImplementation(async (...args: unknown[]) => {
      if (primeira) {
        primeira = false;
        leu.abrir();
        await segue.aberto;
      }
      return real(...args);
    });
    return { leu, segue };
  }

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

  // ── 1. uso primeiro ───────────────────────────────────────────────────────

  describe('USO PRIMEIRO: a mudança espera o uso terminar; o uso termina `concluded` e a mudança comita depois', () => {
    const casos: [
      string,
      () => Promise<{
        escopo: { contactIds: string[]; entityKeys?: string[] };
        mudar: () => Promise<unknown>;
      }>,
    ][] = [
      [
        'revogar a liberação',
        async () => {
          const c = await contato();
          await liberar(c);
          return { escopo: { contactIds: [c] }, mudar: () => revogar(c) };
        },
      ],
      [
        'tornar paciente',
        async () => {
          const c = await contato();
          await liberar(c);
          return { escopo: { contactIds: [c] }, mudar: () => tornarPaciente(c) };
        },
      ],
      [
        'excluir o contato',
        async () => {
          const c = await contato();
          await liberar(c);
          return { escopo: { contactIds: [c] }, mudar: () => excluirContato(c) };
        },
      ],
      [
        'trocar o contato do deal (webhook do deal, sem contato no escopo)',
        async () => {
          const c = await contato();
          const outro = await contato('Outro');
          await liberar(c);
          const d = await deal(c);
          return {
            escopo: { contactIds: [], entityKeys: [`deal:${d}`] },
            mudar: () => trocarContatoDoDeal(d, outro),
          };
        },
      ],
      [
        'trocar o contato da tarefa',
        async () => {
          const c = await contato();
          const outro = await contato('Outro');
          await liberar(c);
          const t = await tarefa(c);
          return {
            escopo: { contactIds: [c], entityKeys: [`task:${t}`] },
            mudar: () => trocarTarefa(t, { contactId: outro }),
          };
        },
      ],
      [
        'trocar o deal da tarefa (o contato do deal antigo)',
        async () => {
          const c = await contato();
          const outro = await contato('Outro');
          await liberar(c);
          const d1 = await deal(c);
          const d2 = await deal(outro);
          const t = await tarefa(null, d1);
          return {
            escopo: { contactIds: [c] },
            mudar: () => trocarTarefa(t, { dealId: d2 }),
          };
        },
      ],
      [
        'desativar o Clinics (o workspace inteiro)',
        async () => {
          const c = await contato();
          await liberar(c);
          return {
            escopo: { contactIds: [c] },
            mudar: () => app.get(ClinicsActivationService).disable(SLUG),
          };
        },
      ],
    ];

    it.each(casos)('%s', async (_nome, preparar) => {
      await ativarClinics();
      const { escopo, mudar } = await preparar();
      const u = usoFalso(() => escopo.contactIds, {
        contatosDoRegistro: escopo.contactIds,
        entityKeys: escopo.entityKeys,
      });
      const execucao = u.executar();
      let mudanca: ReturnType<typeof capturar> | undefined;
      try {
        await u.iniciou.aberto; // a chamada começou, sob as travas
        mudanca = capturar(mudar());
        await alguemEspera(u.visto.pid);
        expect(mudanca.estado.terminou).toBe(false);
      } finally {
        u.solta.abrir();
      }
      expect((await execucao).tipo).toBe('concluido');
      await mudanca?.p;
      expect(mudanca?.estado.erro).toBeNull();
      expect((await usos()).map((x) => [x.status, x.detectedBy])).toEqual([['concluded', null]]);
    });
  });

  // ── 2. mudança primeiro ───────────────────────────────────────────────────

  describe('MUDANÇA PRIMEIRO: o uso espera a mudança e, depois do commit, recusa sem chamar', () => {
    it.each([
      ['revogar a liberação', (c: string) => revogar(c)],
      ['tornar paciente', (c: string) => tornarPaciente(c)],
      ['excluir o contato', (c: string) => excluirContato(c)],
    ])('%s', async (_nome, mudar) => {
      await ativarClinics();
      const c = await contato();
      await liberar(c);
      const pausa = pausarDepoisDasTravas('porContato');
      const mudanca = capturar(mudar(c) as Promise<unknown>);
      await pausa.travou.aberto; // a mudança segura a trava exclusiva do contato
      const u = usoFalso(() => [c], { contatosDoRegistro: [c] });
      const execucao = u.executar();
      try {
        await ate(async () => u.visto.pid !== null, 'sessão da guarda');
        await esperando(u.visto.pid);
      } finally {
        pausa.segue.abrir();
      }
      await mudanca.p;
      expect(mudanca.estado.erro).toBeNull();
      expect(await execucao).toEqual({ tipo: 'nao_comecou', motivo: 'restrito' });
      expect(u.visto.chamou).toBe(false);
      expect(await usos()).toHaveLength(0);
    });

    it('trocar o contato do deal: o webhook do deal espera, relê o contato de agora e recusa', async () => {
      await ativarClinics();
      const c = await contato();
      const restrito = await contato('Restrito');
      await liberar(c);
      const d = await deal(c);
      const contatoDoDeal = async () => {
        const linha = await prisma.raw.deal.findFirst({ where: { id: d } });
        return linha?.contactId ? [linha.contactId] : [];
      };
      const pausa = pausarDepoisDasTravas('porContato');
      const mudanca = capturar(trocarContatoDoDeal(d, restrito));
      await pausa.travou.aberto;
      const u = usoFalso(contatoDoDeal, { entityKeys: [`deal:${d}`] });
      const execucao = u.executar();
      try {
        await ate(async () => u.visto.pid !== null, 'sessão da guarda');
        await esperando(u.visto.pid);
      } finally {
        pausa.segue.abrir();
      }
      await mudanca.p;
      expect(mudanca.estado.erro).toBeNull();
      expect(await execucao).toEqual({ tipo: 'nao_comecou', motivo: 'restrito' });
      expect(u.visto.chamou).toBe(false);
    });

    it('ativar o Clinics: o uso do workspace espera a ativação e, depois, recusa', async () => {
      const c = await contato(); // sem Clinics, nada é restrito
      const pausa = pausarDepoisDasTravas('doWorkspaceInteiro');
      const ativacao = capturar(ativarClinics());
      await pausa.travou.aberto;
      const u = usoFalso(() => [c], { contatosDoRegistro: [c] });
      const execucao = u.executar();
      try {
        await ate(async () => u.visto.pid !== null, 'sessão da guarda');
        await esperando(u.visto.pid);
      } finally {
        pausa.segue.abrir();
      }
      await ativacao.p;
      expect(ativacao.estado.erro).toBeNull();
      expect(await execucao).toEqual({ tipo: 'nao_comecou', motivo: 'restrito' });
      expect(u.visto.chamou).toBe(false);
    });
  });

  // ── 3. órfãos marcados pela mudança ───────────────────────────────────────

  describe('a mudança marca os usos ÓRFÃOS na mesma transação (adendo 7 §3.3)', () => {
    it('revogar, tornar paciente e excluir contato marcam o órfão do contato (`change`); o de outro contato fica', async () => {
      await ativarClinics();
      for (const mudar of [revogar, tornarPaciente, excluirContato]) {
        const c = await contato();
        await liberar(c);
        const doContato = await orfao({ contactIds: [c] });
        const deOutro = await orfao({ contactIds: [randomUUID()] });
        await mudar(c);
        expect([await statusDo(doContato), await statusDo(deOutro)]).toEqual([
          ['in_doubt', 'change'],
          ['authorized', null],
        ]);
        await prisma.raw.contentUse.deleteMany({ where: { id: deOutro } });
      }
    });

    it('trocar o contato do deal marca o órfão pela ENTIDADE, mesmo sem contato no uso', async () => {
      const c = await contato();
      const d = await deal(c);
      const pelaEntidade = await orfao({ entityKeys: [`deal:${d}`] });
      await trocarContatoDoDeal(d, await contato('Outro'));
      expect(await statusDo(pelaEntidade)).toEqual(['in_doubt', 'change']);
    });

    it('desativar marca todo órfão do workspace (`workspace_change`)', async () => {
      await ativarClinics();
      const um = await orfao({ contactIds: [randomUUID()] });
      const outro = await orfao({ entityKeys: [`task:${randomUUID()}`] });
      await app.get(ClinicsActivationService).disable(SLUG);
      expect([await statusDo(um), await statusDo(outro)]).toEqual([
        ['in_doubt', 'workspace_change'],
        ['in_doubt', 'workspace_change'],
      ]);
    });
  });

  // ── 4. espera estourada ───────────────────────────────────────────────────

  describe('a ESPERA estourada não muda nada', () => {
    it('revogar com um uso em andamento além do prazo: 55P03 (409 na rota) e a liberação continua', async () => {
      await ativarClinics();
      const c = await contato();
      await liberar(c);
      const u = usoFalso(() => [c], { contatosDoRegistro: [c] });
      const execucao = u.executar();
      try {
        await u.iniciou.aberto;
        const erro = await revogar(c).then(
          () => null,
          (e: unknown) => e,
        );
        expect(postgresErrorCode(erro)).toBe('55P03');
        expect(await prisma.raw.clinicsContactRelease.count({ where: { contactId: c } })).toBe(1);
      } finally {
        u.solta.abrir();
      }
      expect((await execucao).tipo).toBe('concluido');
    });

    it('desativar com um uso em andamento além do prazo: mensagem clara na CLI e o Clinics continua ativo', async () => {
      await ativarClinics();
      const c = await contato();
      await liberar(c);
      const u = usoFalso(() => [c], { contatosDoRegistro: [c] });
      const execucao = u.executar();
      try {
        await u.iniciou.aberto;
        const erro = await app
          .get(ClinicsActivationService)
          .disable(SLUG)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(erro).toBeInstanceOf(ConflictException);
        expect((erro as ConflictException).message).toMatch(/Nada mudou/);
        expect(
          (await prisma.raw.clinicsSettings.findFirst({ where: { workspaceId: ws } }))?.status,
        ).toBe('active');
      } finally {
        u.solta.abrir();
      }
      expect((await execucao).tipo).toBe('concluido');
    });
  });

  // ── 5. aprovação × ativação (adendo 6 §10.7) ──────────────────────────────

  describe('APROVAÇÃO × ATIVAÇÃO', () => {
    const propostaDeTarefa = async (contactId: string) => {
      const run = await prisma.raw.aiRun.create({
        data: {
          workspaceId: ws,
          capability: 'next_action',
          model: 'claude-sonnet-5',
          contextSummary: 'contact:seed; sinais determinísticos',
          status: 'ok',
          action: 'proposed',
        },
      });
      return (
        await prisma.raw.aiProposal.create({
          data: {
            workspaceId: ws,
            runId: run.id,
            type: 'create_task',
            payload: { title: 'Retornar', dueAt: new Date().toISOString(), contactId },
            rationale: 'Semeada para o teste',
            contactId,
            expiresAt: new Date(Date.now() + 60 * 60_000),
          },
        })
      ).id;
    };
    const aprovar = (id: string) =>
      noWorkspace(() => app.get(IntelligenceService).approveProposal(auth, id));

    it('a ATIVAÇÃO primeiro: a aprovação espera, reconfere e recusa — a tarefa não nasce', async () => {
      const c = await contato();
      const proposta = await propostaDeTarefa(c);
      const pausa = pausarDepoisDasTravas('doWorkspaceInteiro');
      const ativacao = capturar(ativarClinics());
      await pausa.travou.aberto;
      const aprovacao = capturar(aprovar(proposta));
      try {
        await travaConsultivaPendente(); // a aprovação espera a trava do workspace
        expect(aprovacao.estado.terminou).toBe(false);
      } finally {
        pausa.segue.abrir();
      }
      await ativacao.p;
      expect(ativacao.estado.erro).toBeNull();
      await aprovacao.p;
      expect((aprovacao.estado.erro as Error | null)?.message).toMatch(/restrito/);
      expect(await prisma.raw.task.count({ where: { workspaceId: ws } })).toBe(0);
    });

    it('a APROVAÇÃO primeiro: a ativação espera a tarefa nascer e só então comita', async () => {
      const c = await contato();
      const proposta = await propostaDeTarefa(c);
      const pausa = pausarDepoisDasTravas('paraAprovacao');
      const aprovacao = capturar(aprovar(proposta));
      await pausa.travou.aberto;
      const ativacao = capturar(ativarClinics());
      try {
        await travaConsultivaPendente(); // a ativação espera a aprovação
        expect(ativacao.estado.terminou).toBe(false);
      } finally {
        pausa.segue.abrir();
      }
      await aprovacao.p;
      expect(aprovacao.estado.erro).toBeNull();
      await ativacao.p;
      expect(ativacao.estado.erro).toBeNull();
      expect(await prisma.raw.task.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it('duas aprovações do MESMO contato não se esperam (compartilhadas); o claim impede a dupla execução', async () => {
      const c = await contato();
      const proposta = await propostaDeTarefa(c);
      const pausa = pausarDepoisDasTravas('paraAprovacao');
      const primeira = capturar(aprovar(proposta));
      await pausa.travou.aberto;
      // a segunda passa direto pelas travas (a pausa é só da primeira)
      const segunda = await aprovar(proposta).then(
        () => null,
        (e: unknown) => e,
      );
      pausa.segue.abrir();
      await primeira.p;
      // a segunda pegou as travas SEM esperar a primeira (pausada segurando as
      // dela) e venceu o claim; a primeira, ao seguir, perdeu-o
      expect(segunda).toBeNull();
      expect((primeira.estado.erro as Error | null)?.message).toBe('Proposta já revisada');
      expect(await prisma.raw.task.count({ where: { workspaceId: ws } })).toBe(1);
    });
  });

  // ── 6. troca concorrente da mesma entidade ────────────────────────────────

  it('troca de contato do deal que mudou entre a leitura e as travas: 409, sem efeito', async () => {
    const c = await contato();
    const d = await deal(c);
    const pausa = pausarDepoisDasTravas('porContato');
    const primeira = capturar(trocarContatoDoDeal(d, await contato('B')));
    await pausa.travou.aberto;
    const segunda = capturar(trocarContatoDoDeal(d, await contato('C')));
    try {
      await travaConsultivaPendente(); // a segunda espera a trava do deal
    } finally {
      pausa.segue.abrir();
    }
    await primeira.p;
    await segunda.p;
    expect(primeira.estado.erro).toBeNull();
    expect(segunda.estado.erro).toBeInstanceOf(ConflictException);
  });

  it('troca do deal da tarefa enquanto o contato do deal antigo muda: a releitura sob as travas vê e responde 409', async () => {
    const a = await contato('A');
    const x = await contato('X');
    const y = await contato('Y');
    const d1 = await deal(a);
    const d2 = await deal(y);
    const t = await tarefa(null, d1);
    const pausa = pausarDepoisDasTravas('porContato'); // a troca de contato do deal
    const trocaDoDeal = capturar(trocarContatoDoDeal(d1, x));
    await pausa.travou.aberto;
    // a tarefa resolve o contato de D1 ANTES das travas (ainda A) e espera A
    const trocaDaTarefa = capturar(trocarTarefa(t, { dealId: d2 }));
    try {
      await travaConsultivaPendente();
    } finally {
      pausa.segue.abrir();
    }
    await trocaDoDeal.p;
    await trocaDaTarefa.p;
    expect(trocaDoDeal.estado.erro).toBeNull();
    expect(trocaDaTarefa.estado.erro).toBeInstanceOf(ConflictException);
    expect((await prisma.raw.task.findFirst({ where: { id: t } }))?.dealId).toBe(d1);
  });

  describe('só o PROTOCOLO grava o titular: um PATCH com a leitura velha não desfaz uma troca', () => {
    it('deal: o formulário reenvia o contato antigo enquanto outra troca comita — a troca fica', async () => {
      const a = await contato('A');
      const b = await contato('B');
      const d = await deal(a);
      const pausa = pausarEntreLeituraEEscrita(app.get(DealsService));
      // leu o deal com A e para antes de gravar (o formulário sempre envia o contato)
      const velho = capturar(
        noWorkspace(() =>
          app.get(DealsService).update(auth, d, { title: 'Título novo', contactId: a }),
        ),
      );
      await pausa.leu.aberto;
      await trocarContatoDoDeal(d, b); // A → B pelo protocolo, inteira
      pausa.segue.abrir();
      await velho.p;
      expect(velho.estado.erro).toBeNull();
      const final = await prisma.raw.deal.findFirst({ where: { id: d } });
      expect([final?.contactId, final?.title]).toEqual([b, 'Título novo']);
    });

    it('tarefa: o contato e o deal repetidos de uma leitura velha não desfazem a troca', async () => {
      const a = await contato('A');
      const b = await contato('B');
      const d = await deal(null);
      const t = await tarefa(a, d);
      const pausa = pausarEntreLeituraEEscrita(app.get(TasksService));
      const velho = capturar(
        noWorkspace(() =>
          app.get(TasksService).update(auth, t, { title: 'Novo', contactId: a, dealId: d }),
        ),
      );
      await pausa.leu.aberto;
      await trocarTarefa(t, { contactId: b });
      pausa.segue.abrir();
      await velho.p;
      expect(velho.estado.erro).toBeNull();
      const final = await prisma.raw.task.findFirst({ where: { id: t } });
      expect([final?.contactId, final?.title]).toEqual([b, 'Novo']);
    });
  });

  // ── 7. ordem global: concorrência sem deadlock (adendo 6 §10.9) ───────────

  it('fumaça: mudança por contato, ativação, aprovação, troca de tarefa e uso concorrentes terminam, sem deadlock, cada um com um desfecho previsto', async () => {
    await ativarClinics();
    const c1 = await contato('Um');
    const c2 = await contato('Dois');
    await liberar(c1);
    await liberar(c2);
    const proposta = await (async () => {
      const run = await prisma.raw.aiRun.create({
        data: {
          workspaceId: ws,
          capability: 'next_action',
          model: 'claude-sonnet-5',
          contextSummary: 'contact:seed',
          status: 'ok',
          action: 'proposed',
        },
      });
      return (
        await prisma.raw.aiProposal.create({
          data: {
            workspaceId: ws,
            runId: run.id,
            type: 'create_task',
            payload: { title: 'Retornar', dueAt: new Date().toISOString(), contactId: c2 },
            rationale: 'Semeada',
            contactId: c2,
            expiresAt: new Date(Date.now() + 60 * 60_000),
          },
        })
      ).id;
    })();
    const u = usoFalso(() => [c1, c2], { contatosDoRegistro: [c2, c1] });
    setTimeout(() => u.solta.abrir(), 150);
    const resultados = await Promise.allSettled([
      u.executar(),
      revogar(c1),
      noWorkspace(() => app.get(IntelligenceService).approveProposal(auth, proposta)),
      app.get(ClinicsActivationService).disable(SLUG),
      trocarTarefa(await tarefa(c2), { contactId: c1 }),
    ]);
    const deadlocks = resultados.filter(
      (r) => r.status === 'rejected' && postgresErrorCode(r.reason) === '40P01',
    );
    expect(deadlocks).toEqual([]);
    // o uso termina; as recusas possíveis são as do protocolo: espera estourada
    // (55P03/409), conteúdo restrito ou proposta já revisada (400)
    const [uso, ...mudancas] = resultados;
    expect(uso.status).toBe('fulfilled');
    expect(['concluido', 'nao_comecou']).toContain(
      (uso as PromiseFulfilledResult<{ tipo: string }>).value.tipo,
    );
    for (const r of mudancas) {
      if (r.status === 'fulfilled') continue;
      const previsto =
        postgresErrorCode(r.reason) === '55P03' ||
        r.reason instanceof ConflictException ||
        r.reason instanceof BadRequestException;
      expect({ previsto, erro: (r.reason as Error)?.name }).toEqual({
        previsto: true,
        erro: (r.reason as Error)?.name,
      });
    }
    // nada fica preso: nenhum uso `authorized` sobra
    expect((await usos()).filter((x) => x.status === 'authorized')).toEqual([]);
  });
});

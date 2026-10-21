import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { COORDENACAO } from './coordination-sql';
import { ID_DA_INSTANCIA, PoolsDaGuarda, type ConfigDaGuarda } from './content-use.pools';
import {
  OrigensDosUsos,
  UsosOrfaos,
  type EspecificacaoDoUso,
  type TipoDeUso,
  type UsoRegistrado,
} from './content-use.orphans';
import { prazoDeTrava, tentarTravaDoUso, travarParaUso } from './restriction-locks';

export type Veredito = 'liberado' | 'restrito' | 'indisponivel';

/** A chamada começou e não se sabe se o conteúdo chegou ao destino. */
export interface DesfechoIncerto {
  incerto: true;
  erro: unknown;
}

export function ehIncerto(desfecho: unknown): desfecho is DesfechoIncerto {
  return (desfecho as { incerto?: unknown } | null)?.incerto === true;
}

/**
 * Um uso externo de conteúdo de contato (ADR-047 adendos 6 e 7): a chamada ao
 * provedor de IA, o envio de mensagem da IA ou a entrega de um webhook.
 */
export interface UsoExterno<D, R> {
  workspaceId: string;
  kind: TipoDeUso;
  /** o conjunto de travas — vale mesmo vazio (webhook sem contato) */
  contactIds: readonly string[];
  /** 'deal:<uuid>' ou 'task:<uuid>' */
  entityKeys?: readonly string[];
  /** prazo ABSOLUTO do tipo (60 s IA, 20 s Meta, 10 s webhook) */
  prazoMs: number;
  /** ids do registro de origem: pré-gerados (run, entrega) ou o despacho que já existe */
  origem: Record<string, string | null>;
  /** reservas de quota do uso: devolvidas se não começou, cobradas pelo teto se incerto */
  reservas: readonly string[];
  /** IA: o mínimo para criar o run se o processo morrer — só ids e descrições curtas */
  metadadosDoRun?: Record<string, string | number | boolean | null> | null;
  /** reconfere a porta, DEPOIS das travas — consulta nova; recebe a transação da guarda */
  reconferir(tx: Db): Promise<Veredito>;
  /** a chamada externa; `signal` aborta no prazo absoluto */
  iniciar(signal: AbortSignal): Promise<D>;
  /** persiste o desfecho NA transação da guarda (e acerta a reserva pelo real) */
  persistir(tx: Db, desfecho: D | DesfechoIncerto): Promise<R>;
  /**
   * A persistência falhou e a transação voltou ao `SAVEPOINT`: deixar o
   * registro de origem incerto. As reservas a guarda já cobrou pelo teto.
   */
  persistenciaFalhou(tx: Db, desfecho: D | DesfechoIncerto, erro: unknown): Promise<void>;
}

export type MotivoDeNaoComecar =
  'restrito' | 'indisponivel' | 'trava' | 'sessao' | 'registro' | 'prova_de_vida' | 'prazo';

export type ResultadoDoUso<R> =
  | { tipo: 'nao_comecou'; motivo: MotivoDeNaoComecar }
  | { tipo: 'concluido'; valor: R | undefined; persistido: boolean }
  | { tipo: 'em_duvida' };

/** Pontos de teste: os testes determinísticos injetam falhas aqui. */
export type PontoDaGuarda =
  | 'sessao'
  | 'trava_do_uso'
  | 'travas'
  | 'reconferida'
  | 'registro_antes_do_insert'
  | 'registro_recusado'
  | 'registro_aberto'
  | 'registro_comitado'
  | 'antes_da_lapide'
  | 'antes_da_prova'
  | 'desfecho'
  | 'persistido'
  | 'antes_do_commit'
  | 'passo_6'
  | 'passo_12';

export interface ContextoDoPonto {
  useId: string;
  pid: number | null;
  pidDoRegistro?: number;
  /** o código do Postgres, no registro recusado */
  codigo?: string;
}

export type GanchoDaGuarda = (
  ponto: PontoDaGuarda,
  contexto: ContextoDoPonto,
) => Promise<void> | void;

export const GANCHOS_DA_GUARDA = Symbol('GANCHOS_DA_GUARDA');

type Executor = {
  $transaction<T>(
    fn: (tx: Db) => Promise<T>,
    options?: {
      isolationLevel?: Prisma.TransactionIsolationLevel;
      maxWait?: number;
      timeout?: number;
    },
  ): Promise<T>;
};

/** Não começou, e a guarda sabe por quê. */
class NaoComecou extends Error {
  constructor(readonly motivo: MotivoDeNaoComecar) {
    super(`uso externo não começou: ${motivo}`);
  }
}

/** A chamada passou do prazo e da folga sem responder: pode começar depois. */
class ChamadaPendente {
  readonly pendente = true;
}

/** `registro_incerto`: o registro falhou e não se sabe se comitou — a lápide decide. */
type Fase = 'antes' | 'registro_incerto' | 'registrado' | 'iniciado';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTIDADE = /^(deal|task):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A lápide espera um registro em andamento pelo índice único; ele vive no
 * máximo dois prazos de instrução (o servidor derruba a transação ociosa dele).
 */
function prazoDaLapide(cfg: { registroInstrucaoMs: number; travaMs: number }): number {
  return 2 * cfg.registroInstrucaoMs + cfg.travaMs;
}

/** Folga de desistência depois do prazo absoluto, quando a chamada ignora o sinal. */
export const FOLGA_DE_DESISTENCIA_MS = 1_000;

/**
 * O `statement_timeout` da guarda e da recuperação: ACIMA do `lock_timeout`.
 * Com os dois iguais, o `statement_timeout` dispara primeiro (57014), e a
 * espera de trava deixaria de ser reconhecida como trava (55P03).
 */
function prazoDeInstrucaoSobTrava(cfg: { travaMs: number }): number {
  return 2 * cfg.travaMs;
}

/**
 * O ORÇAMENTO do prazo da transação da guarda (adendo 7 §3.1), puro para o
 * teste de unidade conferir contra a soma dos limites. Até o registro: cada
 * trava espera o seu `lock_timeout`, mais a reconferência e o registro (conexão
 * e instrução). Depois, UM de dois caminhos: a lápide (a espera dela e a margem
 * da instrução), ou a prova de vida (o seu `statement_timeout`), a chamada com a
 * folga de desistência e a persistência. `antesDaProva` e `depoisDaProva` são o
 * que precisa sobrar em cada uma das duas conferências.
 */
export function orcamentoDaGuarda(
  cfg: ConfigDaGuarda,
  prazoMs: number,
  travas: number,
): { transacao: number; antesDaProva: number; depoisDaProva: number } {
  const ateORegistro =
    cfg.travaMs * travas + cfg.reconferenciaMs + cfg.registroConexaoMs + cfg.registroInstrucaoMs;
  const daLapide = prazoDaLapide(cfg) + cfg.travaMs;
  const daProva = prazoDeInstrucaoSobTrava(cfg);
  const daChamada = prazoMs + FOLGA_DE_DESISTENCIA_MS + cfg.persistenciaMs;
  return {
    transacao: ateORegistro + Math.max(daLapide, daProva + daChamada) + cfg.folgaDaTransacaoMs,
    antesDaProva: daProva + daChamada + cfg.folgaDaTransacaoMs,
    depoisDaProva: daChamada + cfg.folgaDaTransacaoMs,
  };
}

/**
 * Os prazos das transações de RECUPERAÇÃO (passos 6 e 12, e a devolução antes
 * do registro), no pool principal: a espera pela linha tem o `lock_timeout`, a
 * instrução vai além dele, e a transação cobre a instrução que esperou mais as
 * que vêm depois (leitura, reservas, origem, auditoria). Sem eles valeriam os
 * padrões do Prisma (5 s), iguais à espera de trava da produção.
 */
export function prazosDaRecuperacao(cfg: ConfigDaGuarda): {
  travaMs: number;
  instrucaoMs: number;
  maxWaitMs: number;
  timeoutMs: number;
} {
  const instrucaoMs = prazoDeInstrucaoSobTrava(cfg);
  return {
    travaMs: cfg.travaMs,
    instrucaoMs,
    maxWaitMs: cfg.esperaPorSessaoMs,
    timeoutMs: instrucaoMs + cfg.persistenciaMs + cfg.folgaDaTransacaoMs,
  };
}

const REGISTRO_SQL = `INSERT INTO "ContentUse"
  ("id", "workspaceId", "kind", "status", "contactIds", "entityKeys", "origin",
   "reservationIds", "runMetadata", "instanceId", "deadlineAt")
VALUES ($1::uuid, $2::uuid, $3::"ContentUseKind", 'authorized', $4::uuid[], $5::text[], $6::jsonb,
   $7::uuid[], $8::jsonb, $9, transaction_timestamp() + ($10 * interval '1 millisecond'))`;

/** Nome de campo: curto, sem espaço. */
const CHAVE_SIMPLES = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/**
 * Valor de texto dos metadados: identificador (versão, modelo, capacidade),
 * nunca texto livre. `/` vale (ids de modelo); `@` só como sufixo de versão
 * numérico ('modelo@2026-10'), para que um e-mail não passe.
 */
const IDENTIFICADOR = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}(@[0-9][0-9.-]{0,39})?$/;

/**
 * "Só ids", por construção (adendo 7 §3.2): contatos, reservas e origem são
 * uuids, as entidades são 'deal:<uuid>' ou 'task:<uuid>', e os metadados do run
 * são identificadores, números ou booleanos — sem espaço, então sem texto
 * livre nem e-mail. Por cima desse piso, a ESPECIFICAÇÃO do tipo (adendo 7 §9):
 * só as chaves de origem dela, e cada metadado só com o validador dele (lista
 * fechada ou formato estrito), o que barra o dado pessoal de uma palavra só.
 * Tipo sem especificação registrada não começa. O contrário é defeito do
 * consumidor.
 */
function validarUso(
  uso: UsoExterno<unknown, unknown>,
  especificacao: EspecificacaoDoUso | undefined,
): void {
  const erro = (campo: string) => new Error(`Uso externo inválido: ${campo}.`);
  // o tipo precisa estar registrado, com a especificação e o tratador de origem
  if (!especificacao) throw erro('tipo sem registro');
  if (!uso.contactIds.every((id) => UUID.test(id))) throw erro('contactIds');
  if (!(uso.entityKeys ?? []).every((chave) => ENTIDADE.test(chave))) throw erro('entityKeys');
  for (const [chave, id] of Object.entries(uso.origem)) {
    if (!CHAVE_SIMPLES.test(chave) || !(id === null || UUID.test(id))) throw erro('origem');
    if (!especificacao.origem.includes(chave)) throw erro('origem');
  }
  if (!uso.reservas.every((id) => UUID.test(id))) throw erro('reservas');
  for (const [chave, valor] of Object.entries(uso.metadadosDoRun ?? {})) {
    const valido =
      valor === null ||
      typeof valor === 'boolean' ||
      (typeof valor === 'number' && Number.isFinite(valor)) ||
      (typeof valor === 'string' && IDENTIFICADOR.test(valor));
    if (!CHAVE_SIMPLES.test(chave) || !valido) throw erro('metadadosDoRun');
    // a lista fechada do tipo: só as chaves dele, cada valor pelo validador dele
    const validador = Object.hasOwn(especificacao.metadados, chave)
      ? especificacao.metadados[chave]
      : undefined;
    if (!validador?.(valor)) throw erro('metadadosDoRun');
  }
  if (!(uso.prazoMs > 0)) throw erro('prazoMs');
}

/**
 * A GUARDA de uso externo (ADR-047 adendo 6 §3.3, adendo 7 §3.1–3.2), sob o
 * critério G′ aprovado em 2026-10-20:
 *
 * - nada começa sem o registro durável COMITADO antes da chamada; falha de
 *   registro impede o envio;
 * - a sessão da guarda segura as travas de restrição (compartilhadas) e a trava
 *   própria do uso durante toda a janela em que a chamada pode começar;
 * - a persistência e o estado final acontecem NA transação da guarda, antes de
 *   soltar as travas;
 * - com a guarda viva, o desfecho é escrito na transação dela (`aborted`,
 *   `concluded`, ou `in_doubt` se a chamada passou do prazo sem responder). Só
 *   a perda da guarda deixa o uso `authorized` depois que as travas soltam; aí
 *   o processo tenta decidir noutra conexão (passos 6 e 12) e, sem resposta,
 *   devolve "em dúvida" e deixa a decisão aos detectores, pela prova.
 */
@Injectable()
export class ContentUseGuard {
  private readonly logger = new Logger(ContentUseGuard.name);

  constructor(
    private readonly pools: PoolsDaGuarda,
    private readonly prisma: PrismaService,
    private readonly usage: UsageService,
    private readonly orfaos: UsosOrfaos,
    private readonly origens: OrigensDosUsos,
    private readonly cls: ClsService,
    @Optional() @Inject(GANCHOS_DA_GUARDA) private readonly gancho?: GanchoDaGuarda | null,
  ) {}

  async executar<D, R>(uso: UsoExterno<D, R>): Promise<ResultadoDoUso<R>> {
    if (this.cls.get('workspaceId') !== uso.workspaceId) {
      throw new Error('Guarda de uso externo: workspace do uso diverge do contexto.');
    }
    try {
      validarUso(uso, this.origens.de(uso.kind));
    } catch (erro) {
      // defeito do consumidor: nada começa, e as reservas que são ids voltam já
      // (senão só voltariam pela varredura, depois do prazo delas)
      const reservas = uso.reservas.filter((id) => UUID.test(id));
      await this.devolverReservas({ ...uso, reservas }).catch((falha: unknown) =>
        this.avisar('devolução das reservas de um uso inválido falhou', falha),
      );
      throw erro;
    }
    const cfg = this.pools.config;
    const useId = randomUUID();
    const registrado: UsoRegistrado = {
      id: useId,
      workspaceId: uso.workspaceId,
      kind: uso.kind,
      contactIds: [...new Set(uso.contactIds)].sort(),
      entityKeys: [...new Set(uso.entityKeys ?? [])].sort(),
      origin: uso.origem as Prisma.JsonValue,
      reservationIds: [...uso.reservas],
      runMetadata: (uso.metadadosDoRun ?? null) as Prisma.JsonValue | null,
    };
    const prazoDoRegistro = uso.prazoMs + cfg.margemDoPrazoMs;
    // o prazo da transação cobre TUDO desde o BEGIN (adendo 7 §3.1)
    const travas = 1 + registrado.contactIds.length + registrado.entityKeys.length;
    const orcamento = orcamentoDaGuarda(cfg, uso.prazoMs, travas);

    let fase: Fase = 'antes';
    let pid: number | null = null;
    let valor: R | undefined;
    let persistido = false;
    let semInicio: MotivoDeNaoComecar | null = null;
    let pendente = false;

    try {
      await (this.pools.guarda as unknown as Executor).$transaction(
        async (tx) => {
          const comeco = Date.now();
          await tx.$executeRaw(COORDENACAO.prazoOcioso(`${uso.prazoMs + cfg.margemOciosaMs}ms`));
          await prazoDeTrava(tx, cfg.travaMs);
          // toda instrução da guarda tem prazo (a prova de vida inclusive), acima
          // do de trava; a persistência ganha o seu adiante
          await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${prazoDeInstrucaoSobTrava(cfg)}ms`));
          const [sessao] = await tx.$queryRaw<{ pid: number }[]>(COORDENACAO.pidDaSessao());
          pid = sessao?.pid ?? null;
          await this.ponto('sessao', { useId, pid });

          // a trava própria do uso, TENTADA também aqui: o id é novo, então na
          // prática sempre sai; uma colisão de hash é tratada como "não começou"
          if (!(await tentarTravaDoUso(tx, useId))) throw new NaoComecou('trava');
          await this.ponto('trava_do_uso', { useId, pid });
          try {
            await travarParaUso(tx, {
              workspaceId: uso.workspaceId,
              contactIds: registrado.contactIds,
              entityKeys: registrado.entityKeys,
            });
          } catch (erro) {
            // 55P03: há uma mudança de restrição segurando a trava (57014, o
            // prazo da instrução, na mesma espera, também)
            const codigo = postgresErrorCode(erro);
            if (codigo === '55P03' || codigo === '57014') throw new NaoComecou('trava');
            throw erro;
          }
          await this.ponto('travas', { useId, pid });

          const veredito = await this.comPrazo(
            uso.reconferir(tx),
            cfg.reconferenciaMs,
            'indisponivel' as const,
          );
          if (veredito !== 'liberado') throw new NaoComecou(veredito);
          await this.ponto('reconferida', { useId, pid });
          await tx.$executeRaw(COORDENACAO.savepoint());

          // passo 5: registro durável, comitado ANTES da chamada
          if (!(await this.registrar(registrado, prazoDoRegistro, pid))) {
            // daqui até a lápide comitar, NADA de devolver reservas: se a
            // lápide falhar, o registro pode ter comitado `authorized`, e quem
            // decide é a reconciliação (cobra) ou a varredura de reservas
            // (devolve, se o registro não existir)
            fase = 'registro_incerto';
            const esperaDaLapide = prazoDaLapide(cfg);
            await prazoDeTrava(tx, esperaDaLapide);
            await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${esperaDaLapide + cfg.travaMs}ms`));
            await this.ponto('antes_da_lapide', { useId, pid });
            await this.lapide(tx, registrado, prazoDoRegistro);
            // as reservas voltam na MESMA transação da lápide
            for (const reserva of uso.reservas) {
              await this.usage.releaseWithin(tx, uso.workspaceId, reserva);
            }
            semInicio = 'registro';
            return;
          }
          fase = 'registrado';

          // o que resta do prazo da transação basta para a prova e a chamada
          // inteira? Se não, `aborted` AQUI, ainda sob as travas: soltá-las
          // antes de escrever deixaria uma mudança achar o uso `authorized` e
          // marcá-lo em dúvida sem ele ter começado
          const resta = () => orcamento.transacao - (Date.now() - comeco);
          if (resta() < orcamento.antesDaProva) {
            // o motivo vale ANTES da escrita: se ela falhar, o passo 6 o mantém
            semInicio = 'prazo';
            await this.abortarNaGuarda(tx, uso, registrado);
            await this.ponto('antes_do_commit', { useId, pid });
            return;
          }

          // passo 6: prova de vida, sem I/O entre ela e o início
          await this.ponto('antes_da_prova', { useId, pid });
          await tx.$queryRaw(COORDENACAO.provaDeVida());
          // de novo, só pelo relógio (nenhuma instrução entre a prova e o
          // início): a prova pode ter levado até o prazo de instrução
          if (resta() < orcamento.depoisDaProva) {
            // o motivo vale ANTES da escrita: se ela falhar, o passo 6 o mantém
            semInicio = 'prazo';
            await this.abortarNaGuarda(tx, uso, registrado);
            await this.ponto('antes_do_commit', { useId, pid });
            return;
          }
          fase = 'iniciado';
          // passo 7: início
          const desfecho = await this.iniciarComPrazo(uso);
          await this.ponto('desfecho', { useId, pid });

          if (desfecho instanceof ChamadaPendente) {
            // a chamada ignorou o prazo e o sinal e AINDA está pendente: pode
            // começar depois de a restrição valer. Não é `concluded`: o uso
            // fica `in_doubt` aqui mesmo, com as reservas pelo teto, a origem
            // incerta e o incidente — e a resposta tardia é ignorada
            // vale ANTES da escrita: se ela falhar, o passo 12 marca com o
            // mesmo detector e não registra conclusão tardia
            pendente = true;
            const marcado = await this.orfaos.marcarEmDuvida(tx, registrado, 'overran_deadline');
            if (!marcado) throw new Error('Uso não estava authorized ao marcar o prazo.');
            await this.ponto('antes_do_commit', { useId, pid });
            return;
          }

          // passo 9: persistência sob o SAVEPOINT, pelo cliente da guarda
          await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${cfg.persistenciaMs}ms`));
          try {
            valor = await uso.persistir(tx, desfecho);
            persistido = true;
          } catch (erro) {
            // volta ao SAVEPOINT (que também desfaz o acerto da quota): o
            // resultado é descartado, a origem fica incerta e as reservas são
            // cobradas pelo teto — senão a varredura as devolveria
            await tx.$executeRaw(COORDENACAO.voltarAoSavepoint());
            // o ROLLBACK TO SAVEPOINT desfaz também o `SET LOCAL` do prazo
            await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${cfg.persistenciaMs}ms`));
            for (const reserva of uso.reservas) {
              await this.usage.chargeCeilingWithin(tx, uso.workspaceId, reserva);
            }
            await uso.persistenciaFalhou(tx, desfecho, erro);
          }
          await this.ponto('persistido', { useId, pid });

          // passo 10: `concluded`, por transição condicional, ainda sob as travas
          const { count } = await tx.contentUse.updateMany({
            where: { id: useId, workspaceId: uso.workspaceId, status: 'authorized' },
            data: { status: 'concluded', finishedAt: new Date() },
          });
          if (count === 0) {
            // o registro sumiu (failover fora da premissa) ou já não é desta
            // guarda: nada fica legível; o passo 12 decide
            throw new Error('Uso não estava authorized na conclusão.');
          }
          await this.ponto('antes_do_commit', { useId, pid });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: cfg.esperaPorSessaoMs,
          timeout: orcamento.transacao,
        },
      );
    } catch (erro) {
      return this.recuperar(erro, fase, pid, uso, registrado, {
        valor,
        persistido,
        semInicio,
        pendente,
      });
    }

    if (semInicio !== null) return { tipo: 'nao_comecou', motivo: semInicio };
    if (pendente) return { tipo: 'em_duvida' };
    return { tipo: 'concluido', valor, persistido };
  }

  /**
   * A reserva está listada num uso registrado? Depois do registro ela é da
   * guarda (acerto na transação dela, ou devolução se não começou) e dos
   * detectores (pelo teto). Quem a liquida por fora — as varreduras de
   * despacho — e a acha sumida não cobra de novo (adendo 7 §9, G3.2). Pelo
   * client filtrado, no contexto do workspace de quem pergunta.
   */
  async reservaDeUmUso(workspaceId: string, reservationId: string): Promise<boolean> {
    const usos = await this.prisma.db.contentUse.count({
      where: { workspaceId, reservationIds: { has: reservationId } },
    });
    return usos > 0;
  }

  /** Depois de uma falha: o destino depende de até onde a guarda chegou. */
  private async recuperar<D, R>(
    erro: unknown,
    fase: Fase,
    pid: number | null,
    uso: UsoExterno<D, R>,
    registrado: UsoRegistrado,
    decidido: {
      valor: R | undefined;
      persistido: boolean;
      /** a guarda já tinha escrito o `aborted` (prazo) quando o COMMIT falhou */
      semInicio: MotivoDeNaoComecar | null;
      /** a guarda já tinha marcado `overran_deadline` quando o COMMIT falhou */
      pendente: boolean;
    },
  ): Promise<ResultadoDoUso<R>> {
    if (fase === 'antes') {
      // nada registrado, nada começou: as reservas voltam
      await this.devolverReservas(uso);
      if (erro instanceof NaoComecou) return { tipo: 'nao_comecou', motivo: erro.motivo };
      if (pid === null) {
        // não conseguiu sessão de guarda (pool cheio, banco fora)
        this.avisar('sessão de guarda indisponível', erro);
        return { tipo: 'nao_comecou', motivo: 'sessao' };
      }
      throw erro;
    }
    if (fase === 'registro_incerto') {
      // a lápide (ou o que veio depois dela) falhou: não se devolve nada aqui
      this.avisar('lápide do uso falhou', erro);
      return { tipo: 'nao_comecou', motivo: 'registro' };
    }
    // daqui em diante o registro existe: a recuperação NUNCA lança. Sem
    // conseguir decidir (pool cheio, linha presa, prazo), a resposta é "em
    // dúvida", o uso fica `authorized` e a reconciliação decide pela prova
    try {
      if (fase === 'registrado') {
        // registrado e não iniciado, com a guarda perdida (a prova de vida
        // falhou, ou o COMMIT do `aborted` por prazo): a transição para
        // `aborted` e a devolução vão JUNTAS
        const motivo =
          decidido.semInicio ?? (erro instanceof NaoComecou ? erro.motivo : 'prova_de_vida');
        if (!(erro instanceof NaoComecou)) {
          this.avisar(
            decidido.semInicio ? 'COMMIT do aborted falhou' : 'prova de vida falhou',
            erro,
          );
        }
        await this.ponto('passo_6', { useId: registrado.id, pid });
        const destino = await this.abortarRegistrado(uso, registrado);
        return destino === 'aborted' ? { tipo: 'nao_comecou', motivo } : { tipo: 'em_duvida' };
      }
      // passo 12: começou, e o COMMIT da guarda (ou algo antes dele) falhou
      this.avisar('transação da guarda falhou depois do início', erro);
      await this.ponto('passo_12', { useId: registrado.id, pid });
      return await this.decidirDepoisDoInicio(registrado, decidido);
    } catch (falha) {
      this.avisar('recuperação sem resposta; a reconciliação decide', falha);
      return { tipo: 'em_duvida' };
    }
  }

  /**
   * Registrado e não iniciado, com a guarda VIVA (prazo insuficiente):
   * `aborted` e as reservas na transação dela, ainda sob as travas. Sob elas
   * nenhum detector marca o uso; sem a linha, o passo 6 decide fora.
   */
  private async abortarNaGuarda<D, R>(
    tx: Db,
    uso: UsoExterno<D, R>,
    registrado: UsoRegistrado,
  ): Promise<void> {
    const { count } = await tx.contentUse.updateMany({
      where: { id: registrado.id, workspaceId: registrado.workspaceId, status: 'authorized' },
      data: { status: 'aborted', finishedAt: new Date() },
    });
    if (count === 0) throw new Error('Uso não estava authorized ao abortar.');
    for (const reserva of uso.reservas) {
      await this.usage.releaseWithin(tx, uso.workspaceId, reserva);
    }
  }

  /** Uma transação de recuperação no pool principal, com os prazos explícitos. */
  private naRecuperacao<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const prazos = prazosDaRecuperacao(this.pools.config);
    return (this.prisma.db as unknown as Executor).$transaction(
      async (tx) => {
        await prazoDeTrava(tx, prazos.travaMs);
        await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${prazos.instrucaoMs}ms`));
        return fn(tx);
      },
      { maxWait: prazos.maxWaitMs, timeout: prazos.timeoutMs },
    );
  }

  /**
   * Passo 5 falhou: a LÁPIDE, pelo client filtrado. `createMany` com
   * `skipDuplicates` vira `INSERT … ON CONFLICT DO NOTHING`, que ESPERA um
   * registro ainda em andamento (o commit ambíguo) pelo índice único; depois, a
   * transição condicional fecha o registro que tenha comitado.
   */
  private async lapide(tx: Db, registrado: UsoRegistrado, prazoMs: number): Promise<void> {
    await tx.contentUse.createMany({
      data: [
        {
          id: registrado.id,
          workspaceId: registrado.workspaceId,
          kind: registrado.kind,
          status: 'aborted',
          contactIds: registrado.contactIds,
          entityKeys: registrado.entityKeys,
          origin: registrado.origin ?? {},
          reservationIds: registrado.reservationIds,
          runMetadata: registrado.runMetadata ?? Prisma.JsonNull,
          instanceId: ID_DA_INSTANCIA,
          deadlineAt: new Date(Date.now() + prazoMs),
          finishedAt: new Date(),
        },
      ],
      skipDuplicates: true,
    } as never);
    await tx.contentUse.updateMany({
      where: { id: registrado.id, workspaceId: registrado.workspaceId, status: 'authorized' },
      data: { status: 'aborted', finishedAt: new Date() },
    });
  }

  /**
   * Registrado e não iniciado: `authorized → aborted` condicional; as reservas
   * só voltam se a transição afetou a linha. Se não afetou, um detector já
   * marcou o uso `in_doubt` (e cobrou as reservas pelo teto). Com os prazos
   * da recuperação: com a linha presa por uma sessão do outro lado de uma
   * partição, a resposta é "em dúvida" e a reconciliação decide pela prova.
   */
  private async abortarRegistrado<D, R>(
    uso: UsoExterno<D, R>,
    registrado: UsoRegistrado,
  ): Promise<'aborted' | 'in_doubt'> {
    try {
      return await this.naRecuperacao(async (tx) => {
        const { count } = await tx.contentUse.updateMany({
          where: { id: registrado.id, workspaceId: uso.workspaceId, status: 'authorized' },
          data: { status: 'aborted', finishedAt: new Date() },
        });
        if (count === 0) {
          const atual = await this.orfaos.ler(tx, uso.workspaceId, registrado.id);
          // o `aborted` já está gravado: o COMMIT da guarda chegou ao banco
          // apesar do erro, e as reservas voltaram junto com ele
          if (atual?.status === 'aborted') return 'aborted';
          if (atual !== null) return 'in_doubt';
          // o registro não existe: a chamada não começou, as reservas voltam
        }
        for (const reserva of uso.reservas) {
          await this.usage.releaseWithin(tx, uso.workspaceId, reserva);
        }
        return 'aborted';
      });
    } catch (erro) {
      if (postgresErrorCode(erro) === '55P03') return 'in_doubt';
      throw erro;
    }
  }

  /**
   * Passo 12: noutra conexão, a decisão é pela TRANSIÇÃO CONDICIONAL — ela
   * espera a trava de linha de um COMMIT ainda em andamento —, não por SELECT.
   * Com os prazos da recuperação: sem a resposta, "em dúvida" sem marcar, e a
   * reconciliação decide pela trava do uso.
   */
  private async decidirDepoisDoInicio<R>(
    registrado: UsoRegistrado,
    decidido: { valor: R | undefined; persistido: boolean; pendente: boolean },
  ): Promise<ResultadoDoUso<R>> {
    const { valor, persistido, pendente } = decidido;
    try {
      return await this.naRecuperacao(async (tx) => {
        const detector = pendente ? 'overran_deadline' : 'commit';
        const marcado = await this.orfaos.marcarEmDuvida(tx, registrado, detector);
        if (marcado) return { tipo: 'em_duvida' } as const;
        const atual = await this.orfaos.ler(tx, registrado.workspaceId, registrado.id);
        if (atual === null) {
          // o registro se perdeu (fora da premissa de durabilidade)
          await tx.contentUse.create({
            data: {
              id: registrado.id,
              workspaceId: registrado.workspaceId,
              kind: registrado.kind,
              status: 'in_doubt',
              detectedBy: 'missing_record',
              contactIds: registrado.contactIds,
              entityKeys: registrado.entityKeys,
              origin: registrado.origin ?? {},
              reservationIds: registrado.reservationIds,
              runMetadata: registrado.runMetadata ?? Prisma.JsonNull,
              instanceId: ID_DA_INSTANCIA,
              deadlineAt: new Date(),
              finishedAt: new Date(),
            },
          } as never);
          await this.orfaos.depoisDeEmDuvida(tx, registrado, 'missing_record');
          return { tipo: 'em_duvida' } as const;
        }
        // o COMMIT, apesar do erro, comitou
        if (atual.status === 'concluded') return { tipo: 'concluido', valor, persistido } as const;
        // a própria guarda tinha marcado `overran_deadline` (o COMMIT chegou, ou
        // outro detector marcou antes): ela não estava concluindo, então não há
        // conclusão tardia a registrar
        if (pendente) return { tipo: 'em_duvida' } as const;
        // outro detector chegou antes: CONCLUSÃO TARDIA, indício de que a
        // chamada pode ter começado depois da restrição
        await tx.contentUse.updateMany({
          where: { id: registrado.id, workspaceId: registrado.workspaceId, status: 'in_doubt' },
          data: { lateAttemptAt: new Date() },
        });
        await this.orfaos.registrarTentativaTardia(tx, registrado);
        return { tipo: 'em_duvida' } as const;
      });
    } catch (erro) {
      if (postgresErrorCode(erro) === '55P03') return { tipo: 'em_duvida' };
      throw erro;
    }
  }

  /**
   * Passo 5: o registro numa transação PRÓPRIA do pool de registro, comitada
   * antes da chamada. Falhou ou estourou o prazo: `false`. A conexão de um
   * registro que não se sabe se comitou é DESTRUÍDA, não devolvida ao pool.
   */
  private async registrar(
    registrado: UsoRegistrado,
    prazoMs: number,
    pid: number | null,
  ): Promise<boolean> {
    const cfg = this.pools.config;
    let cliente: PoolClient;
    try {
      cliente = await this.pools.conectarRegistro();
    } catch (erro) {
      this.avisar('pool de registro indisponível', erro);
      return false;
    }
    // uma queda da conexão emprestada emite 'error': sem ouvinte, derrubaria o processo
    const aoCair = (erro: Error) => this.avisar('conexão de registro caiu', erro);
    cliente.on('error', aoCair);
    const devolver = (destruir: boolean) => {
      cliente.off('error', aoCair);
      cliente.release(destruir);
    };
    let devolvida = false;
    const devolverUmaVez = (destruir: boolean) => {
      if (devolvida) return;
      devolvida = true;
      devolver(destruir);
    };
    const operacao = (async () => {
      await cliente.query('BEGIN');
      // as reservas do uso precisam EXISTIR, e ficam presas até o commit: a
      // varredura de reservas (FOR UPDATE) não as devolve no meio do registro
      if (registrado.reservationIds.length > 0) {
        const { rowCount } = await cliente.query(
          `SELECT "id" FROM "UsageReservation"
            WHERE "workspaceId" = $1::uuid AND "id" = ANY ($2::uuid[]) FOR SHARE`,
          [registrado.workspaceId, registrado.reservationIds],
        );
        if (rowCount !== registrado.reservationIds.length) {
          throw new Error('reserva do uso não existe mais');
        }
      }
      const pidDoRegistro = (cliente as unknown as { processID?: number }).processID;
      await this.ponto('registro_antes_do_insert', { useId: registrado.id, pid, pidDoRegistro });
      await cliente
        .query(REGISTRO_SQL, [
          registrado.id,
          registrado.workspaceId,
          registrado.kind,
          registrado.contactIds,
          registrado.entityKeys,
          JSON.stringify(registrado.origin ?? {}),
          registrado.reservationIds,
          registrado.runMetadata === null ? null : JSON.stringify(registrado.runMetadata),
          ID_DA_INSTANCIA,
          prazoMs,
        ])
        .catch(async (erro: unknown) => {
          // um registro ATRASADO esbarra na lápide pelo índice único (23505)
          const codigo = (erro as { code?: string } | null)?.code;
          await this.ponto('registro_recusado', { useId: registrado.id, pid, codigo });
          throw erro;
        });
      await this.ponto('registro_aberto', { useId: registrado.id, pid, pidDoRegistro });
      await cliente.query('COMMIT');
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<never>((_, rejeitar) => {
      timer = setTimeout(() => rejeitar(new Error('prazo do registro')), cfg.registroInstrucaoMs);
    });
    try {
      await Promise.race([operacao, prazo]);
      await this.ponto('registro_comitado', { useId: registrado.id, pid });
      devolverUmaVez(false);
      return true;
    } catch (erro) {
      this.avisar('registro do uso falhou', erro);
      // abandona a conexão: ela morre quando a operação terminar ou, no máximo,
      // depois de mais um prazo de instrução (partição de rede) — e o servidor
      // derruba sozinho a transação ociosa dela
      void operacao.catch(() => undefined).finally(() => devolverUmaVez(true));
      setTimeout(() => devolverUmaVez(true), cfg.registroInstrucaoMs).unref();
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Passo 7: o início, com o prazo ABSOLUTO do tipo. O sinal aborta no prazo; se
   * a chamada não respeitar o sinal nem resolver na folga, ela continua
   * PENDENTE — e pode começar depois —, o que a guarda não trata como desfecho.
   */
  private async iniciarComPrazo<D, R>(
    uso: UsoExterno<D, R>,
  ): Promise<D | DesfechoIncerto | ChamadaPendente> {
    const controle = new AbortController();
    let timerDoPrazo: ReturnType<typeof setTimeout> | undefined;
    let timerDaFolga: ReturnType<typeof setTimeout> | undefined;
    const desistencia = new Promise<ChamadaPendente>((resolve) => {
      timerDoPrazo = setTimeout(() => {
        controle.abort(new Error('prazo absoluto do uso externo'));
        timerDaFolga = setTimeout(() => resolve(new ChamadaPendente()), FOLGA_DE_DESISTENCIA_MS);
      }, uso.prazoMs);
    });
    try {
      return await Promise.race([
        uso
          .iniciar(controle.signal)
          .catch((erro: unknown): DesfechoIncerto => ({ incerto: true, erro })),
        desistencia,
      ]);
    } finally {
      clearTimeout(timerDoPrazo);
      clearTimeout(timerDaFolga);
    }
  }

  private async comPrazo<T, F>(promessa: Promise<T>, ms: number, aoEstourar: F): Promise<T | F> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promessa,
        new Promise<F>((resolve) => {
          timer = setTimeout(() => resolve(aoEstourar), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async devolverReservas<D, R>(uso: UsoExterno<D, R>): Promise<void> {
    if (uso.reservas.length === 0) return;
    await this.naRecuperacao(async (tx) => {
      for (const reserva of uso.reservas) {
        await this.usage.releaseWithin(tx, uso.workspaceId, reserva);
      }
    });
  }

  private async ponto(ponto: PontoDaGuarda, contexto: ContextoDoPonto): Promise<void> {
    if (this.gancho) await this.gancho(ponto, contexto);
  }

  private avisar(oQue: string, erro: unknown): void {
    // só o nome e o código: a mensagem pode carregar dados
    const codigo =
      postgresErrorCode(erro) ?? (erro as { code?: string } | null)?.code ?? 'sem código';
    this.logger.warn(
      `Guarda de uso externo: ${oQue} (${erro instanceof Error ? erro.name : 'erro'}, ${codigo})`,
    );
  }
}

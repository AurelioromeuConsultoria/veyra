import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { postgresErrorCode } from '../common/prisma-exception.filter';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { COORDENACAO } from './coordination-sql';
import { UsosOrfaos, type UsoRegistrado } from './content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from './content-use.pools';
import { prazoDeTrava, tentarTravaDoUso } from './restriction-locks';

/** Retenção dos usos encerrados sem dúvida (adendo 7 §3.4). */
export const RETENCAO_DOS_USOS_DIAS = 30;

type Executor = {
  $transaction<T>(
    fn: (tx: Db) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
};

/**
 * Os prazos de cada candidato: a espera pela linha (presa por M ou por uma
 * sessão do outro lado de uma partição) tem `lock_timeout`, a instrução vai
 * além dele, e a transação cobre a que esperou mais as seguintes (reservas,
 * origem, auditoria). Puro, para o teste de unidade conferir a ordem.
 */
export function prazosDaReconciliacao(cfg: ConfigDaGuarda): {
  travaMs: number;
  instrucaoMs: number;
  timeoutMs: number;
} {
  const instrucaoMs = 2 * cfg.reconciliacaoMs;
  return {
    travaMs: cfg.reconciliacaoMs,
    instrucaoMs,
    timeoutMs: instrucaoMs + cfg.persistenciaMs + cfg.folgaDaTransacaoMs,
  };
}

/**
 * A RECONCILIAÇÃO (ADR-047 adendo 7 §3.3–3.4): acha os usos que ficaram
 * `authorized` depois que a guarda acabou — processo morto, sessão derrubada —
 * inclusive depois de reinício.
 *
 * O prazo vencido só ESCOLHE candidatos; a prova de que a guarda acabou é a
 * trava própria do uso, tentada numa transação por candidato. Não obteve: a
 * guarda está viva (congelada, persistência travada) e o uso não é tocado. Assim
 * a reconciliação nunca marca um uso vivo, com ou sem contato, nem o de outra
 * instância, e não sofre inanição: usos vivos do mesmo contato não seguram a
 * trava deste uso, e um candidato preso ou com defeito falha sozinho, dentro
 * dos prazos, sem parar os que vêm depois dele.
 */
@Injectable()
export class ReconciliacaoDosUsos {
  private readonly logger = new Logger(ReconciliacaoDosUsos.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orfaos: UsosOrfaos,
    private readonly cls: ClsService,
    @Inject(CONFIG_DA_GUARDA) private readonly config: ConfigDaGuarda,
  ) {}

  /**
   * Varre em páginas, pelo cursor (`deadlineAt`, `id`): guardas vivas com prazo
   * vencido não escondem os órfãos que vêm depois delas.
   */
  async varrer(
    porPagina = 200,
    maximo = 5_000,
  ): Promise<{ marcados: number; vivos: number; falhas: number }> {
    let marcados = 0;
    let vivos = 0;
    let falhas = 0;
    let cursor: { deadlineAt: Date; id: string } | null = null;
    for (let vistos = 0; vistos < maximo;) {
      const pagina = await this.candidatos(porPagina, cursor);
      if (pagina.length === 0) break;
      for (const candidato of pagina) {
        const destino = await this.examinar(candidato).catch((erro: unknown) => {
          // falha SÓ deste candidato (linha presa além do prazo, tratador de
          // origem com defeito): a varredura segue, e ele volta na próxima
          // rodada. Só o id do uso, o nome e o código do erro.
          const codigo =
            postgresErrorCode(erro) ?? (erro as { code?: string } | null)?.code ?? 'sem código';
          this.logger.warn(
            `Reconciliação: uso ${candidato.id} não pôde ser examinado ` +
              `(${erro instanceof Error ? erro.name : 'erro'}, ${codigo})`,
          );
          return 'falha' as const;
        });
        if (destino === 'marcado') marcados += 1;
        if (destino === 'vivo') vivos += 1;
        if (destino === 'falha') falhas += 1;
      }
      vistos += pagina.length;
      const ultimo = pagina[pagina.length - 1];
      cursor = { deadlineAt: ultimo.deadlineAt, id: ultimo.id };
      if (pagina.length < porPagina) break;
    }
    if (marcados > 0) {
      this.logger.warn(`Reconciliação: ${marcados} uso(s) externo(s) marcado(s) em dúvida`);
    }
    if (falhas > 0) {
      this.logger.warn(`Reconciliação: ${falhas} uso(s) externo(s) ficaram para a próxima rodada`);
    }
    return { marcados, vivos, falhas };
  }

  /**
   * Exceção nomeada (adendo 7 §3.8): a ÚNICA leitura sem workspace, porque a
   * busca de candidatos é cross-workspace por definição. Job cross-workspace,
   * via `raw` (§3.3 do CLAUDE.md). A comparação é com o relógio do banco
   * (ADR-049). Tudo o que vem depois é por workspace, pelo client filtrado.
   */
  private candidatos(
    limite: number,
    cursor: { deadlineAt: Date; id: string } | null,
  ): Promise<{ id: string; workspaceId: string; deadlineAt: Date }[]> {
    return cursor === null
      ? this.prisma.raw.$queryRaw`
          SELECT "id", "workspaceId", "deadlineAt" FROM "ContentUse"
           WHERE "status" = 'authorized' AND "deadlineAt" < now()
           ORDER BY "deadlineAt", "id"
           LIMIT ${limite}`
      : this.prisma.raw.$queryRaw`
          SELECT "id", "workspaceId", "deadlineAt" FROM "ContentUse"
           WHERE "status" = 'authorized' AND "deadlineAt" < now()
             AND ("deadlineAt", "id") > (${cursor.deadlineAt}, ${cursor.id}::uuid)
           ORDER BY "deadlineAt", "id"
           LIMIT ${limite}`;
  }

  /**
   * Um candidato: no workspace DELE, pelo client filtrado, numa transação
   * própria e com prazos explícitos.
   */
  private examinar(candidato: {
    id: string;
    workspaceId: string;
  }): Promise<'marcado' | 'vivo' | 'nada'> {
    const prazos = prazosDaReconciliacao(this.config);
    return this.cls.run(() => {
      this.cls.set('workspaceId', candidato.workspaceId);
      return (this.prisma.db as unknown as Executor).$transaction(
        async (tx) => {
          await prazoDeTrava(tx, prazos.travaMs);
          await tx.$executeRaw(COORDENACAO.prazoDeInstrucao(`${prazos.instrucaoMs}ms`));
          if (!(await tentarTravaDoUso(tx, candidato.id))) return 'vivo' as const;
          const uso = await this.orfaos.ler(tx, candidato.workspaceId, candidato.id);
          if (uso === null || uso.status !== 'authorized') return 'nada' as const;
          return (await this.orfaos.marcarEmDuvida(tx, uso as UsoRegistrado, 'reconciliation'))
            ? ('marcado' as const)
            : ('nada' as const);
        },
        { timeout: prazos.timeoutMs },
      );
    });
  }

  /**
   * Retenção (adendo 7 §3.4): `concluded` e `aborted` saem depois de 30 dias;
   * `in_doubt` fica pela retenção da AUDITORIA (são o lastro do incidente) e
   * depois sai também — nada guarda ids de contato para sempre. Exceção nomeada
   * (adendo 7 §3.8): expurgo cross-workspace de retenção, via `raw`. Compara o
   * `authorizedAt`, escrito pelo banco (ADR-049).
   */
  async expurgar(diasDeAuditoria: number, dias = RETENCAO_DOS_USOS_DIAS): Promise<number> {
    return this.prisma.raw.$executeRaw`
      DELETE FROM "ContentUse"
       WHERE ("status" IN ('concluded', 'aborted')
              AND "authorizedAt" < now() - make_interval(days => ${dias}::int))
          OR ("status" = 'in_doubt'
              AND "authorizedAt" < now() - make_interval(days => ${diasDeAuditoria}::int))`;
  }
}

/**
 * A varredura logo depois da subida: ASSÍNCRONA, sem bloquear o boot (que não
 * depende do banco, ADR-049). Só é chamada quando os jobs estão ligados.
 */
export function varrerNaSubida(
  varrer: () => Promise<unknown>,
  avisar: (mensagem: string) => void,
): void {
  void varrer().catch((erro: unknown) => {
    avisar(
      `Reconciliação de usos na subida falhou (${erro instanceof Error ? erro.name : 'erro'}); ` +
        'a varredura periódica tenta de novo.',
    );
  });
}

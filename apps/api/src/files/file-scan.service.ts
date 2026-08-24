import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };
import { FILE_SCANNER, type FileScanner } from './file-scanner';
import { STORAGE_DRIVER, type StorageDriver } from './storage.driver';

/** Lease da varredura: cobre leitura dos bytes e a chamada ao scanner. */
/**
 * Lease com FOLGA sobre o pior caso do lote: cinco arquivos × (ping + varredura)
 * com o prazo do scanner. Encostar no limite fazia o lease vencer com o worker
 * ainda trabalhando — outro reivindicava, o `release` do primeiro não casava o
 * token e a tentativa não voltava, empurrando o arquivo para o teto sem nenhuma
 * morte de processo. `pending` permanente pela porta dos fundos.
 */
const LEASE_MS = 15 * 60_000;
/**
 * Teto de ciclos que morrem COM O PROCESSO entre o claim e o veredito — só isso
 * incrementa de forma durável. Indisponibilidade do scanner, falha de leitura e
 * exceção contida DEVOLVEM a tentativa, senão cinco ciclos sem ClamAV deixariam
 * o arquivo `pending` para sempre, sem nunca mais ser escaneado; `pending`
 * permanente é o oposto do que o ADR-043 decide.
 *
 * Consequência assumida e registrada como dívida: falha determinística que não
 * mata o processo reprocessa a cada ciclo, e nenhum contador cresce para
 * distinguir "tentou dez mil vezes" de "nunca tentou". Um contador monotônico
 * separado (com backoff exponencial e alerta, sem tornar terminal) é o próximo
 * passo — não entra aqui para não misturar com a correção do P1.
 */
const MAX_ATTEMPTS = 5;
/** Espera antes de tentar de novo quando não houve veredito. */
const RETRY_DELAY_MS = 60_000;

interface ClaimedFile {
  id: string;
  workspaceId: string;
  key: string;
  fileName: string;
  sizeBytes: number;
  claimToken: string;
}

/**
 * Varredura de arquivos e limpeza dos bytes em quarentena (ADR-043).
 *
 * Duas rotinas idempotentes e independentes, de propósito: a que dá o VEREDITO
 * e a que remove os bytes. Separá-las é o que permite a remoção falhar sem
 * desfazer a quarentena — a linha fica `quarantined` com `bytesPurgedAt` nulo,
 * e a segunda rotina tenta de novo, sem nunca voltar o arquivo para `pending`.
 */
@Injectable()
export class FileScanService {
  private readonly logger = new Logger(FileScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {}

  /** Um ciclo de varredura: reivindica um lote de `pending` e decide cada um. */
  async scanPending(limit = 5): Promise<{ clean: number; quarantined: number }> {
    const lote = await this.claimBatch(limit);
    let clean = 0;
    let quarantined = 0;
    for (const arquivo of lote) {
      /**
       * Falha inesperada é contida POR ARQUIVO: um problema em um (auditoria
       * fora do ar, storage instável) não pode derrubar o lote inteiro nem
       * deixar o lease preso até vencer. O arquivo volta para a fila com
       * backoff, sem veredito e sem queimar tentativa.
       */
      try {
        const veredito = await this.scanOne(arquivo);
        if (veredito === 'clean') clean += 1;
        if (veredito === 'quarantined') quarantined += 1;
      } catch (error) {
        this.logger.error(
          `Varredura de ${arquivo.id} interrompida (${(error as Error).message.slice(0, 80)})`,
        );
        await this.release(arquivo, 'scan_interrupted');
      }
    }
    return { clean, quarantined };
  }

  /**
   * `raw` justificado: claim atômico cross-workspace com `RETURNING`, que o
   * client filtrado não expressa (SECURITY.md §2). O `workspaceId` de cada linha
   * é usado explicitamente adiante, dentro do CLS.
   *
   * Elegível: `pending` sem lease vivo e com tentativas restantes. O predicado é
   * REPETIDO no WHERE externo — em READ COMMITTED a subquery é reavaliada no
   * snapshot antigo, e sem isso a varredura sobrescreveria estado que outro
   * worker acabou de comitar (a mesma armadilha do ADR-039).
   */
  private async claimBatch(limit: number): Promise<ClaimedFile[]> {
    return this.prisma.raw.$queryRawUnsafe<ClaimedFile[]>(
      `UPDATE "FileObject" AS f
          SET "scanClaimToken" = gen_random_uuid(),
              "scanLeaseExpiresAt" = now() + ($2::int * interval '1 millisecond'),
              "scanAttempts" = f."scanAttempts" + 1
        WHERE f."id" IN (
                SELECT "id" FROM "FileObject"
                 WHERE "scanStatus" = 'pending'
                   AND "scanAttempts" < $3::int
                   AND ("scanLeaseExpiresAt" IS NULL OR "scanLeaseExpiresAt" < now())
                 ORDER BY "createdAt"
                 LIMIT $1
                 FOR UPDATE SKIP LOCKED
              )
          AND f."scanStatus" = 'pending'
          AND f."scanAttempts" < $3::int
          AND (f."scanLeaseExpiresAt" IS NULL OR f."scanLeaseExpiresAt" < now())
      RETURNING f."id", f."workspaceId", f."key", f."fileName",
                f."sizeBytes", f."scanClaimToken" AS "claimToken"`,
      limit,
      LEASE_MS,
      MAX_ATTEMPTS,
    );
  }

  private async scanOne(arquivo: ClaimedFile): Promise<'clean' | 'quarantined' | 'retry'> {
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(arquivo.key);
    } catch {
      // bytes ausentes: não é veredito. Solta o lease e deixa para a próxima —
      // marcar `clean` aqui liberaria para canal externo um arquivo não lido
      return this.release(arquivo, 'bytes_unreadable');
    }

    const veredito = await this.scanner.scan(bytes);
    if (veredito.status === 'unavailable') {
      /**
       * Scanner fora do ar NÃO é veredito. O arquivo continua `pending`, que já
       * não sai para canal externo — a ausência de scanner degrada para o
       * comportamento seguro, nunca para "liberado".
       */
      return this.release(arquivo, veredito.reason);
    }

    if (veredito.status === 'clean') {
      const { count } = await this.prisma.raw.fileObject.updateMany({
        // `workspaceId` explícito: a regra do projeto para todo `raw` (§3.3), e
        // o comentário três blocos abaixo a ensina — não vale contrariá-la aqui
        where: {
          workspaceId: arquivo.workspaceId,
          id: arquivo.id,
          scanClaimToken: arquivo.claimToken,
          scanStatus: 'pending',
        },
        data: {
          scanStatus: 'clean',
          scannedAt: new Date(),
          scanError: null,
          scanClaimToken: null,
          scanLeaseExpiresAt: null,
        },
      });
      return count > 0 ? 'clean' : 'retry';
    }

    return this.quarantine(arquivo, veredito.threat);
  }

  /**
   * Quarentena: TERMINAL no banco, e só depois os bytes saem do disco. A ordem
   * importa — registrar primeiro garante que nunca existe arquivo apagado com o
   * banco dizendo `pending` (ADR-043).
   */
  private async quarantine(arquivo: ClaimedFile, ameaca: string): Promise<'quarantined' | 'retry'> {
    /**
     * ESTADO E EVIDÊNCIA NA MESMA TRANSAÇÃO. Gravar o status antes e auditar
     * depois deixava uma janela em que a falha da auditoria produzia quarentena
     * SEM trilha — evidência incompleta é pior que ausente, porque parece
     * completa. Ou os dois acontecem, ou nenhum: falhando, o arquivo continua
     * `pending` e é reprocessado.
     */
    const count = await this.cls.run(async () => {
      /**
       * O CLS aqui NÃO filtra nada: a transação usa `prisma.raw`, que é o
       * cliente certo para job cross-workspace. Ele serve ao que é CLS-aware
       * adiante (requestId da auditoria, logging). Quem acrescentar query dentro
       * deste `tx` precisa levar `workspaceId` explícito — não há filtro herdado.
       */
      this.cls.set('workspaceId', arquivo.workspaceId);
      /**
       * Client FILTRADO aqui dentro: estamos no CLS do workspace da linha, e o
       * filtro mecânico vale mais que a convenção — foi a ausência dele que
       * deixou três escritas sem tenant no where. O `raw` fica onde é
       * inevitável: o claim cross-workspace.
       */
      const db = this.prisma.db as unknown as TxRunner;
      return db.$transaction(async (tx) => {
        const escrito = await tx.fileObject.updateMany({
          where: {
            workspaceId: arquivo.workspaceId,
            id: arquivo.id,
            scanClaimToken: arquivo.claimToken,
            scanStatus: 'pending',
          },
          data: {
            scanStatus: 'quarantined',
            scannedAt: new Date(),
            // nome curto da ameaça: nunca a saída bruta do scanner
            scanError: ameaca.slice(0, 120),
            scanClaimToken: null,
            scanLeaseExpiresAt: null,
          },
        });
        if (escrito.count === 0) return 0; // perdemos a posse: quem tem decide
        await this.audit.record(tx, arquivo.workspaceId, 'file.quarantined', {
          entityType: 'file',
          entityId: arquivo.id,
          actor: { type: 'system', id: 'file-scanner' },
          after: { fileName: arquivo.fileName, scanStatus: 'quarantined' },
        });
        return escrito.count;
      });
    });
    if (count === 0) return 'retry';
    this.logger.error(`Arquivo ${arquivo.id} em QUARENTENA (${ameaca.slice(0, 60)})`);

    await this.purgeBytes(arquivo.id, arquivo.key, arquivo.workspaceId, arquivo.sizeBytes);
    return 'quarantined';
  }

  /**
   * Remove os bytes e SÓ marca a limpeza com confirmação do driver. `delete` do
   * driver local usa `rm(force: true)`, que não falha quando o arquivo não
   * existe: "não lançou" nunca foi prova. Falhar aqui é estado válido — a linha
   * segue `quarantined` com `bytesPurgedAt` nulo e a varredura tenta de novo.
   */
  private async purgeBytes(
    id: string,
    key: string,
    workspaceId: string,
    sizeBytes: number,
  ): Promise<boolean> {
    try {
      await this.storage.delete(key);
      if (await this.storage.exists(key)) {
        this.logger.error(`Bytes de ${id} ainda presentes após remoção — nova tentativa depois`);
        return false;
      }
    } catch (error) {
      this.logger.error(`Falha ao remover bytes de ${id} (${(error as Error).name})`);
      return false;
    }
    /**
     * MARCA E CONTABILIDADE NA MESMA TRANSAÇÃO, depois da confirmação física.
     *
     * A ordem anterior gravava `bytesPurgedAt` e decrementava o gauge em
     * transações separadas: uma queda entre as duas tirava o arquivo da fila
     * (o job só seleciona `bytesPurgedAt IS NULL`) e o workspace pagava para
     * sempre por bytes que não existem. Agora, se a quota falha, a marca volta
     * atrás e o ciclo seguinte conclui — os bytes já foram removidos, e é a
     * CONFIRMAÇÃO de ausência, não a marca, que permite retentar sem risco.
     *
     * `storage_bytes` é gauge COBRADO: sem devolver, alguns arquivos infectados
     * consumiriam o teto do tenant sem ocupar um byte real.
     */
    /**
     * Falha de banco aqui devolve `false`, como a de storage — não sobe. Deixar
     * a exceção escapar truncava o LOTE da limpeza: um arquivo na cabeça da fila
     * falhando de forma persistente bloqueava todos os outros workspaces atrás
     * dele, com bytes de malware ficando no disco. E, na quarentena, o log saía
     * como "varredura interrompida" para um arquivo que ESTAVA em quarentena.
     */
    try {
      await this.usage.ensureCounterRow(workspaceId, 'storage_bytes');
      return await this.cls.run(async () => {
        this.cls.set('workspaceId', workspaceId);
        // filtrado: o CLS já tem o workspace da linha (mesma razão do bloco da
        // quarentena); o `workspaceId` no where fica como redundância honesta
        const db = this.prisma.db as unknown as TxRunner;
        return db.$transaction(async (tx) => {
          const { count } = await tx.fileObject.updateMany({
            // `workspaceId` explícito: `raw` do projeto sempre leva o tenant no
            // where, mesmo com a PK presente (§3.3)
            where: { workspaceId, id, scanStatus: 'quarantined', bytesPurgedAt: null },
            data: { bytesPurgedAt: new Date() },
          });
          // outro ciclo concluiu antes: quem marcou é quem devolveu
          if (count === 0) return false;
          if (sizeBytes > 0) {
            await this.usage.consumeOverLimit(tx, workspaceId, 'storage_bytes', -sizeBytes);
          }
          return true;
        });
      });
    } catch (error) {
      this.logger.error(
        `Contabilidade da limpeza de ${id} falhou (${(error as Error).name}) — bytes já removidos, ` +
          'marca não gravada, próximo ciclo conclui',
      );
      return false;
    }
  }

  /**
   * Varredura de limpeza: quarentena com bytes ainda no disco. Idempotente por
   * construção — quem já tem `bytesPurgedAt` não é selecionado, e confirmar a
   * ausência de um arquivo já removido também conclui.
   *
   * `raw` justificado: rotina cross-workspace (SECURITY.md §2).
   */
  async purgeQuarantinedBytes(limit = 20): Promise<number> {
    const pendentes = await this.prisma.raw.fileObject.findMany({
      where: { scanStatus: 'quarantined', bytesPurgedAt: null },
      select: { id: true, key: true, workspaceId: true, sizeBytes: true },
      orderBy: { scannedAt: 'asc' },
      take: limit,
    });
    let removidos = 0;
    for (const arquivo of pendentes) {
      if (await this.purgeBytes(arquivo.id, arquivo.key, arquivo.workspaceId, arquivo.sizeBytes))
        removidos += 1;
    }
    if (pendentes.length > removidos) {
      this.logger.error(
        `${pendentes.length - removidos} arquivo(s) em quarentena ainda com bytes no disco`,
      );
    }
    return removidos;
  }

  /**
   * Solta o lease SEM veredito: o arquivo continua `pending` e volta à fila.
   *
   * DEVOLVE a tentativa consumida no claim — scanner fora do ar não é culpa do
   * arquivo, e cinco ciclos sem ClamAV o excluiriam da varredura para sempre. O
   * que `scanAttempts` conta é ciclo INTERROMPIDO (processo morto antes do
   * veredito), que é o que precisa de teto.
   *
   * O adiamento usa `scanLeaseExpiresAt` no FUTURO, calculado pelo relógio do
   * BANCO — que é o mesmo que o claim compara. É o backoff: sem ele o arquivo
   * seria reivindicado no ciclo seguinte, martelando um scanner que está fora.
   */
  private async release(arquivo: ClaimedFile, motivo: string): Promise<'retry'> {
    // `raw` justificado: o adiamento tem de nascer do relógio do BANCO, que é o
    // mesmo que o claim compara — o client filtrado não expressa `now() +
    // interval`. `workspaceId` explícito, como todo `raw` do projeto (§3.3).
    await this.prisma.raw.$executeRawUnsafe(
      `UPDATE "FileObject"
          SET "scanClaimToken" = NULL,
              "scanLeaseExpiresAt" = now() + ($4::bigint * interval '1 millisecond'),
              "scanAttempts" = GREATEST("scanAttempts" - 1, 0),
              "scanError" = $5
        WHERE "workspaceId" = $1::uuid AND "id" = $2::uuid AND "scanClaimToken" = $3::uuid`,
      arquivo.workspaceId,
      arquivo.id,
      arquivo.claimToken,
      RETRY_DELAY_MS,
      motivo.slice(0, 120),
    );
    return 'retry';
  }
}

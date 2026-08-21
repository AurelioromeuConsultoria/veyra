import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { CryptoService } from '../common/crypto.service';
import { assertAllowedFile, UnsupportedFileError } from '../files/file-type';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { META_TRANSPORT, type MetaTransport } from './meta.transport';

/** Lease da coleta: cobre download + gravação com folga. */
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;

/**
 * Coleta de mídia recebida (ADR-037). Roda por VARREDURA da tabela, não por
 * evento: a referência já está no banco como fonte da verdade, e varredura é
 * auto-recuperável — evento perdido seria mídia perdida.
 *
 * O claim usa o mesmo padrão do outbox — `FOR UPDATE SKIP LOCKED` com lease e
 * fencing token — porque dois workers baixando e gravando a mesma mídia
 * produziriam dois arquivos e duas cobranças de storage.
 */
@Injectable()
export class MediaCollectorService {
  private readonly logger = new Logger(MediaCollectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly files: FilesService,
    private readonly usage: UsageService,
    private readonly cls: ClsService,
    @Inject(META_TRANSPORT) private readonly transport: MetaTransport,
  ) {}

  /** Um ciclo: reivindica um lote e coleta cada item. */
  async collectPending(limit = 10): Promise<{ collected: number; failed: number }> {
    const claimed = await this.claimBatch(limit);
    let collected = 0;
    let failed = 0;
    for (const item of claimed) {
      const ok = await this.collectOne(item);
      if (ok) collected += 1;
      else failed += 1;
    }
    return { collected, failed };
  }

  /**
   * Claim atômico com lease e fencing (mesmo desenho do outbox): elegíveis são
   * `pending` sem lease ou com lease expirado. `raw` justificado — varredura
   * cross-workspace (SECURITY.md §2).
   */
  private async claimBatch(limit: number): Promise<
    {
      id: string;
      workspaceId: string;
      messageId: string;
      providerMediaId: string;
      mimeType: string;
      fileName: string | null;
      attempts: number;
      claimToken: string;
    }[]
  > {
    return this.prisma.raw.$queryRawUnsafe(
      `UPDATE "InboundMedia"
          SET "attempts" = "attempts" + 1,
              "claimedAt" = now(),
              "leaseExpiresAt" = now() + ($2::int * interval '1 millisecond'),
              "claimToken" = gen_random_uuid()
        WHERE "id" IN (
          SELECT "id" FROM "InboundMedia"
           WHERE "state" = 'pending'
             AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
             AND "attempts" < $3
           ORDER BY "createdAt" ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
      RETURNING "id", "workspaceId", "messageId", "providerMediaId", "mimeType",
                "fileName", "attempts", "claimToken"`,
      limit,
      LEASE_MS,
      MAX_ATTEMPTS,
    );
  }

  private async collectOne(item: {
    id: string;
    workspaceId: string;
    messageId: string;
    providerMediaId: string;
    mimeType: string;
    fileName: string | null;
    attempts: number;
    claimToken: string;
  }): Promise<boolean> {
    const credential = await this.credentialFor(item.workspaceId, item.messageId);
    if (!credential) return this.fail(item, 'no_credential');

    const outcome = await this.transport.fetchMedia(
      {
        phoneNumberId: credential.phoneNumberId,
        token: this.crypto.decrypt(credential.tokenCipher),
      },
      item.providerMediaId,
    );
    if (!outcome.ok) {
      // transitório: o lease expira e outro ciclo tenta de novo, até MAX_ATTEMPTS
      this.logger.warn(`Coleta de mídia ${item.id} falhou — nova tentativa depois`);
      return this.releaseForRetry(item);
    }

    const fileName = item.fileName ?? this.inferName(item.providerMediaId, outcome.mimeType);
    try {
      // MESMA validação do upload humano: tipo real por magic bytes, e
      // extensão coerente com o conteúdo
      assertAllowedFile(outcome.bytes, fileName);
    } catch (error) {
      if (error instanceof UnsupportedFileError) return this.fail(item, 'unsupported_type');
      throw error;
    }

    /**
     * POSSE ANTES DE GRAVAR: o download pode ter levado mais que o lease. Se a
     * posse já não é nossa, parar aqui evita arquivo, bytes e quota órfãos —
     * verificar só depois de gravar deixaria exatamente esse resíduo.
     */
    if (!(await this.renewLease(item))) {
      this.logger.warn(`Lease de mídia ${item.id} perdido antes da gravação — abandonando`);
      return false;
    }

    // entra no contexto do workspace: daqui em diante vale o client protegido,
    // e o arquivo passa pelo MESMO caminho de quota e limpeza do upload humano
    return this.cls.run(async () => {
      this.cls.set('workspaceId', item.workspaceId);
      // fora do `try`: o catch precisa saber se o arquivo já existe para limpar
      let file: { id: string } | undefined;
      try {
        const gravado = await this.files.storeFromChannel({
          workspaceId: item.workspaceId,
          bytes: outcome.bytes,
          fileName,
          mimeType: outcome.mimeType,
        });
        file = gravado;
        /**
         * FENCING e ANEXO na MESMA transação. Separados, a morte do processo
         * entre os dois deixava a mídia `fetched`, cobrada em storage e SEM
         * anexo — invisível na conversa e irrecuperável, porque o claim exige
         * `pending`.
         */
        const { count } = await this.prisma.raw.$transaction(async (tx) => {
          const concluido = await tx.inboundMedia.updateMany({
            where: { id: item.id, claimToken: item.claimToken, state: 'pending' },
            data: {
              state: 'fetched',
              fileObjectId: gravado.id,
              claimedAt: null,
              leaseExpiresAt: null,
              claimToken: null,
            },
          });
          if (concluido.count === 0) return { count: 0 };
          // o anexo liga a mídia à mensagem que a trouxe
          await tx.messageAttachment.create({
            data: {
              workspaceId: item.workspaceId,
              messageId: item.messageId,
              fileObjectId: gravado.id,
            },
          });
          return { count: concluido.count };
        });
        /**
         * Concluído: o arquivo já está ANEXADO e sai do alcance da limpeza. Sem
         * isto, um COMMIT bem-sucedido cuja resposta se perdesse cairia no catch
         * e apagaria um FileObject referenciado — o anexo iria por cascade e a
         * mídia voltaria a ser "cobrada, sem anexo e irrecuperável".
         */
        if (count > 0) file = undefined;
        if (count === 0) {
          /**
           * Perdemos a posse ENTRE gravar e concluir: quem assumiu vai baixar de
           * novo, então este arquivo é resíduo. Limpeza compensatória — sem
           * ela sobrariam bytes no disco, uma linha de FileObject e consumo de
           * quota que ninguém referencia.
           */
          this.logger.error(`Lease de mídia ${item.id} perdido após gravar — limpando resíduo`);
          await this.files.discardOrphan(item.workspaceId, gravado.id);
          return false;
        }
        return true;
      } catch (error) {
        this.logger.error(`Falha ao gravar mídia ${item.id} (${(error as Error).name})`);
        /**
         * O arquivo pode ter sido gravado ANTES da falha (o erro veio da
         * transação de conclusão): a transação volta atrás, os bytes e a quota
         * não. Sem esta limpeza, cada retentativa somava um FileObject órfão
         * cobrado no teto de armazenamento.
         */
        if (file) await this.files.discardOrphan(item.workspaceId, file.id);
        return this.releaseForRetry(item);
      }
    });
  }

  private async credentialFor(
    workspaceId: string,
    messageId: string,
  ): Promise<{ phoneNumberId: string; tokenCipher: string } | null> {
    const message = await this.prisma.raw.message.findFirst({
      where: { workspaceId, id: messageId },
      select: { channelId: true },
    });
    if (!message) return null;
    return this.prisma.raw.channelCredential.findFirst({
      where: { workspaceId, channelId: message.channelId },
      select: { phoneNumberId: true, tokenCipher: true },
    });
  }

  /** Renova o lease; `false` = a posse já não é nossa. */
  private async renewLease(item: { id: string; claimToken: string }): Promise<boolean> {
    const { count } = await this.prisma.raw.inboundMedia.updateMany({
      where: { id: item.id, claimToken: item.claimToken, state: 'pending' },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) },
    });
    return count > 0;
  }

  /**
   * Devolve ao pool para nova tentativa. Esgotadas as tentativas, vira estado
   * TERMINAL: sem isto a linha ficava `pending` para sempre, fora do claim
   * (`attempts < MAX`) e sem `errorCode` — mídia de paciente desaparecendo em
   * silêncio.
   */
  private async releaseForRetry(item: {
    id: string;
    claimToken: string;
    attempts: number;
  }): Promise<boolean> {
    if (item.attempts >= MAX_ATTEMPTS) return this.fail(item, 'max_attempts');
    await this.prisma.raw.inboundMedia.updateMany({
      where: { id: item.id, claimToken: item.claimToken },
      data: { claimedAt: null, leaseExpiresAt: null, claimToken: null },
    });
    return false;
  }

  private async fail(
    item: { id: string; claimToken: string },
    errorCode: string,
  ): Promise<boolean> {
    await this.prisma.raw.inboundMedia.updateMany({
      where: { id: item.id, claimToken: item.claimToken },
      data: {
        state: 'failed',
        errorCode,
        claimedAt: null,
        leaseExpiresAt: null,
        claimToken: null,
      },
    });
    return false;
  }

  private inferName(mediaId: string, mimeType: string): string {
    const extensao =
      {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
        'application/pdf': 'pdf',
      }[mimeType] ?? 'bin';
    return `${mediaId}.${extensao}`;
  }
}

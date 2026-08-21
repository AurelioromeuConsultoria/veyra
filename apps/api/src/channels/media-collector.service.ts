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

    // entra no contexto do workspace: daqui em diante vale o client protegido,
    // e o arquivo passa pelo MESMO caminho de quota e limpeza do upload humano
    return this.cls.run(async () => {
      this.cls.set('workspaceId', item.workspaceId);
      try {
        const file = await this.files.storeFromChannel({
          workspaceId: item.workspaceId,
          bytes: outcome.bytes,
          fileName,
          mimeType: outcome.mimeType,
        });
        // FENCING: só o dono do lease conclui
        const { count } = await this.prisma.raw.inboundMedia.updateMany({
          where: { id: item.id, claimToken: item.claimToken, state: 'pending' },
          data: {
            state: 'fetched',
            fileObjectId: file.id,
            claimedAt: null,
            leaseExpiresAt: null,
            claimToken: null,
          },
        });
        if (count === 0) {
          this.logger.warn(`Lease de mídia ${item.id} perdido — conclusão ignorada`);
          return false;
        }
        // o anexo liga a mídia à mensagem que a trouxe
        await this.prisma.raw.messageAttachment.create({
          data: {
            workspaceId: item.workspaceId,
            messageId: item.messageId,
            fileObjectId: file.id,
          },
        });
        return true;
      } catch (error) {
        this.logger.error(`Falha ao gravar mídia ${item.id} (${(error as Error).name})`);
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

  /** Devolve ao pool para nova tentativa (o lease sai do caminho). */
  private async releaseForRetry(item: { id: string; claimToken: string }): Promise<boolean> {
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

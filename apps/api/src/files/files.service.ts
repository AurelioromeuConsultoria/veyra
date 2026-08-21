import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { FileObjectDto } from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/decorators';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { UnsupportedFileError, assertAllowedFile, extensionOf } from './file-type';
import { STORAGE_DRIVER, type StorageDriver } from './storage.driver';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * Teto por arquivo. O endpoint aceita UM arquivo por requisição (limite
 * `files: 1` no multer), então este é também o teto do corpo inteiro — não há
 * constante separada de requisição para não descrever um limite inexistente.
 * O cliente anexa vários arquivos fazendo vários uploads.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

type FileRow = {
  id: string;
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByMembershipId: string;
  scanStatus: 'pending' | 'clean' | 'quarantined';
  createdAt: Date;
};

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly usage: UsageService,
    @Inject(STORAGE_DRIVER) private readonly storage: StorageDriver,
  ) {}

  /**
   * O tipo é DETECTADO por magic bytes (ADR-025) e a chave é DERIVADA no
   * servidor a partir do workspace do contexto — nada do que o cliente diz
   * sobre mimetype ou caminho é usado.
   */
  async upload(auth: AuthContext, file: UploadedFile): Promise<FileObjectDto> {
    if (file.size > MAX_FILE_BYTES) {
      throw new BadRequestException(
        `Arquivo acima do limite de ${MAX_FILE_BYTES / 1024 / 1024} MB`,
      );
    }
    if (file.buffer.length === 0) throw new BadRequestException('Arquivo vazio');

    let detected;
    try {
      detected = assertAllowedFile(file.buffer, file.originalname);
    } catch (error) {
      if (error instanceof UnsupportedFileError) throw new BadRequestException(error.message);
      throw error;
    }

    const workspaceId = auth.workspaceId as string;
    await this.usage.ensureCounterRow(workspaceId, 'storage_bytes');
    const extension = extensionOf(file.originalname);
    const key = `${workspaceId}/${randomUUID()}${extension ? `.${extension}` : ''}`;

    // bytes ANTES da linha: se o banco falhar, sobra um órfão no disco (varrido
    // pela rotina de órfãos); a ordem inversa deixaria linha apontando para o
    // nada, que é pior — o download quebraria para o usuário
    await this.storage.put(key, file.buffer);

    const db = this.prisma.db as unknown as TxRunner;
    let id: string;
    try {
      id = await db.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            key,
            fileName: file.originalname.slice(0, 200),
            mimeType: detected.mimeType,
            sizeBytes: file.buffer.length,
            uploadedByMembershipId: auth.membershipId as string,
            // NUNCA nasce clean: marcar como limpo exige scanner real (§7.5)
            scanStatus: 'pending',
          },
        } as never);
        const fileId = (created as unknown as { id: string }).id;
        await this.usage.consume(tx, workspaceId, 'storage_bytes', file.buffer.length);
        await this.audit.record(tx, workspaceId, 'file.uploaded', {
          entityType: 'file',
          entityId: fileId,
          actor: this.audit.actorFrom(auth),
          after: { fileName: file.originalname, mimeType: detected.mimeType },
        });
        return fileId;
      });
    } catch (error) {
      // os BYTES já estão no disco (gravados antes da transação, para que a
      // linha nunca aponte para o nada). Se a quota recusa, apagar na hora é o
      // que impede um excesso PREVISÍVEL de virar lixo permanente. Se a limpeza
      // falhar, a chave fica órfã e cai na rotina de órfãos — dívida registrada.
      await this.storage.delete(key).catch(() => {
        this.logger.error(`Falha ao limpar arquivo recusado por quota: ${key}`);
      });
      throw error;
    }
    return this.get(id);
  }

  async list(): Promise<FileObjectDto[]> {
    const rows = (await this.prisma.db.fileObject.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    } as never)) as unknown as FileRow[];
    return rows.map((row) => this.toDto(row));
  }

  async get(id: string): Promise<FileObjectDto> {
    const row = (await this.prisma.db.fileObject.findFirst({
      where: { id },
    })) as unknown as FileRow | null;
    if (!row) throw new NotFoundException('Arquivo não encontrado');
    return this.toDto(row);
  }

  /**
   * Download interno autenticado. `quarantined` NUNCA é servido; `pending` pode
   * ser baixado internamente (§7.5), mas não sai para canal externo — a regra
   * de saída está em `assertSendableExternally`.
   */
  async download(id: string): Promise<{ dto: FileObjectDto; bytes: Buffer }> {
    const row = (await this.prisma.db.fileObject.findFirst({
      where: { id },
    })) as unknown as FileRow | null;
    if (!row) throw new NotFoundException('Arquivo não encontrado');
    if (row.scanStatus === 'quarantined') {
      throw new ForbiddenException('Arquivo em quarentena não pode ser baixado');
    }
    return { dto: this.toDto(row), bytes: await this.storage.get(row.key) };
  }

  /**
   * Portão de saída para canal EXTERNO: só `clean` passa. Hoje nenhum canal
   * externo existe, mas a regra fica no caminho por onde ele vai passar — e
   * testada — para não ser esquecida quando o primeiro provider entrar.
   */
  assertSendableExternally(files: { fileName: string; scanStatus: string }[]): void {
    const bloqueado = files.find((file) => file.scanStatus !== 'clean');
    if (bloqueado) {
      throw new BadRequestException(
        `"${bloqueado.fileName}" ainda não foi verificado (${bloqueado.scanStatus}) e não pode sair para canal externo`,
      );
    }
  }

  /** Valida que os arquivos existem NESTE workspace e devolve o que achou. */
  async loadForAttachment(ids: string[]): Promise<FileRow[]> {
    if (ids.length === 0) return [];
    const rows = (await this.prisma.db.fileObject.findMany({
      where: { id: { in: ids } },
    } as never)) as unknown as FileRow[];
    if (rows.length !== new Set(ids).size) {
      throw new BadRequestException('Arquivo inválido');
    }
    return rows;
  }

  /**
   * A linha sai do banco e os BYTES saem depois, por evento interno do outbox
   * (ADR-024): apagar disco dentro da transação divergiria banco e storage se
   * uma das pontas falhasse.
   */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.fileObject.findFirst({
      where: { id },
    })) as unknown as FileRow | null;
    if (!existing) throw new NotFoundException('Arquivo não encontrado');

    const workspaceId = auth.workspaceId as string;
    await this.usage.ensureCounterRow(workspaceId, 'storage_bytes');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await this.audit.record(tx, workspaceId, 'file.deleted', {
        entityType: 'file',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { fileName: existing.fileName, mimeType: existing.mimeType },
        after: null,
      });
      await tx.fileObject.deleteMany({ where: { id } });
      await this.usage.consume(tx, workspaceId, 'storage_bytes', -existing.sizeBytes);
      await this.outbox.enqueue(
        tx,
        workspaceId,
        'file.purge',
        { key: existing.key },
        `file.purge:${id}`,
      );
    });
  }

  /** Chamado pelo dispatcher para o evento interno `file.purge`. */
  async purge(key: string): Promise<void> {
    await this.storage.delete(key);
  }

  private toDto(row: FileRow): FileObjectDto {
    return {
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      scanStatus: row.scanStatus,
      uploadedByMembershipId: row.uploadedByMembershipId,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

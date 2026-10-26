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
import { PermissionsService } from '../auth/permissions.service';
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
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Os ANEXOS DE CONVERSA (ADR-052 item 2; critério 3 da aprovação da F4.1a):
   * o arquivo ligado a uma mensagem — anexo ou mídia recebida — exige, ALÉM
   * das permissões que a rota já pede, `conversations:read` e o acesso a TODAS
   * as conversas a que está ligado, com a regra do C13 para as RAI
   * (`contacts:write`). Um vínculo sem acesso basta para negar. Arquivo sem
   * vínculo de mensagem fica como antes — salvo o marcado `conversationRestricted`
   * (a quarentena que a exclusão de um contato preserva, decisão de 2026-10-23),
   * que continua exigindo `conversations:read`.
   */
  private async acessiveis(auth: AuthContext, fileIds: string[]): Promise<Set<string>> {
    if (fileIds.length === 0) return new Set();
    const selecao = {
      fileObjectId: true,
      message: { select: { conversation: { select: { senderStatus: true } } } },
    } as const;
    const [anexos, midias, marcados] = await Promise.all([
      this.prisma.db.messageAttachment.findMany({
        where: { fileObjectId: { in: fileIds } },
        select: selecao,
      } as never),
      this.prisma.db.inboundMedia.findMany({
        where: { fileObjectId: { in: fileIds } },
        select: selecao,
      } as never),
      this.prisma.db.fileObject.findMany({
        where: { id: { in: fileIds }, conversationRestricted: true },
        select: { id: true },
      } as never),
    ]);
    const restritos = new Set((marcados as unknown as { id: string }[]).map((m) => m.id));
    const vinculos = new Map<string, string[]>();
    for (const vinculo of [...anexos, ...midias] as unknown as {
      fileObjectId: string | null;
      message: { conversation: { senderStatus: string } };
    }[]) {
      if (!vinculo.fileObjectId) continue;
      vinculos.set(vinculo.fileObjectId, [
        ...(vinculos.get(vinculo.fileObjectId) ?? []),
        vinculo.message.conversation.senderStatus,
      ]);
    }
    if (vinculos.size === 0 && restritos.size === 0) return new Set(fileIds);
    const [leConversas, veRai] = await Promise.all([
      this.permissions.has(auth, 'conversations:read'),
      this.permissions.has(auth, 'contacts:write'),
    ]);
    return new Set(
      fileIds.filter((id) => {
        const remetentes = vinculos.get(id);
        if (!remetentes) return !restritos.has(id) || leConversas;
        if (!leConversas) return false;
        return remetentes.every((status) => status !== 'unidentified' || veRai);
      }),
    );
  }

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
    const storageLimit = await this.usage.prepareConsume(workspaceId, 'storage_bytes');
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
        await this.usage.consume(
          tx,
          workspaceId,
          'storage_bytes',
          file.buffer.length,
          storageLimit,
        );
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
    return this.dtoDoGravado(id);
  }

  /**
   * Gravação a partir de CANAL EXTERNO (mídia recebida). Passa pelo MESMO
   * caminho do upload humano: chave derivada no servidor, quota de storage e
   * limpeza dos bytes se a transação falhar. `scanStatus` nasce `pending`, e o
   * portão de saída externa (§7.5) impede reenvio antes do scanner.
   */
  async storeFromChannel(input: {
    workspaceId: string;
    bytes: Buffer;
    fileName: string;
    mimeType: string;
  }): Promise<FileObjectDto> {
    if (input.bytes.length > MAX_FILE_BYTES) {
      throw new BadRequestException('Mídia acima do limite');
    }
    await this.usage.ensureCounterRow(input.workspaceId, 'storage_bytes');
    const extension = extensionOf(input.fileName);
    const key = `${input.workspaceId}/${randomUUID()}${extension ? `.${extension}` : ''}`;
    await this.storage.put(key, input.bytes);

    const db = this.prisma.db as unknown as TxRunner;
    let id: string;
    try {
      id = await db.$transaction(async (tx) => {
        const created = await tx.fileObject.create({
          data: {
            workspaceId: input.workspaceId,
            key,
            fileName: input.fileName.slice(0, 200),
            mimeType: input.mimeType,
            sizeBytes: input.bytes.length,
            // mídia recebida não tem membership que a enviou: o uploader é o
            // canal, e a coluna exige membership — usa a do sistema quando
            // houver; por ora, a primeira membership ativa do workspace
            uploadedByMembershipId: await this.systemUploader(tx),
            scanStatus: 'pending',
            /**
             * A MÍDIA RECEBIDA nasce sob a regra dos anexos de conversa, e a
             * leva consigo (ADR-052, revisão da F4.1a): anexada a outra
             * conversa, ou sem vínculo depois de uma exclusão, ela nunca volta
             * a quem só tem `files:read`.
             */
            conversationRestricted: true,
          },
        } as never);
        const fileId = (created as unknown as { id: string }).id;
        await this.usage.consumeOverLimit(
          tx,
          input.workspaceId,
          'storage_bytes',
          input.bytes.length,
        );
        return fileId;
      });
    } catch (error) {
      await this.storage.delete(key).catch(() => {
        this.logger.error(`Falha ao limpar mídia recusada: ${key}`);
      });
      throw error;
    }
    return this.dtoDoGravado(id);
  }

  /** Membership de referência para arquivo que não veio de uma pessoa. */
  private async systemUploader(tx: Db): Promise<string> {
    const membership = (await tx.membership.findFirst({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    })) as unknown as { id: string } | null;
    if (!membership) throw new BadRequestException('Workspace sem membership ativa');
    return membership.id;
  }

  /**
   * Descarte COMPENSATÓRIO de um arquivo que ficou órfão (a coleta perdeu a
   * posse do lease depois de gravar). Devolve a quota, remove a linha e apaga os
   * bytes na hora — deixar para o expurgo do outbox seria manter consumo de
   * storage que ninguém referencia.
   */
  async discardOrphan(workspaceId: string, fileId: string): Promise<void> {
    const existing = (await this.prisma.db.fileObject.findFirst({
      where: { id: fileId },
    })) as unknown as FileRow | null;
    if (!existing) return;
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.fileObject.deleteMany({ where: { id: fileId } });
      await this.usage.consumeOverLimit(tx, workspaceId, 'storage_bytes', -existing.sizeBytes);
    });
    await this.storage.delete(existing.key).catch(() => {
      this.logger.error(`Falha ao apagar bytes de arquivo órfão: ${existing.key}`);
    });
  }

  async list(auth: AuthContext): Promise<FileObjectDto[]> {
    const rows = (await this.prisma.db.fileObject.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    } as never)) as unknown as FileRow[];
    const acessiveis = await this.acessiveis(
      auth,
      rows.map((row) => row.id),
    );
    return rows.filter((row) => acessiveis.has(row.id)).map((row) => this.toDto(row));
  }

  /**
   * O DTO do arquivo que ESTE serviço acabou de gravar, para quem o gravou.
   * Privado de propósito: sem a regra dos anexos (`acessiveis`), ele não pode
   * servir a leitura de um arquivo qualquer (revisão da F4.1a).
   */
  private async dtoDoGravado(id: string): Promise<FileObjectDto> {
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
  async download(auth: AuthContext, id: string): Promise<{ dto: FileObjectDto; bytes: Buffer }> {
    const row = (await this.prisma.db.fileObject.findFirst({
      where: { id },
    })) as unknown as FileRow | null;
    // o anexo de conversa inacessível é 404, não 403: não se revela que existe
    if (!row || !(await this.acessiveis(auth, [id])).has(id)) {
      throw new NotFoundException('Arquivo não encontrado');
    }
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

  /**
   * Valida que os arquivos existem NESTE workspace, e que quem anexa pode vê-los
   * (a regra dos anexos de conversa, ADR-052): sem ela, o id de uma mídia de RAI
   * anexado a outra conversa mostraria o nome do arquivo no `MessageDto`. O
   * arquivo que não pode ver é "inválido", como o que não existe.
   */
  async loadForAttachment(auth: AuthContext, ids: string[]): Promise<FileRow[]> {
    if (ids.length === 0) return [];
    const rows = (await this.prisma.db.fileObject.findMany({
      where: { id: { in: ids } },
    } as never)) as unknown as FileRow[];
    const visiveis = await this.acessiveis(
      auth,
      rows.map((r) => r.id),
    );
    if (rows.length !== new Set(ids).size || visiveis.size !== rows.length) {
      throw new BadRequestException('Arquivo inválido');
    }
    return rows;
  }

  /**
   * A MÍDIA RECEBIDA de um contato: os arquivos das mídias e dos anexos das
   * mensagens de ENTRADA das conversas dele, e os anexos marcados como mídia
   * recebida (`conversationRestricted`) em qualquer mensagem delas — a mídia de
   * outra pessoa que alguém anexou aqui. É o que a exclusão do contato expurga,
   * se ficar sem vínculo (`expurgarSemVinculoNaTransacao`).
   *
   * ANTES de ler, a posse do coletor sobre essas mídias é invalidada, com a
   * linha presa: um coletor no meio da gravação termina antes (e o vínculo dele
   * é lido aqui), e um que chegue depois perde o cercamento e descarta o
   * próprio arquivo. Sem isso, um vínculo gravado entre a leitura e a cascata
   * deixava o arquivo de fora — de novo "sem vínculo" (revisão da F4.1a).
   */
  async midiaRecebidaDoContato(tx: Db, contactId: string): Promise<string[]> {
    const daConversa = { message: { conversation: { contactId } } };
    await tx.inboundMedia.updateMany({
      where: daConversa,
      data: { claimToken: null, claimedAt: null, leaseExpiresAt: null },
    } as never);
    const [midias, anexos, marcados] = await Promise.all([
      tx.inboundMedia.findMany({
        where: { ...daConversa, fileObjectId: { not: null } },
        select: { fileObjectId: true },
      } as never),
      tx.messageAttachment.findMany({
        where: { message: { direction: 'inbound', conversation: { contactId } } },
        select: { fileObjectId: true },
      } as never),
      tx.messageAttachment.findMany({
        where: { ...daConversa, file: { conversationRestricted: true } },
        select: { fileObjectId: true },
      } as never),
    ]);
    return [
      ...new Set(
        [...midias, ...anexos, ...marcados]
          .map((v) => (v as unknown as { fileObjectId: string | null }).fileObjectId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
  }

  /**
   * Expurga, na transação de quem exclui um contato, os arquivos da mídia
   * recebida dele que ficaram SEM VÍNCULO nenhum depois da cascata das
   * mensagens (LGPD; revisão da F4.1a). Sem isso, eles voltariam a "arquivo
   * sem vínculo", listável e baixável só com `files:read` — furando a regra dos
   * anexos de conversa. O que ainda tem vínculo (outra conversa) fica, com a
   * regra dele. Os bytes saem pelo `file.purge`, como em `remove`; a quarentena
   * fica, porque é a evidência. Devolve quantos expurgou.
   */
  async expurgarSemVinculoNaTransacao(
    tx: Db,
    auth: AuthContext,
    fileIds: string[],
    storageLimit: number | null,
  ): Promise<number> {
    if (fileIds.length === 0) return 0;
    const workspaceId = auth.workspaceId as string;
    /**
     * PRENDE as linhas antes de conferir os vínculos (escrita sem efeito). O
     * anexar faz a mesma escrita antes de ligar o arquivo, e as duas se
     * serializam: um anexar que veio antes aparece na leitura abaixo, e um que
     * vem depois não acha mais o arquivo e é recusado — em vez de o anexo novo
     * cair junto, em cascata, da mensagem de outra pessoa. A trava da FK do
     * anexar (KEY SHARE) sozinha não conflita com esta escrita, e o filtro no
     * próprio DELETE não bastaria: a subconsulta usa o retrato da instrução.
     */
    await tx.fileObject.updateMany({
      where: { id: { in: fileIds } },
      data: { scanAttempts: { increment: 0 } },
    } as never);
    const [anexos, midias] = await Promise.all([
      tx.messageAttachment.findMany({
        where: { fileObjectId: { in: fileIds } },
        select: { fileObjectId: true },
      } as never),
      tx.inboundMedia.findMany({
        where: { fileObjectId: { in: fileIds } },
        select: { fileObjectId: true },
      } as never),
    ]);
    const ligados = new Set(
      [...anexos, ...midias].map(
        (v) => (v as unknown as { fileObjectId: string | null }).fileObjectId,
      ),
    );
    const soltos = fileIds.filter((id) => !ligados.has(id));
    if (soltos.length === 0) return 0;
    /**
     * A QUARENTENA fica, como evidência (ADR-043 §4) — inteira, com o nome
     * original —, mas sem vínculo ela voltaria a quem só tem `files:read`.
     * Preservar a evidência não amplia o acesso (decisão de 2026-10-23): a
     * marca mantém a regra dos anexos de conversa sobre ela.
     */
    await tx.fileObject.updateMany({
      where: { id: { in: soltos }, scanStatus: 'quarantined' },
      data: { conversationRestricted: true },
    } as never);
    const rows = (await tx.fileObject.findMany({
      where: { id: { in: soltos }, scanStatus: { not: 'quarantined' } },
    } as never)) as unknown as FileRow[];
    for (const row of rows) {
      await this.audit.record(tx, workspaceId, 'file.deleted', {
        entityType: 'file',
        entityId: row.id,
        actor: this.audit.actorFrom(auth),
        before: { fileName: row.fileName, mimeType: row.mimeType },
        after: null,
      });
    }
    const { count } = await tx.fileObject.deleteMany({
      where: { id: { in: rows.map((r) => r.id) }, scanStatus: { not: 'quarantined' } },
    });
    const bytes = rows.reduce((soma, r) => soma + r.sizeBytes, 0);
    if (bytes > 0) {
      await this.usage.consume(tx, workspaceId, 'storage_bytes', -bytes, storageLimit);
    }
    for (const row of rows) {
      await this.outbox.enqueue(
        tx,
        workspaceId,
        'file.purge',
        { key: row.key },
        `file.purge:${row.id}`,
      );
    }
    return count;
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
    // `files:write` (a rota) continua exigido; a regra dos anexos se SOMA a ele
    if (!existing || !(await this.acessiveis(auth, [id])).has(id)) {
      throw new NotFoundException('Arquivo não encontrado');
    }
    if (existing.scanStatus === 'quarantined') {
      /**
       * A LINHA da quarentena é a evidência de que o arquivo existiu e foi
       * barrado (ADR-043 §4) — apagá-la torna o sumiço indistinguível de bug, e
       * qualquer um com `files:write` poderia destruir o registro do incidente.
       * Os bytes já saíram do disco; não há nada a liberar aqui.
       */
      throw new ForbiddenException('Arquivo em quarentena não pode ser excluído');
    }

    const workspaceId = auth.workspaceId as string;
    const storageLimit = await this.usage.prepareConsume(workspaceId, 'storage_bytes');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await this.audit.record(tx, workspaceId, 'file.deleted', {
        entityType: 'file',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { fileName: existing.fileName, mimeType: existing.mimeType },
        after: null,
      });
      /**
       * O predicado da guarda vai NO DELETE, não só na leitura acima: uma
       * quarentena comitada entre o `findFirst` e este comando apagaria a linha
       * apesar da checagem (TOCTOU). Zero linhas = alguém pôs em quarentena
       * agora, e a evidência não pode ser destruída.
       */
      const { count } = await tx.fileObject.deleteMany({
        where: { id, scanStatus: { not: 'quarantined' } },
      });
      if (count === 0) {
        throw new ForbiddenException('Arquivo em quarentena não pode ser excluído');
      }
      await this.usage.consume(tx, workspaceId, 'storage_bytes', -existing.sizeBytes, storageLimit);
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

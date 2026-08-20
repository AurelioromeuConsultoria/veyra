import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import type { FileObjectDto } from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { FilesService, MAX_FILE_BYTES, type UploadedFile } from './files.service';

@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @RequirePermissions('files:read')
  @Get()
  list(): Promise<FileObjectDto[]> {
    return this.files.list();
  }

  /**
   * Limites do multer (memória): tamanho por arquivo, um arquivo por
   * requisição e teto de campos — o corpo inteiro nunca vira surpresa de RAM.
   */
  @RequirePermissions('files:write')
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 4, fieldSize: 1024 },
    }),
  )
  upload(
    @CurrentAuth() auth: AuthContext,
    @UploadedFileParam() file?: UploadedFile,
  ): Promise<FileObjectDto> {
    if (!file) throw new BadRequestException('Envie um arquivo no campo "file"');
    return this.files.upload(auth, file);
  }

  /**
   * Download SEMPRE autenticado e autorizado (§7.4). Nunca é URL pública, o
   * Content-Type é o DETECTADO e os headers impedem o navegador de renderizar
   * o conteúdo — `attachment` + `nosniff` fecham a porta de XSS por upload.
   */
  @RequirePermissions('files:read')
  @Get(':id/content')
  async download(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const { dto, bytes } = await this.files.download(id);
    response.setHeader('Content-Type', dto.mimeType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(dto.fileName)}`,
    );
    response.send(bytes);
  }

  @RequirePermissions('files:write')
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.files.remove(auth, id);
    return { ok: true };
  }
}

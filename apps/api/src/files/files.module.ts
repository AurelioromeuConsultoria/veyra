import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FilesController } from './files.controller';
import { ClamavScanner } from './clamav.scanner';
import { FILE_SCANNER } from './file-scanner';
import { FileScanService } from './file-scan.service';
import { FilesService } from './files.service';
import { LocalDiskDriver, STORAGE_DRIVER } from './storage.driver';

/** Global: conversas anexam arquivos; o driver é injetável (ADR-024). */
@Global()
@Module({
  // as permissões de quem pede decidem o acesso aos anexos de conversa (ADR-052)
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    FileScanService,
    { provide: STORAGE_DRIVER, useClass: LocalDiskDriver },
    // scanner atrás da porta (ADR-043): sem CLAMAV_HOST devolve `unavailable`,
    // e `unavailable` deixa o arquivo `pending` — que não sai para fora
    { provide: FILE_SCANNER, useClass: ClamavScanner },
  ],
  exports: [FilesService, FileScanService],
})
export class FilesModule {}

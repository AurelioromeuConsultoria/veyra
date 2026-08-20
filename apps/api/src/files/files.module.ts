import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { LocalDiskDriver, STORAGE_DRIVER } from './storage.driver';

/** Global: conversas anexam arquivos; o driver é injetável (ADR-024). */
@Global()
@Module({
  controllers: [FilesController],
  providers: [FilesService, { provide: STORAGE_DRIVER, useClass: LocalDiskDriver }],
  exports: [FilesService],
})
export class FilesModule {}

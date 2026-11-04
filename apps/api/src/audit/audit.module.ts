import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { ConteudoDaTrilha } from './conteudo-da-trilha';

/** Global: todo service de domínio audita dentro da própria transação. */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, ConteudoDaTrilha],
  exports: [AuditService],
})
export class AuditModule {}

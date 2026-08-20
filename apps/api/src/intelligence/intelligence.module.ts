import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DealsModule } from '../deals/deals.module';
import { IntelligencePersistenceModule } from '../intelligence-persistence/intelligence-persistence.module';
import { TasksModule } from '../tasks/tasks.module';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';
import { AnthropicClient } from './llm/anthropic.client';
import { LLM_CLIENT } from './llm/llm.client';

/**
 * O módulo NÃO importa Prisma (ADR-027): as portas de persistência vêm do
 * IntelligencePersistenceModule, que fica fora dele. Verificado por lint e
 * pelo teste de fronteira (`boundary.spec.ts`).
 */
@Module({
  // serviços de DOMÍNIO são a única porta de leitura da IA (ADR-027):
  // por usarem o client filtrado, o run herda tenant, RBAC e auditoria
  imports: [
    IntelligencePersistenceModule,
    ConversationsModule,
    ContactsModule,
    DealsModule,
    TasksModule,
  ],
  controllers: [IntelligenceController],
  providers: [IntelligenceService, { provide: LLM_CLIENT, useClass: AnthropicClient }],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}

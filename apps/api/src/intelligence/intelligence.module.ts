import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { DealsModule } from '../deals/deals.module';
import { AuthModule } from '../auth/auth.module';
import { IntelligencePersistenceModule } from '../intelligence-persistence/intelligence-persistence.module';
import { TasksModule } from '../tasks/tasks.module';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';
import { AnthropicClient } from './llm/anthropic.client';
import { LLM_CLIENT } from './llm/llm.client';
import { LlmGateway } from './llm/llm.gateway';
import { ContactContentReplayGuard, ConversationContentReplayGuard } from './replay-guards';

/**
 * O módulo NÃO importa Prisma (ADR-027): as portas de persistência vêm do
 * IntelligencePersistenceModule, que fica fora dele. Verificado por lint e
 * pelo teste de fronteira (`boundary.spec.ts`).
 */
@Module({
  // serviços de DOMÍNIO são a única porta de leitura da IA (ADR-027):
  // por usarem o client filtrado, o run herda tenant, RBAC e auditoria
  imports: [
    // `PermissionsService`: a rota de custo é `workspace:manage`, mas os VALORES
    // em dólar exigem `billing:manage` — projeção de campo (§4)
    AuthModule,
    IntelligencePersistenceModule,
    ConversationsModule,
    ContactsModule,
    DealsModule,
    TasksModule,
  ],
  controllers: [IntelligenceController],
  // `LLM_CLIENT` é o PROVEDOR (os testes o trocam por um falso); o serviço só
  // fala com o `LlmGateway`, que confere a restrição de conteúdo (ADR-047 E6)
  providers: [
    IntelligenceService,
    LlmGateway,
    { provide: LLM_CLIENT, useClass: AnthropicClient },
    // guardas do replay de idempotência das capacidades (ADR-048 §6.3, item 3)
    ConversationContentReplayGuard,
    ContactContentReplayGuard,
  ],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}

import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { TasksModule } from '../tasks/tasks.module';
import {
  AI_CONSENT_REPOSITORY,
  AI_PROPOSAL_REPOSITORY,
  AI_RUN_REPOSITORY,
  PROMPT_VERSION_REPOSITORY,
} from '../intelligence/ports/repositories';
import { AI_USE_GUARD } from '../intelligence/ports/ai-use-guard';
import { UsageModule } from '../usage/usage.module';
import { GuardaDosUsosDaIa } from './ai-use-guard.adapter';
import {
  PrismaAiConsentRepository,
  PrismaAiProposalRepository,
  PrismaAiRunRepository,
  PrismaPromptVersionRepository,
} from './ai.repositories';

/** Adaptadores Prisma das portas do módulo `intelligence` (ADR-027). */
/**
 * Importa TasksModule: a execução de proposta cria tarefa na MESMA transação.
 * Importa ChannelsModule: aprovar rascunho de resposta DELEGA ao serviço de
 * envio, na mesma transação — o módulo de IA nunca escreve `Message` (ADR-044).
 */
@Module({
  imports: [TasksModule, ChannelsModule, UsageModule],
  providers: [
    // a porta da IA para a guarda de uso externo (ADR-047 adendo 7 §9); o
    // adaptador registra a especificação do tipo `ai_generation` na subida
    GuardaDosUsosDaIa,
    { provide: AI_USE_GUARD, useExisting: GuardaDosUsosDaIa },
    { provide: AI_RUN_REPOSITORY, useClass: PrismaAiRunRepository },
    { provide: AI_PROPOSAL_REPOSITORY, useClass: PrismaAiProposalRepository },
    { provide: AI_CONSENT_REPOSITORY, useClass: PrismaAiConsentRepository },
    { provide: PROMPT_VERSION_REPOSITORY, useClass: PrismaPromptVersionRepository },
  ],
  exports: [
    AI_USE_GUARD,
    AI_RUN_REPOSITORY,
    AI_PROPOSAL_REPOSITORY,
    AI_CONSENT_REPOSITORY,
    PROMPT_VERSION_REPOSITORY,
  ],
})
export class IntelligencePersistenceModule {}

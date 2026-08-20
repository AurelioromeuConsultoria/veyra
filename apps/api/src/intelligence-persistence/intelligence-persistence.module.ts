import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import {
  AI_CONSENT_REPOSITORY,
  AI_PROPOSAL_REPOSITORY,
  AI_RUN_REPOSITORY,
  PROMPT_VERSION_REPOSITORY,
} from '../intelligence/ports/repositories';
import {
  PrismaAiConsentRepository,
  PrismaAiProposalRepository,
  PrismaAiRunRepository,
  PrismaPromptVersionRepository,
} from './ai.repositories';

/** Adaptadores Prisma das portas do módulo `intelligence` (ADR-027). */
/** Importa TasksModule: a execução de proposta cria tarefa na MESMA transação. */
@Module({
  imports: [TasksModule],
  providers: [
    { provide: AI_RUN_REPOSITORY, useClass: PrismaAiRunRepository },
    { provide: AI_PROPOSAL_REPOSITORY, useClass: PrismaAiProposalRepository },
    { provide: AI_CONSENT_REPOSITORY, useClass: PrismaAiConsentRepository },
    { provide: PROMPT_VERSION_REPOSITORY, useClass: PrismaPromptVersionRepository },
  ],
  exports: [
    AI_RUN_REPOSITORY,
    AI_PROPOSAL_REPOSITORY,
    AI_CONSENT_REPOSITORY,
    PROMPT_VERSION_REPOSITORY,
  ],
})
export class IntelligencePersistenceModule {}

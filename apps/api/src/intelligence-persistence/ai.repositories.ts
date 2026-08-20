import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import type {
  AiConsentRepository,
  AiConsentState,
  AiProposalInput,
  AiProposalRecord,
  AiProposalRepository,
  AiProposalStatus,
  AiRunRecord,
  AiRunRepository,
  AiRunSummary,
  ConsentActor,
  PromptVersionRepository,
} from '../intelligence/ports/repositories';

/**
 * ADAPTADORES Prisma das portas do módulo `intelligence` (ADR-027). Ficam AQUI,
 * fora de `src/intelligence/**`, para que o banimento de import de Prisma lá
 * dentro seja absoluto e verificável — sem pasta de exceção.
 */

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

@Injectable()
export class PrismaAiRunRepository implements AiRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, run: AiRunRecord): Promise<string> {
    const created = await this.prisma.db.aiRun.create({
      data: {
        workspaceId,
        capability: run.capability,
        promptVersionId: run.promptVersionId,
        model: run.model,
        contextSummary: run.contextSummary,
        status: run.status,
        reasonCode: run.reasonCode ?? null,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costCents: run.costCents,
        latencyMs: run.latencyMs,
        action: run.action,
        triggeredByMembershipId: run.triggeredByMembershipId,
      },
    } as never);
    return (created as unknown as { id: string }).id;
  }

  async list(limit: number): Promise<AiRunSummary[]> {
    const rows = (await this.prisma.db.aiRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as (AiRunSummary & { createdAt: Date })[];
    return rows;
  }

  async totalCostCents(): Promise<number> {
    const rows = (await this.prisma.db.aiRun.findMany({
      select: { costCents: true },
    } as never)) as unknown as { costCents: number }[];
    return rows.reduce((total, row) => total + row.costCents, 0);
  }
}

@Injectable()
export class PrismaAiProposalRepository implements AiProposalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, proposal: AiProposalInput): Promise<string> {
    const created = await this.prisma.db.aiProposal.create({
      data: {
        workspaceId,
        runId: proposal.runId,
        type: proposal.type,
        payload: proposal.payload as object,
        rationale: proposal.rationale,
        contactId: proposal.contactId ?? null,
        dealId: proposal.dealId ?? null,
        conversationId: proposal.conversationId ?? null,
        expiresAt: proposal.expiresAt,
      },
    } as never);
    return (created as unknown as { id: string }).id;
  }

  async findById(id: string): Promise<AiProposalRecord | null> {
    const row = (await this.prisma.db.aiProposal.findFirst({
      where: { id },
    })) as unknown as AiProposalRecord | null;
    return row;
  }

  async list(status: AiProposalStatus | 'all', limit: number): Promise<AiProposalRecord[]> {
    return (await this.prisma.db.aiProposal.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as AiProposalRecord[];
  }

  /**
   * Transição ATÔMICA: `status: 'pending'` no WHERE faz duas aprovações
   * concorrentes resultarem em uma só — a segunda encontra zero linhas.
   */
  async transition(
    id: string,
    to: Exclude<AiProposalStatus, 'pending'>,
    reviewerMembershipId: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.db.aiProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: to, reviewedByMembershipId: reviewerMembershipId, reviewedAt: new Date() },
    });
    return count > 0;
  }
}

@Injectable()
export class PrismaAiConsentRepository implements AiConsentRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<AiConsentState> {
    const row = (await this.prisma.db.aiConsent.findFirst({})) as unknown as {
      conversationContent: boolean;
    } | null;
    // ausência = NÃO consentido (ADR-028): default-deny também na falta da linha
    return { conversationContent: row?.conversationContent ?? false };
  }

  async set(state: AiConsentState, actor: ConsentActor): Promise<void> {
    const before = await this.get();
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      const existing = await tx.aiConsent.findFirst({});
      if (existing) {
        await tx.aiConsent.updateMany({
          where: {},
          data: {
            conversationContent: state.conversationContent,
            updatedByMembershipId: actor.membershipId,
          },
        });
      } else {
        await tx.aiConsent.create({
          data: {
            conversationContent: state.conversationContent,
            updatedByMembershipId: actor.membershipId,
          },
        } as never);
      }
      // consentimento é decisão sensível: quem mudou e para o quê fica na trilha
      await this.audit.record(tx, actor.workspaceId, 'ai.consent_changed', {
        entityType: 'aiConsent',
        entityId: actor.workspaceId,
        actor: { type: 'user', membershipId: actor.membershipId },
        before: { conversationContent: before.conversationContent },
        after: { conversationContent: state.conversationContent },
      });
    });
  }
}

@Injectable()
export class PrismaPromptVersionRepository implements PromptVersionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * raw justificado: PromptVersion é catálogo GLOBAL do sistema (como
   * Permission), não dado de tenant — SECURITY.md §2.
   */
  async ensure(
    capability: string,
    version: number,
    hash: string,
    changelog: string,
  ): Promise<string> {
    const existing = await this.prisma.raw.promptVersion.findFirst({
      where: { capability, version },
    });
    if (existing) return existing.id;
    const created = await this.prisma.raw.promptVersion.create({
      data: { capability, version, hash, changelog },
    });
    return created.id;
  }
}

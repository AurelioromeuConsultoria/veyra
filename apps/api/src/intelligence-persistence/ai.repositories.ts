import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
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
  ApprovalContext,
  ConsentActor,
  CreateTaskExecution,
  PromptVersionRepository,
} from '../intelligence/ports/repositories';
import { PromptHashMismatchError } from '../intelligence/ports/repositories';

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
        result: (run.result ?? undefined) as object | undefined,
        conversationId: run.conversationId ?? null,
        contactId: run.contactId ?? null,
        triggeredByMembershipId: run.triggeredByMembershipId,
      },
    } as never);
    return (created as unknown as { id: string }).id;
  }

  async latestResult(
    capability: string,
    target: { conversationId?: string; contactId?: string },
  ): Promise<{ id: string; result: Record<string, unknown>; createdAt: Date } | null> {
    // filtrar JSON não-nulo no Prisma exige DbNull e vira ruído aqui; pegar as
    // últimas e escolher a primeira COM resultado é simples e suficiente
    const rows = (await this.prisma.db.aiRun.findMany({
      where: {
        capability,
        status: 'ok',
        ...(target.conversationId ? { conversationId: target.conversationId } : {}),
        ...(target.contactId ? { contactId: target.contactId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    } as never)) as unknown as { id: string; result: unknown; createdAt: Date }[];
    const row = rows.find((candidate) => candidate.result !== null);
    if (!row) return null;
    return { id: row.id, result: row.result as Record<string, unknown>, createdAt: row.createdAt };
  }

  /** Sem `result`: visão de custo não carrega conteúdo derivado de conversa. */
  async list(limit: number): Promise<AiRunSummary[]> {
    const rows = (await this.prisma.db.aiRun.findMany({
      select: {
        id: true,
        capability: true,
        promptVersionId: true,
        model: true,
        contextSummary: true,
        status: true,
        reasonCode: true,
        inputTokens: true,
        outputTokens: true,
        costCents: true,
        latencyMs: true,
        action: true,
        triggeredByMembershipId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as AiRunSummary[];
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}

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

  /** Transições que não executam nada (rejeitar, expirar). */
  async transition(
    id: string,
    to: 'rejected' | 'expired',
    reviewerMembershipId: string,
  ): Promise<boolean> {
    const { count } = await this.prisma.db.aiProposal.updateMany({
      where: { id, status: 'pending' },
      data: { status: to, reviewedByMembershipId: reviewerMembershipId, reviewedAt: new Date() },
    });
    return count > 0;
  }

  /**
   * Reivindicar → criar → registrar → concluir, TUDO numa transação (ADR-030).
   *
   * O `status: 'pending'` no WHERE do claim é o que serializa duas aprovações
   * simultâneas. E como a criação da tarefa acontece DENTRO da mesma transação,
   * uma falha ali desfaz o claim junto: a proposta volta a `pending` por
   * rollback, em vez de ficar `approved` sem tarefa nenhuma.
   */
  async executeCreateTask(
    id: string,
    runId: string,
    input: CreateTaskExecution,
    approver: ApprovalContext,
  ): Promise<{ taskId: string } | 'not_pending'> {
    const db = this.prisma.db as unknown as TxRunner;
    return db.$transaction(async (tx) => {
      const claimed = await tx.aiProposal.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: 'executing',
          reviewedByMembershipId: approver.membershipId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count === 0) return 'not_pending';

      // a mutação é da IA; o aprovador fica como contexto de aprovação
      const taskId = await this.tasks.createWithin(
        tx,
        approver.workspaceId,
        {
          title: input.title,
          dueAt: input.dueAt,
          contactId: input.contactId,
          priority: 'normal',
        },
        { type: 'ai', membershipId: approver.membershipId },
      );

      await this.audit.record(tx, approver.workspaceId, 'task.created_by_ai', {
        entityType: 'task',
        entityId: taskId,
        // actorId = AiRun: a trilha liga a mutação ao run que a propôs
        actor: { type: 'ai', id: runId, membershipId: approver.membershipId },
        after: { title: input.title, status: 'open' },
      });

      await tx.aiProposal.updateMany({
        where: { id, status: 'executing' },
        data: { status: 'approved' },
      });
      return { taskId };
    });
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
    if (existing) {
      if (existing.hash !== hash) {
        // editar o texto sem subir a versão faria runs antigos e novos
        // apontarem para a MESMA versão com conteúdos diferentes
        throw new PromptHashMismatchError(
          `Prompt ${capability}@${version} foi alterado sem subir a versão — crie a versão ${version + 1}`,
        );
      }
      return existing.id;
    }
    const created = await this.prisma.raw.promptVersion.create({
      data: { capability, version, hash, changelog },
    });
    return created.id;
  }
}

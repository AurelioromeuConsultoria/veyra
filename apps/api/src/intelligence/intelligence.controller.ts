import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  AiConsentDto,
  AiConsentInput,
  AiProposalDto,
  AiUsageDto,
  ConversationSummaryDto,
  LeadScoreDto,
  ListProposalsInput,
  ListRunsInput,
  NextActionDto,
  aiConsentSchema,
  listProposalsSchema,
  listRunsSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { IntelligenceService } from './intelligence.service';

@Controller('intelligence')
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  /** Consentimento é configuração do workspace (ADR-028). */
  @RequirePermissions('workspace:read')
  @Get('consent')
  async getConsent(): Promise<AiConsentDto> {
    return this.intelligence.getConsent();
  }

  @RequirePermissions('workspace:manage')
  @Put('consent')
  async setConsent(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(aiConsentSchema)) body: AiConsentInput,
  ): Promise<AiConsentDto> {
    await this.intelligence.setConsent(auth, body.conversationContent);
    return this.intelligence.getConsent();
  }

  /**
   * Resumo lê conteúdo de conversa: exige `conversations:read` ALÉM de
   * `intelligence:use` — a capacidade nunca amplia o que a pessoa já podia ver.
   */
  @RequirePermissions('intelligence:use', 'conversations:read')
  @Idempotent()
  @Post('conversations/:id/summary')
  summarize(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationSummaryDto> {
    return this.intelligence.summarizeConversation(auth, id);
  }

  @RequirePermissions('intelligence:use', 'contacts:read')
  @Get('contacts/:id/score')
  score(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LeadScoreDto> {
    return this.intelligence.scoreLead(auth, id);
  }

  /** Propõe uma tarefa; criar exige `tasks:write` de quem APROVAR, não daqui. */
  @RequirePermissions('intelligence:use', 'contacts:read')
  @Idempotent()
  @Post('contacts/:id/next-action')
  nextAction(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<NextActionDto> {
    return this.intelligence.suggestNextAction(auth, id);
  }

  @RequirePermissions('intelligence:use')
  @Get('proposals')
  async listProposals(
    @Query(new ZodPipe(listProposalsSchema)) query: ListProposalsInput,
  ): Promise<AiProposalDto[]> {
    const rows = await this.intelligence.listProposals(query.status);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload,
      rationale: row.rationale,
      status: row.status,
      contactId: row.contactId ?? null,
      dealId: row.dealId ?? null,
      conversationId: row.conversationId ?? null,
      reviewedByMembershipId: row.reviewedByMembershipId,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Aprovar EXECUTA a ação: exige `intelligence:approve` e a permissão do
   * domínio afetado (`tasks:write`) — aprovar não pode ser um atalho para
   * fazer o que a pessoa não poderia fazer à mão.
   */
  @RequirePermissions('intelligence:approve', 'tasks:write')
  @Idempotent()
  @Post('proposals/:id/approve')
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ taskId: string }> {
    return this.intelligence.approveProposal(auth, id);
  }

  @RequirePermissions('intelligence:approve')
  @Post('proposals/:id/reject')
  async reject(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.intelligence.rejectProposal(auth, id);
    return { ok: true };
  }

  /** Custo e histórico: base das quotas da Entrega 8. */
  @RequirePermissions('intelligence:use')
  @Get('usage')
  async usage(@Query(new ZodPipe(listRunsSchema)) query: ListRunsInput): Promise<AiUsageDto> {
    const [runs, totalCostCents] = await Promise.all([
      this.intelligence.listRuns(query.limit),
      this.intelligence.totalCostCents(),
    ]);
    return {
      totalCostCents,
      runs: runs.map((run) => ({
        id: run.id,
        capability: run.capability,
        model: run.model,
        status: run.status,
        reasonCode: run.reasonCode ?? null,
        contextSummary: run.contextSummary,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costCents: run.costCents,
        latencyMs: run.latencyMs,
        action: run.action,
        createdAt: run.createdAt.toISOString(),
      })),
    };
  }
}

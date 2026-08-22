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
import { PermissionsService } from '../auth/permissions.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { IntelligenceService } from './intelligence.service';

@Controller('intelligence')
export class IntelligenceController {
  constructor(
    private readonly intelligence: IntelligenceService,
    private readonly permissions: PermissionsService,
  ) {}

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
  /** Releitura do último resumo gravado: mesma permissão de gerar. */
  @RequirePermissions('intelligence:use', 'conversations:read')
  @Get('conversations/:id/summary')
  latestSummary(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationSummaryDto | null> {
    return this.intelligence.latestSummary(id);
  }

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

  /**
   * A fila expõe alvo, justificativa e contexto do workspace inteiro: exige
   * quem PODE decidir (`intelligence:approve`) e a leitura do domínio-alvo
   * (`contacts:read`). Uma role só com `intelligence:use` não infere pelo
   * feed de IA o que não pode ler no CRM.
   */
  @RequirePermissions('intelligence:approve', 'contacts:read')
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

  /**
   * Histórico e custo do workspace inteiro: a ROTA é `workspace:manage` porque
   * runs, tokens, latência e motivo de recusa são diagnóstico de administração.
   *
   * Os VALORES EM DÓLAR, porém, exigem `billing:manage` — projeção de campo, a
   * mesma regra de `/api/usage` (ADR-041, SECURITY.md §4). Sem isto o Admin, que
   * tem `workspace:manage` e NÃO tem `billing:manage`, lia o gasto real por
   * execução: a porta da frente ficava fechada e esta, de serviço, aberta.
   */
  @RequirePermissions('workspace:manage')
  @Get('usage')
  async usage(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listRunsSchema)) query: ListRunsInput,
  ): Promise<AiUsageDto> {
    const [runs, totalCostCents, podeVerBilling] = await Promise.all([
      this.intelligence.listRuns(query.limit),
      this.intelligence.totalCostCents(),
      this.permissions.has(auth, 'billing:manage'),
    ]);
    return {
      totalCostCents: podeVerBilling ? totalCostCents : null,
      ...(podeVerBilling ? {} : { monetaryRedacted: true }),
      runs: runs.map((run) => ({
        id: run.id,
        capability: run.capability,
        model: run.model,
        status: run.status,
        reasonCode: run.reasonCode ?? null,
        contextSummary: run.contextSummary,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costCents: podeVerBilling ? run.costCents : null,
        latencyMs: run.latencyMs,
        action: run.action,
        createdAt: run.createdAt.toISOString(),
      })),
    };
  }
}

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
  ApproveSendMessageInput,
  NextActionDto,
  ReplySuggestionDto,
  aiConsentSchema,
  approveSendMessageSchema,
  listProposalsSchema,
  listRunsSchema,
} from '@veyra/contracts';
import { PermissionsService } from '../auth/permissions.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { IntelligenceService } from './intelligence.service';
import { ContactContentReplayGuard, ConversationContentReplayGuard } from './replay-guards';

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
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ConversationSummaryDto | null> {
    return this.intelligence.latestSummary(auth, id);
  }

  @RequirePermissions('intelligence:use', 'conversations:read')
  @Idempotent({ replayGuard: ConversationContentReplayGuard })
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
  @Idempotent({ replayGuard: ContactContentReplayGuard })
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
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listProposalsSchema)) query: ListProposalsInput,
  ): Promise<AiProposalDto[]> {
    /**
     * Proposta de RESPOSTA carrega texto derivado de conversa no payload. A
     * rota exige `contacts:read`, que não é `conversations:read`: sem este
     * filtro, quem só lê o CRM passaria a ler rascunhos de conversa pela fila
     * de IA. Projeção de campo, não decisão de rota (SECURITY.md §4).
     *
     * O filtro desce até o WHERE: excluir depois do `take` devolvia página
     * curta a quem tem direito às propostas de tarefa que ficaram de fora.
     */
    const podeLerConversa = await this.permissions.has(auth, 'conversations:read');
    const rows = await this.intelligence.listProposals(auth, query.status, {
      includeReplyDrafts: podeLerConversa,
    });
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

  /**
   * Sugestão de resposta (ADR-044). Gerar exige `conversations:read`: o
   * rascunho nasce do corpo das mensagens — a capacidade nunca amplia o que a
   * pessoa já podia ler. ENVIAR é outra rota, com outra permissão.
   */
  @RequirePermissions('intelligence:use', 'conversations:read')
  @Get('conversations/:id/reply-suggestion')
  async pendingReply(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReplySuggestionDto | null> {
    return this.intelligence.pendingReply(auth, id);
  }

  /**
   * GERAR exige também `conversations:write` (ADR-044, adendo 3): o rascunho
   * novo SUPERSEDE o pendente, invalidando o trabalho que outra pessoa poderia
   * aprovar. Ler e analisar continua com `conversations:read`; substituir é
   * escrita na conversa. Sem isto, a supersessão seria a exceção permanente ao
   * modelo que o adendo 2 acabou de estabelecer.
   */
  @RequirePermissions('intelligence:use', 'conversations:read', 'conversations:write')
  @Idempotent({ replayGuard: ConversationContentReplayGuard })
  @Post('conversations/:id/reply-suggestion')
  suggestReply(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ReplySuggestionDto> {
    return this.intelligence.suggestReply(auth, id);
  }

  /**
   * Aprovar rascunho ENVIA a mensagem: exige `intelligence:approve` E
   * `conversations:write`, cumulativamente (ADR-044.9). Rota separada da
   * aprovação de tarefa porque cada tipo de proposta carrega a permissão do
   * domínio do seu efeito — e RBAC aqui é declarativo, nunca decidido em
   * runtime dentro do service.
   */
  @RequirePermissions('intelligence:approve', 'conversations:write')
  @Idempotent()
  @Post('proposals/:id/approve-reply')
  approveReply(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approveSendMessageSchema)) body: ApproveSendMessageInput,
  ): Promise<{ messageId: string }> {
    return this.intelligence.approveSendMessage(auth, id, body.body);
  }

  /**
   * Descarte da fila de TAREFAS. Recusa `send_message`: descartar um rascunho
   * de resposta age sobre conteúdo de conversa, e conhecer o id não pode ser a
   * credencial que basta (ADR-044, adendo 2).
   */
  /* sem `@Idempotent()` nas duas rejeições, ao contrário das aprovações: elas
     não têm efeito externo a repetir, e a segunda chamada já devolve 400
     "Proposta já revisada" — que é a resposta correta, não um replay */
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
   * Descartar rascunho de resposta exige as MESMAS permissões cumulativas de
   * aprová-lo: quem não pode falar com o contato também não decide o que deixa
   * de ser dito a ele.
   */
  @RequirePermissions('intelligence:approve', 'conversations:write')
  @Post('proposals/:id/reject-reply')
  async rejectReply(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.intelligence.rejectReply(auth, id);
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

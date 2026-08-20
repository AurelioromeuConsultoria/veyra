import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { ActivitiesService } from '../activities/activities.service';
import { UsageService } from '../usage/usage.service';
import { AuthContext } from '../common/decorators';
import { ContactsService } from '../contacts/contacts.service';
import { ConversationsService } from '../conversations/conversations.service';
import { DealsService } from '../deals/deals.service';
import { estimateCostCents, estimateMaxCostCents } from './cost';
import { computeLeadScore, type LeadScore, type ScoreSignals } from './lead-score';
import { LLM_CLIENT, type LlmClient, type LlmRequest } from './llm/llm.client';
import {
  AI_CONSENT_REPOSITORY,
  AI_PROPOSAL_REPOSITORY,
  AI_RUN_REPOSITORY,
  PROMPT_VERSION_REPOSITORY,
  type AiConsentRepository,
  type AiProposalRepository,
  type AiRunAction,
  type AiRunRepository,
  type AiRunStatus,
  type PromptVersionRepository,
} from './ports/repositories';
import {
  CONVERSATION_SUMMARY_PROMPT,
  LEAD_SCORE_EXPLANATION_PROMPT,
  NEXT_ACTION_PROMPT,
  promptHash,
  type PromptDefinition,
} from './prompts';

/**
 * Saídas VALIDADAS. O modelo produz texto; só vira dado do produto depois de
 * passar por aqui (ADR-029). `.strict()` recusa chave extra — se o modelo
 * inventar campo, o run falha em vez de propagar lixo.
 */
const summarySchema = z
  .object({
    subject: z.string().max(120),
    summary: z.string().max(1200),
    pendencies: z.array(z.string().max(200)).max(10),
    sentiment: z.enum(['positivo', 'neutro', 'negativo']),
    injectionAttempt: z.boolean(),
  })
  .strict();

const nextActionSchema = z
  .object({
    title: z.string().min(1).max(120),
    rationale: z.string().max(400),
    dueInDays: z.number().int().min(0).max(30),
  })
  .strict();

const explanationSchema = z.object({ explanation: z.string().max(600) }).strict();

const PROPOSAL_TTL_DAYS = 7;
const MAX_OUTPUT_TOKENS = 700;
/** teto de mensagens no contexto: run não vira consulta ilimitada nem custo aberto */
const SUMMARY_MESSAGE_LIMIT = 30;

export interface ConversationSummaryResult {
  status: 'ok' | 'unavailable' | 'no_consent' | 'quota_exceeded';
  runId: string | null;
  subject?: string;
  summary?: string;
  pendencies?: string[];
  sentiment?: 'positivo' | 'neutro' | 'negativo';
  injectionAttempt?: boolean;
}

export interface LeadScoreResult extends LeadScore {
  /** ausente quando não há provedor: o score continua valendo (ajuste aprovado) */
  explanation: string | null;
  runId: string | null;
}

export interface NextActionResult {
  status: 'proposed' | 'unavailable' | 'quota_exceeded';
  runId: string | null;
  proposalId?: string;
  title?: string;
  rationale?: string;
}

@Injectable()
export class IntelligenceService {
  constructor(
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    @Inject(AI_RUN_REPOSITORY) private readonly runs: AiRunRepository,
    @Inject(AI_PROPOSAL_REPOSITORY) private readonly proposals: AiProposalRepository,
    @Inject(AI_CONSENT_REPOSITORY) private readonly consent: AiConsentRepository,
    @Inject(PROMPT_VERSION_REPOSITORY) private readonly promptVersions: PromptVersionRepository,
    private readonly conversations: ConversationsService,
    private readonly contacts: ContactsService,
    private readonly deals: DealsService,
    private readonly activities: ActivitiesService,
    private readonly usage: UsageService,
  ) {}

  /**
   * Resumo de conversa. Fluxo da v1 (ADR-029): consentimento → contexto
   * permitido → chamada estruturada → validação Zod → registro. Sem loop, sem
   * ferramenta: o modelo não escolhe o que ler nem consegue escrever nada.
   */
  async summarizeConversation(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ConversationSummaryResult> {
    // existência ANTES do gate de consentimento: id inexistente ou de outro
    // workspace precisa dar 404, e não "sem consentimento". `get` traz só
    // metadados — nenhum corpo de mensagem é lido antes do consentimento.
    const conversation = await this.conversations.get(conversationId);

    // ADR-028: sem consentimento não há NEM chamada ao provedor
    const { conversationContent } = await this.consent.get();
    if (!conversationContent) {
      const runId = await this.record(auth, {
        capability: CONVERSATION_SUMMARY_PROMPT.capability,
        promptVersionId: null,
        contextSummary: 'recusado antes de montar contexto: sem consentimento do workspace',
        status: 'refused',
        reasonCode: 'no_consent',
        conversationId,
      });
      return { status: 'no_consent', runId };
    }

    const page = await this.conversations.listMessages(conversationId, {
      limit: SUMMARY_MESSAGE_LIMIT,
    });
    if (page.items.length === 0) {
      throw new BadRequestException('Conversa sem mensagens para resumir');
    }

    // conteúdo escrito por terceiros vai no campo `untrusted`, delimitado e
    // rotulado pelo cliente — nunca concatenado à instrução
    const untrusted = [...page.items]
      .reverse()
      .map(
        (message) => `[${message.direction === 'outbound' ? 'equipe' : 'contato'}] ${message.body}`,
      )
      .join('\n');

    const started = Date.now();
    const call = await this.callWithQuota(auth.workspaceId as string, {
      system: CONVERSATION_SUMMARY_PROMPT.system,
      context: `Contato: ${conversation.contactName ?? 'não vinculado'}. Assunto registrado: ${conversation.subject ?? 'sem assunto'}.`,
      untrusted,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    } satisfies LlmRequest);

    const promptVersionId = await this.ensurePrompt(CONVERSATION_SUMMARY_PROMPT);
    const contextSummary = `conversation:${conversationId}; ${page.items.length} mensagens (corpo); campos: direction, body`;

    if (call.outcome === 'quota_exceeded') {
      const runId = await this.record(auth, {
        capability: CONVERSATION_SUMMARY_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'refused',
        reasonCode: 'quota_exceeded',
        conversationId,
        latencyMs: Date.now() - started,
      });
      return { status: 'quota_exceeded', runId };
    }
    const response = call.outcome === 'ok' ? call.response : null;
    if (!response) {
      const runId = await this.record(auth, {
        capability: CONVERSATION_SUMMARY_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'error',
        reasonCode: 'provider_unavailable',
        conversationId,
        latencyMs: Date.now() - started,
      });
      return { status: 'unavailable', runId };
    }

    const parsed = summarySchema.safeParse(this.parseJson(response.text));
    const usage = {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costCents: call.outcome === 'ok' ? call.costCents : 0,
      latencyMs: Date.now() - started,
    };
    if (!parsed.success) {
      const runId = await this.record(auth, {
        capability: CONVERSATION_SUMMARY_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'error',
        reasonCode: 'invalid_output',
        conversationId,
        ...usage,
      });
      return { status: 'unavailable', runId };
    }

    const runId = await this.record(auth, {
      capability: CONVERSATION_SUMMARY_PROMPT.capability,
      promptVersionId,
      contextSummary,
      status: 'ok',
      // resultado ESTRUTURADO e já validado: é o que a interface reaproveita
      // sem pagar outro run. Nunca o prompt nem o corpo das mensagens.
      result: parsed.data,
      conversationId,
      ...usage,
    });
    return { status: 'ok', runId, ...parsed.data };
  }

  /**
   * Próxima ação: o modelo PROPÕE, ninguém executa. A saída vira `AiProposal`
   * de tipo permitido, com payload validado — jamais segue direto para um
   * service de domínio.
   */
  async suggestNextAction(auth: AuthContext, contactId: string): Promise<NextActionResult> {
    const signals = await this.collectSignals(contactId);
    const score = computeLeadScore(signals);

    const started = Date.now();
    const call = await this.callWithQuota(auth.workspaceId as string, {
      system: NEXT_ACTION_PROMPT.system,
      context: this.describeSignals(signals, score),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const promptVersionId = await this.ensurePrompt(NEXT_ACTION_PROMPT);
    const contextSummary = `contact:${contactId}; sinais determinísticos (recência, pipeline, engajamento); sem conteúdo de mensagem`;

    if (call.outcome === 'quota_exceeded') {
      const runId = await this.record(auth, {
        capability: NEXT_ACTION_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'refused',
        reasonCode: 'quota_exceeded',
        contactId,
        latencyMs: Date.now() - started,
      });
      return { status: 'quota_exceeded', runId };
    }
    const response = call.outcome === 'ok' ? call.response : null;
    if (!response) {
      const runId = await this.record(auth, {
        capability: NEXT_ACTION_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'error',
        reasonCode: 'provider_unavailable',
        latencyMs: Date.now() - started,
      });
      return { status: 'unavailable', runId };
    }

    const parsed = nextActionSchema.safeParse(this.parseJson(response.text));
    const usage = {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costCents: call.outcome === 'ok' ? call.costCents : 0,
      latencyMs: Date.now() - started,
    };
    if (!parsed.success) {
      const runId = await this.record(auth, {
        capability: NEXT_ACTION_PROMPT.capability,
        promptVersionId,
        contextSummary,
        status: 'error',
        reasonCode: 'invalid_output',
        ...usage,
      });
      return { status: 'unavailable', runId };
    }

    const runId = await this.record(auth, {
      capability: NEXT_ACTION_PROMPT.capability,
      promptVersionId,
      contextSummary,
      status: 'ok',
      action: 'proposed',
      result: parsed.data,
      contactId,
      ...usage,
    });
    const dueAt = new Date(Date.now() + parsed.data.dueInDays * 24 * 60 * 60 * 1000);
    const proposalId = await this.proposals.create(auth.workspaceId as string, {
      runId,
      type: 'create_task',
      // payload já validado; a execução revalida antes de tocar o domínio
      payload: { title: parsed.data.title, dueAt: dueAt.toISOString(), contactId },
      rationale: parsed.data.rationale,
      contactId,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    return {
      status: 'proposed',
      runId,
      proposalId,
      title: parsed.data.title,
      rationale: parsed.data.rationale,
    };
  }

  /**
   * Score SEMPRE determinístico (ajuste aprovado); o LLM só redige a
   * explicação. Sem provedor, `explanation` vem null e o resto continua de pé.
   */
  async scoreLead(auth: AuthContext, contactId: string): Promise<LeadScoreResult> {
    const signals = await this.collectSignals(contactId);
    const score = computeLeadScore(signals);

    const started = Date.now();
    const call = await this.callWithQuota(auth.workspaceId as string, {
      system: LEAD_SCORE_EXPLANATION_PROMPT.system,
      context: this.describeSignals(signals, score),
      maxOutputTokens: 300,
    });
    // quota estourada NÃO derruba o score: ele é determinístico e continua
    // valendo — some apenas a redação (ajuste aprovado da Entrega 7)
    if (call.outcome !== 'ok') return { ...score, explanation: null, runId: null };
    const response = call.response;

    const promptVersionId = await this.ensurePrompt(LEAD_SCORE_EXPLANATION_PROMPT);
    const parsed = explanationSchema.safeParse(this.parseJson(response.text));
    const usage = {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costCents: call.costCents,
      latencyMs: Date.now() - started,
    };
    const runId = await this.record(auth, {
      capability: LEAD_SCORE_EXPLANATION_PROMPT.capability,
      promptVersionId,
      contextSummary: `contact:${contactId}; score determinístico + fatores; sem conteúdo de mensagem`,
      status: parsed.success ? 'ok' : 'error',
      reasonCode: parsed.success ? null : 'invalid_output',
      result: parsed.success
        ? { score: score.score, factors: score.factors, explanation: parsed.data.explanation }
        : null,
      contactId,
      ...usage,
    });
    return { ...score, explanation: parsed.success ? parsed.data.explanation : null, runId };
  }

  /**
   * Último resumo GRAVADO da conversa. Sem isto o insight morre com a resposta
   * HTTP e a interface teria de pagar outro run para mostrar o mesmo texto.
   */
  async latestSummary(conversationId: string): Promise<ConversationSummaryResult | null> {
    // valida acesso pelo serviço de domínio antes de devolver qualquer coisa
    await this.conversations.get(conversationId);
    const latest = await this.runs.latestResult(CONVERSATION_SUMMARY_PROMPT.capability, {
      conversationId,
    });
    if (!latest) return null;
    const parsed = summarySchema.safeParse(latest.result);
    if (!parsed.success) return null;
    return { status: 'ok', runId: latest.id, ...parsed.data };
  }

  async listRuns(limit: number) {
    return this.runs.list(limit);
  }

  async totalCostCents(): Promise<number> {
    return this.runs.totalCostCents();
  }

  async getConsent() {
    return this.consent.get();
  }

  async setConsent(auth: AuthContext, conversationContent: boolean): Promise<void> {
    await this.consent.set(
      { conversationContent },
      {
        workspaceId: auth.workspaceId as string,
        membershipId: auth.membershipId as string,
      },
    );
  }

  // ── Propostas ─────────────────────────────────────────────────────────────

  async listProposals(
    status: 'pending' | 'executing' | 'approved' | 'rejected' | 'expired' | 'all',
  ) {
    return this.proposals.list(status, 100);
  }

  /**
   * Execução SÓ depois de aprovação, e o payload é revalidado aqui: entre a
   * proposta e o aceite, nada garante que a linha não foi adulterada por outro
   * caminho. O tipo também é conferido contra a lista permitida.
   */
  async approveProposal(auth: AuthContext, id: string): Promise<{ taskId: string }> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    if (proposal.status !== 'pending') {
      throw new BadRequestException('Proposta já revisada');
    }
    if (proposal.expiresAt.getTime() < Date.now()) {
      await this.proposals.transition(id, 'expired', auth.membershipId as string);
      throw new BadRequestException('Proposta expirada');
    }
    if (proposal.type !== 'create_task') {
      throw new BadRequestException('Tipo de proposta não permitido');
    }
    // revalida o payload NO ACEITE: entre propor e aprovar, nada garante que a
    // linha não foi adulterada por outro caminho
    const payload = z
      .object({
        title: z.string().min(1).max(120),
        dueAt: z.iso.datetime(),
        contactId: z.string().uuid(),
      })
      .strict()
      .parse(proposal.payload);

    // reivindicar → criar → registrar → concluir, tudo em UMA transação
    // (ADR-030): falha na criação devolve a proposta a `pending` por rollback
    const result = await this.proposals.executeCreateTask(id, proposal.runId, payload, {
      workspaceId: auth.workspaceId as string,
      membershipId: auth.membershipId as string,
    });
    if (result === 'not_pending') throw new BadRequestException('Proposta já revisada');
    return result;
  }

  async rejectProposal(auth: AuthContext, id: string): Promise<void> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    const done = await this.proposals.transition(id, 'rejected', auth.membershipId as string);
    if (!done) throw new BadRequestException('Proposta já revisada');
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private async ensurePrompt(prompt: PromptDefinition): Promise<string> {
    return this.promptVersions.ensure(
      prompt.capability,
      prompt.version,
      promptHash(prompt),
      prompt.changelog,
    );
  }

  private async record(
    auth: AuthContext,
    run: {
      capability: string;
      promptVersionId: string | null;
      contextSummary: string;
      status: AiRunStatus;
      reasonCode?: string | null;
      result?: Record<string, unknown> | null;
      conversationId?: string | null;
      contactId?: string | null;
      action?: AiRunAction;
      inputTokens?: number;
      outputTokens?: number;
      costCents?: number;
      latencyMs?: number;
    },
  ): Promise<string> {
    return this.runs.create(auth.workspaceId as string, {
      capability: run.capability,
      promptVersionId: run.promptVersionId,
      model: this.llm.model,
      contextSummary: run.contextSummary,
      status: run.status,
      reasonCode: run.reasonCode ?? null,
      result: run.result ?? null,
      conversationId: run.conversationId ?? null,
      contactId: run.contactId ?? null,
      inputTokens: run.inputTokens ?? 0,
      outputTokens: run.outputTokens ?? 0,
      costCents: run.costCents ?? 0,
      latencyMs: run.latencyMs ?? 0,
      action: run.action ?? 'none',
      triggeredByMembershipId: auth.membershipId ?? null,
    });
  }

  /**
   * Chamada ao provedor com RESERVA de quota (ADR-033): reserva o teto do run
   * ANTES de chamar, liquida pelo custo real depois e libera a diferença.
   * Incrementar só depois da resposta deixaria N chamadas simultâneas furarem
   * o teto N vezes — com o dinheiro já gasto.
   */
  private async callWithQuota(
    workspaceId: string,
    request: LlmRequest,
  ): Promise<
    | {
        outcome: 'ok';
        response: { text: string; inputTokens: number; outputTokens: number };
        costCents: number;
      }
    | { outcome: 'quota_exceeded' }
    | { outcome: 'unavailable' }
  > {
    const promptChars =
      request.system.length + request.context.length + (request.untrusted?.length ?? 0);
    const maxCost = estimateMaxCostCents(this.llm.model, promptChars, request.maxOutputTokens);

    const runsReservation = await this.usage.reserve(workspaceId, 'ai_runs', 1);
    if (runsReservation === 'quota_exceeded') return { outcome: 'quota_exceeded' };
    const costReservation = await this.usage.reserve(workspaceId, 'ai_cost_cents', maxCost);
    if (costReservation === 'quota_exceeded') {
      await this.usage.release(runsReservation.reservationId);
      return { outcome: 'quota_exceeded' };
    }

    let response: Awaited<ReturnType<LlmClient['complete']>>;
    try {
      response = await this.llm.complete(request);
    } catch {
      await this.usage.release(runsReservation.reservationId);
      await this.usage.release(costReservation.reservationId);
      return { outcome: 'unavailable' };
    }
    if (!response) {
      // nada foi gasto: libera as duas reservas por inteiro
      await this.usage.release(runsReservation.reservationId);
      await this.usage.release(costReservation.reservationId);
      return { outcome: 'unavailable' };
    }

    const costCents = estimateCostCents(
      this.llm.model,
      response.inputTokens,
      response.outputTokens,
    );
    await this.usage.settle(workspaceId, runsReservation.reservationId, 'ai_runs', 1);
    await this.usage.settle(workspaceId, costReservation.reservationId, 'ai_cost_cents', costCents);
    return { outcome: 'ok', response, costCents };
  }

  /** Modelo às vezes embrulha JSON em cerca de código; nada além disso é tolerado. */
  private parseJson(text: string): unknown {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```$/i, '');
    try {
      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  private describeSignals(signals: ScoreSignals, score: LeadScore): string {
    return [
      `Score calculado: ${score.score}/100.`,
      `Fatores: ${score.factors.map((f) => `${f.label} (+${f.points})`).join('; ') || 'nenhum'}.`,
      `Dias desde a última atividade: ${signals.daysSinceLastActivity ?? 'sem registro'}.`,
      `Valor em oportunidades abertas: ${(signals.openDealsValueCents / 100).toFixed(2)}.`,
      `Negócios ganhos: ${signals.wonDealsCount}.`,
      `Mensagens nos últimos 30 dias: ${signals.messagesLast30Days}.`,
    ].join(' ');
  }

  /**
   * Sinais vêm de SERVIÇOS DE DOMÍNIO (ADR-027): o módulo não consulta banco.
   * Como os services usam o client filtrado, o run herda tenant e RBAC.
   */
  private async collectSignals(contactId: string): Promise<ScoreSignals> {
    const contact = await this.contacts.get(contactId);
    const [deals, timeline, conversations] = await Promise.all([
      this.deals.listByContact(contactId),
      this.activities.list({ contactId }, 1),
      this.conversations.list({ contactId, status: 'all', limit: 20 }),
    ]);

    const openDealsValueCents = deals
      .filter((deal) => deal.status === 'open')
      .reduce((total, deal) => total + deal.amountCents, 0);
    const wonDealsCount = deals.filter((deal) => deal.status === 'won').length;

    const lastActivity = timeline.items[0]?.occurredAt;
    const daysSinceLastActivity = lastActivity
      ? Math.floor((Date.now() - new Date(lastActivity).getTime()) / (24 * 60 * 60 * 1000))
      : null;

    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let messagesLast30Days = 0;
    for (const conversation of conversations.items) {
      const page = await this.conversations.listMessages(conversation.id, { limit: 100 });
      messagesLast30Days += page.items.filter(
        (message) => new Date(message.createdAt).getTime() >= since,
      ).length;
    }

    return {
      daysSinceLastActivity,
      openDealsValueCents,
      wonDealsCount,
      messagesLast30Days,
      hasEmail: contact.emails.length > 0,
      hasPhone: contact.phones.length > 0,
    };
  }
}

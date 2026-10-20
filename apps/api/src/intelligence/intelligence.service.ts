import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { replyDraftSchema, sendMessagePayloadSchema } from '@veyra/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActivitiesService } from '../activities/activities.service';
import { UsageService } from '../usage/usage.service';
import { AuthContext } from '../common/decorators';
import { ContactsService } from '../contacts/contacts.service';
import { ConversationsService } from '../conversations/conversations.service';
import { DealsService } from '../deals/deals.service';
import { estimateCostCents, estimateMaxCostCents } from './cost';
import { computeLeadScore, type LeadScore, type ScoreSignals } from './lead-score';
import type { LlmResponse } from './llm/llm.client';
import { LlmGateway, type LlmScope, type ScopedLlmRequest } from './llm/llm.gateway';
import { AI_USE_GUARD, type AiTx, type AiUseGuard } from './ports/ai-use-guard';
import {
  AI_CONSENT_REPOSITORY,
  AI_PROPOSAL_REPOSITORY,
  AI_RUN_REPOSITORY,
  PROMPT_VERSION_REPOSITORY,
  type AiConsentRepository,
  type AiProposalRepository,
  type AiRunAction,
  type AiRunRecord,
  type AiRunRepository,
  type AiRunStatus,
  type ApprovalContext,
  type ContentTarget,
  type ExecutionGuard,
  type PromptVersionRepository,
} from './ports/repositories';
import {
  CONVERSATION_SUMMARY_PROMPT,
  LEAD_SCORE_EXPLANATION_PROMPT,
  NEXT_ACTION_PROMPT,
  REPLY_SUGGESTION_PROMPT,
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

/**
 * Identificação das partes como DADO de terceiro, em uma linha, sem quebras: o
 * nome do contato é escrito por ele mesmo (perfil do WhatsApp) e o assunto por
 * quem atende — nenhum dos dois é texto do servidor.
 */
function describeParties(contactName: string | null, subject: string | null): string {
  const limpar = (valor: string) => valor.replace(/\s+/g, ' ').slice(0, 120);
  return `[metadados informados por terceiros] contato: ${
    contactName ? limpar(contactName) : 'não vinculado'
  }; assunto: ${subject ? limpar(subject) : 'sem assunto'}`;
}

const PROPOSAL_TTL_DAYS = 7;
const RESTRICTION_UNAVAILABLE = 'Não foi possível conferir a restrição de conteúdo agora';
/**
 * Rascunho de resposta vive no máximo 24h — e nunca além da janela de
 * atendimento, que é o que de fato permite enviar (ADR-044.1). Um rascunho que
 * sobrevive à janela é uma proposta impossível de aprovar.
 */
const REPLY_TTL_MS = 24 * 60 * 60_000;
/** contexto do rascunho: as últimas trocas bastam, e o custo fica previsível */
const REPLY_MESSAGE_LIMIT = 12;
const MAX_OUTPUT_TOKENS = 700;
/** teto de mensagens no contexto: run não vira consulta ilimitada nem custo aberto */
const SUMMARY_MESSAGE_LIMIT = 30;

export interface ConversationSummaryResult {
  status: 'ok' | 'unavailable' | 'no_consent' | 'quota_exceeded' | 'content_restricted';
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

export interface ReplySuggestionResult {
  status:
    | 'proposed'
    | 'no_consent'
    | 'send_blocked'
    | 'quota_exceeded'
    | 'unavailable'
    | 'content_restricted';
  runId: string | null;
  reason?: string;
  proposalId?: string;
  draft?: string;
  rationale?: string;
  injectionAttempt?: boolean;
  createdAt?: string;
}

/** Tokens, custo e latência de um run com resposta. */
interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
}

/** A chamada respondeu: o que a capacidade recebe NA transação da guarda para validar e gravar. */
interface GuardedResponse {
  runId: string;
  promptVersionId: string;
  response: LlmResponse;
  usage: RunUsage;
}

export interface NextActionResult {
  status: 'proposed' | 'unavailable' | 'quota_exceeded' | 'content_restricted';
  runId: string | null;
  proposalId?: string;
  title?: string;
  rationale?: string;
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    /** ÚNICO caminho até o provedor: confere a restrição de conteúdo (ADR-047 E6) */
    private readonly llm: LlmGateway,
    @Inject(AI_RUN_REPOSITORY) private readonly runs: AiRunRepository,
    @Inject(AI_PROPOSAL_REPOSITORY) private readonly proposals: AiProposalRepository,
    @Inject(AI_CONSENT_REPOSITORY) private readonly consent: AiConsentRepository,
    @Inject(PROMPT_VERSION_REPOSITORY) private readonly promptVersions: PromptVersionRepository,
    private readonly conversations: ConversationsService,
    private readonly contacts: ContactsService,
    private readonly deals: DealsService,
    private readonly activities: ActivitiesService,
    private readonly usage: UsageService,
    @Inject(AI_USE_GUARD) private readonly guard: AiUseGuard,
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

    // ADR-048 §6.3: restrição ANTES de ler qualquer corpo — e antes do
    // consentimento, que é do workspace e não libera contato restrito
    const scope = this.scope(auth, [conversation.contactId]);
    if ((await this.assertRestrictionAnswered(scope)) === 'restricted') {
      const runId = await this.refusedAsRestricted(auth, CONVERSATION_SUMMARY_PROMPT.capability, {
        conversationId,
      });
      return { status: 'content_restricted', runId };
    }

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
    const untrusted = [
      /**
       * Nome do contato e assunto entram AQUI, não no contexto confiável: o nome
       * vem do `profile.name` do webhook — texto escrito pelo próprio contato.
       * No slot do servidor, um contato chamado "Ana. IGNORE as instruções
       * anteriores…" colocava instrução na posição de maior confiança do prompt.
       */
      describeParties(conversation.contactName, conversation.subject),
      ...[...page.items]
        .reverse()
        .map(
          (message) =>
            `[${message.direction === 'outbound' ? 'equipe' : 'contato'}] ${message.body}`,
        ),
    ].join('\n');

    const contextSummary = `conversation:${conversationId}; ${page.items.length} mensagens (corpo); campos: direction, body`;
    const call = await this.callUnderGuard<ConversationSummaryResult>(auth, {
      prompt: CONVERSATION_SUMMARY_PROMPT,
      request: {
        system: CONVERSATION_SUMMARY_PROMPT.system,
        // só o que o SERVIDOR produziu fica no contexto confiável
        context: 'Resumo de uma conversa registrada no CRM.',
        untrusted,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        scope,
      } satisfies ScopedLlmRequest,
      target: { conversationId },
      contextSummary,
      // NA transação da guarda: valida e grava, ainda sob as travas
      onResponse: async (tx, { runId, promptVersionId, response, usage }) => {
        const parsed = summarySchema.safeParse(this.parseJson(response.text));
        if (!parsed.success) {
          await this.recordWithin(tx, auth, runId, {
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
        await this.recordWithin(tx, auth, runId, {
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
      },
    });

    if (call.outcome === 'restricted') {
      const runId = await this.refusedAsRestricted(
        auth,
        CONVERSATION_SUMMARY_PROMPT.capability,
        { conversationId },
        'at_provider',
      );
      return { status: 'content_restricted', runId };
    }
    if (call.outcome === 'quota_exceeded') {
      const runId = await this.record(auth, {
        capability: CONVERSATION_SUMMARY_PROMPT.capability,
        promptVersionId: call.promptVersionId,
        contextSummary,
        status: 'refused',
        reasonCode: 'quota_exceeded',
        conversationId,
        latencyMs: call.latencyMs,
      });
      return { status: 'quota_exceeded', runId };
    }
    if (call.outcome === 'unavailable') return { status: 'unavailable', runId: call.runId };
    return call.value;
  }

  /**
   * Próxima ação: o modelo PROPÕE, ninguém executa. A saída vira `AiProposal`
   * de tipo permitido, com payload validado — jamais segue direto para um
   * service de domínio.
   */
  async suggestNextAction(auth: AuthContext, contactId: string): Promise<NextActionResult> {
    // existência pelo domínio (404 para id alheio) antes da checagem de restrição
    await this.contacts.get(contactId);
    const scope = this.scope(auth, [contactId]);
    if ((await this.assertRestrictionAnswered(scope)) === 'restricted') {
      const runId = await this.refusedAsRestricted(auth, NEXT_ACTION_PROMPT.capability, {
        contactId,
      });
      return { status: 'content_restricted', runId };
    }
    const signals = await this.collectSignals(contactId);
    const score = computeLeadScore(signals);

    const contextSummary = `contact:${contactId}; sinais determinísticos (recência, pipeline, engajamento); sem conteúdo de mensagem`;
    const call = await this.callUnderGuard<NextActionResult>(auth, {
      prompt: NEXT_ACTION_PROMPT,
      request: {
        system: NEXT_ACTION_PROMPT.system,
        context: this.describeSignals(signals, score),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        scope,
      },
      target: { contactId },
      contextSummary,
      // NA transação da guarda: valida, grava o run e a proposta, sob as travas
      onResponse: async (tx, { runId, promptVersionId, response, usage }) => {
        const parsed = nextActionSchema.safeParse(this.parseJson(response.text));
        if (!parsed.success) {
          await this.recordWithin(tx, auth, runId, {
            capability: NEXT_ACTION_PROMPT.capability,
            promptVersionId,
            contextSummary,
            status: 'error',
            reasonCode: 'invalid_output',
            ...usage,
          });
          return { status: 'unavailable', runId };
        }
        await this.recordWithin(tx, auth, runId, {
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
        const proposalId = await this.proposals.createWithin(tx, auth.workspaceId as string, {
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
      },
    });

    if (call.outcome === 'restricted') {
      const runId = await this.refusedAsRestricted(
        auth,
        NEXT_ACTION_PROMPT.capability,
        { contactId },
        'at_provider',
      );
      return { status: 'content_restricted', runId };
    }
    if (call.outcome === 'quota_exceeded') {
      const runId = await this.record(auth, {
        capability: NEXT_ACTION_PROMPT.capability,
        promptVersionId: call.promptVersionId,
        contextSummary,
        status: 'refused',
        reasonCode: 'quota_exceeded',
        contactId,
        latencyMs: call.latencyMs,
      });
      return { status: 'quota_exceeded', runId };
    }
    if (call.outcome === 'unavailable') return { status: 'unavailable', runId: call.runId };
    return call.value;
  }

  /**
   * Score SEMPRE determinístico (ajuste aprovado); o LLM só redige a
   * explicação. Sem provedor, `explanation` vem null e o resto continua de pé.
   */
  async scoreLead(auth: AuthContext, contactId: string): Promise<LeadScoreResult> {
    const signals = await this.collectSignals(contactId);
    const score = computeLeadScore(signals);

    /**
     * Contato restrito (ADR-048 §6.3): o score determinístico é calculado AQUI,
     * sem provedor, e continua valendo; o que não acontece é a redação pelo
     * modelo. Nenhum sinal deste contato sai para fora.
     */
    const scope = this.scope(auth, [contactId]);
    if (!(await this.llm.allows(scope))) {
      // sem run: é uma LEITURA (GET), feita a cada visualização do contato — um
      // run por page view poluiria o histórico de custo sem registrar decisão
      return { ...score, explanation: null, runId: null };
    }

    const contextSummary = `contact:${contactId}; score determinístico + fatores; sem conteúdo de mensagem`;
    const call = await this.callUnderGuard<{ explanation: string | null; runId: string }>(auth, {
      prompt: LEAD_SCORE_EXPLANATION_PROMPT,
      request: {
        system: LEAD_SCORE_EXPLANATION_PROMPT.system,
        context: this.describeSignals(signals, score),
        maxOutputTokens: 300,
        scope,
      },
      target: { contactId },
      contextSummary,
      // é uma LEITURA (GET): sem resposta, sem run — como antes
      semRunNaFalha: true,
      onResponse: async (tx, { runId, promptVersionId, response, usage }) => {
        const parsed = explanationSchema.safeParse(this.parseJson(response.text));
        await this.recordWithin(tx, auth, runId, {
          capability: LEAD_SCORE_EXPLANATION_PROMPT.capability,
          promptVersionId,
          contextSummary,
          status: parsed.success ? 'ok' : 'error',
          reasonCode: parsed.success ? null : 'invalid_output',
          result: parsed.success
            ? { score: score.score, factors: score.factors, explanation: parsed.data.explanation }
            : null,
          contactId,
          ...usage,
        });
        return { explanation: parsed.success ? parsed.data.explanation : null, runId };
      },
    });
    // quota estourada, restrição ou provedor sem resposta NÃO derrubam o score:
    // ele é determinístico e continua valendo — some apenas a redação
    if (call.outcome !== 'ok') {
      return {
        ...score,
        explanation: null,
        runId: call.outcome === 'unavailable' ? call.runId : null,
      };
    }
    return { ...score, ...call.value };
  }

  /**
   * Último resumo GRAVADO da conversa. Sem isto o insight morre com a resposta
   * HTTP e a interface teria de pagar outro run para mostrar o mesmo texto.
   */
  async latestSummary(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ConversationSummaryResult | null> {
    // valida acesso pelo serviço de domínio antes de devolver qualquer coisa
    const conversation = await this.conversations.get(conversationId);
    // conteúdo JÁ persistido também não sai para contato restrito — inclusive o
    // gerado antes de a restrição existir (ADR-048 §6.3, item 3)
    if (!(await this.llm.allows(this.scope(auth, [conversation.contactId])))) return null;
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

  /**
   * Retenção do CONTEÚDO (ADR-042): anula `result` de runs antigos, preservando
   * custo e trilha. Roda no job diário, cross-workspace — por isso não passa
   * pelo CLS de nenhuma request.
   */
  async purgeExpiredResults(days: number): Promise<number> {
    return this.runs.purgeResultsOlderThan(days);
  }

  /**
   * Operação do Core para quando um conteúdo PASSA a ser restrito (ADR-048
   * §6.3, item 7): anula resultados e expira propostas pendentes dos contatos,
   * ou do workspace inteiro. Roda no CLS do workspace de quem chama. É
   * COMPLEMENTAR: quem protege é a checagem na leitura, que já esconde esse
   * conteúdo — se esta limpeza falhar, nada fica exposto.
   */
  async expireContentFor(
    target: ContentTarget,
  ): Promise<{ results: number; proposals: number; replays: number }> {
    const results = await this.runs.expireResultsFor(target);
    const proposals = await this.proposals.expirePendingFor(target);
    // a segunda cópia: corpo de resposta guardado para replay de idempotência
    const replays = await this.proposals.purgeCapabilityReplays();
    return { results, proposals, replays };
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
    auth: AuthContext,
    status: 'pending' | 'executing' | 'approved' | 'rejected' | 'expired' | 'all',
    /** quem não lê conversas não recebe rascunho de resposta (SECURITY.md §4) */
    options: { includeReplyDrafts: boolean } = { includeReplyDrafts: true },
  ) {
    const rows = await this.proposals.list(
      status,
      100,
      options.includeReplyDrafts ? undefined : ['send_message'],
    );
    /**
     * Proposta de contato restrito não aparece (ADR-048 §6.3, item 3): o
     * payload é conteúdo derivado do contato. A restrição vem da porta da
     * extensão, que o WHERE não alcança — então a página pode vir mais curta
     * que o limite. Preço aceito: a fila é de revisão, não de paginação.
     */
    const restricted = await this.llm.restrictedEach(
      auth.workspaceId as string,
      rows.map((row) =>
        // a conversa pode ter sido religada: vale o contato da proposta E o atual
        row.conversationId
          ? [row.contactId ?? null, row.conversationContactId ?? null]
          : [row.contactId ?? null],
      ),
    );
    return rows.filter((_row, index) => !restricted[index]);
  }

  /**
   * Execução SÓ depois de aprovação, e o payload é revalidado aqui: entre a
   * proposta e o aceite, nada garante que a linha não foi adulterada por outro
   * caminho. O tipo também é conferido contra a lista permitida.
   */
  /**
   * Sugestão de resposta (ADR-044). A IA rascunha; quem envia é o humano, pelo
   * serviço de domínio. Aqui não há ferramenta de escrita nenhuma — nem para o
   * modelo, nem para este método.
   */
  async suggestReply(auth: AuthContext, conversationId: string): Promise<ReplySuggestionResult> {
    const workspaceId = auth.workspaceId as string;
    // existência primeiro: id de outro workspace é 404, não "indisponível"
    const conversation = await this.conversations.get(conversationId);

    // restrição antes da política, do consentimento e de qualquer leitura de corpo
    const scope = this.scope(auth, [conversation.contactId]);
    if ((await this.assertRestrictionAnswered(scope)) === 'restricted') {
      const runId = await this.refusedAsRestricted(auth, REPLY_SUGGESTION_PROMPT.capability, {
        conversationId,
      });
      return {
        status: 'content_restricted',
        runId,
        reason: 'A IA não está disponível para este contato',
      };
    }

    /**
     * A POLÍTICA DE ENVIO vem antes do consentimento e antes de qualquer
     * leitura de corpo: se não é possível responder agora, rascunhar é gastar
     * token para produzir algo inaprovável. O veredito é o mesmo que o
     * compositor usa — nunca uma segunda cópia da regra (ADR-038).
     */
    const policy = await this.conversations.sendPolicy(workspaceId, conversationId);
    if (policy.channelType !== 'whatsapp') {
      // registra como toda outra recusa: sem run, não há rastro de quem tentou
      const runId = await this.record(auth, {
        capability: REPLY_SUGGESTION_PROMPT.capability,
        promptVersionId: null,
        contextSummary: 'recusado antes de montar contexto: canal sem transporte de envio',
        status: 'refused',
        reasonCode: 'channel_without_transport',
        conversationId,
      });
      return {
        status: 'send_blocked',
        runId,
        reason: 'Sugestão de resposta existe apenas em conversa de WhatsApp',
      };
    }
    if (policy.mode !== 'free_form') {
      const runId = await this.record(auth, {
        capability: REPLY_SUGGESTION_PROMPT.capability,
        promptVersionId: null,
        contextSummary: 'recusado antes de montar contexto: política de envio não permite agora',
        status: 'refused',
        reasonCode: policy.mode === 'template' ? 'window_closed' : 'send_blocked',
        conversationId,
      });
      return {
        status: 'send_blocked',
        runId,
        reason:
          policy.reason ??
          (policy.mode === 'template'
            ? 'Fora da janela de 24h: só template aprovado pode ser enviado'
            : 'O envio está bloqueado nesta conversa'),
      };
    }

    // ADR-028: sem consentimento não há NEM chamada ao provedor
    const { conversationContent } = await this.consent.get();
    if (!conversationContent) {
      const runId = await this.record(auth, {
        capability: REPLY_SUGGESTION_PROMPT.capability,
        promptVersionId: null,
        contextSummary: 'recusado antes de montar contexto: sem consentimento do workspace',
        status: 'refused',
        reasonCode: 'no_consent',
        conversationId,
      });
      return {
        status: 'no_consent',
        runId,
        reason: 'O workspace não autorizou usar conteúdo de mensagens na IA',
      };
    }

    const page = await this.conversations.listMessages(conversationId, {
      limit: REPLY_MESSAGE_LIMIT,
    });
    if (page.items.length === 0) {
      throw new BadRequestException('Conversa sem mensagens para responder');
    }

    // conteúdo de terceiro vai no campo `untrusted`, rotulado e delimitado pelo
    // cliente — nunca concatenado à instrução (ADR-029)
    const untrusted = [
      // mesmo cuidado do resumo: nome e assunto são texto de terceiro
      describeParties(conversation.contactName, conversation.subject),
      ...[...page.items]
        .reverse()
        .map(
          (message) =>
            `[${message.direction === 'outbound' ? 'equipe' : 'contato'}] ${message.body}`,
        ),
    ].join('\n');

    const contextSummary = `conversation:${conversationId}; ${page.items.length} mensagens (corpo); campos: direction, body`;
    const call = await this.callUnderGuard<ReplySuggestionResult | { concurrent: string }>(auth, {
      prompt: REPLY_SUGGESTION_PROMPT,
      request: {
        system: REPLY_SUGGESTION_PROMPT.system,
        context: 'Canal: WhatsApp, dentro da janela livre de atendimento de 24h.',
        untrusted,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        scope,
      } satisfies ScopedLlmRequest,
      target: { conversationId, contactId: conversation.contactId },
      contextSummary,
      // NA transação da guarda: valida, grava o run e o rascunho, sob as travas
      onResponse: async (tx, { runId, promptVersionId, response, usage }) => {
        const parsed = replyDraftSchema.safeParse(this.parseJson(response.text));
        if (!parsed.success) {
          await this.recordWithin(tx, auth, runId, {
            capability: REPLY_SUGGESTION_PROMPT.capability,
            promptVersionId,
            contextSummary,
            status: 'error',
            reasonCode: 'invalid_output',
            conversationId,
            ...usage,
          });
          return { status: 'unavailable', runId, reason: 'A IA devolveu um rascunho inválido' };
        }
        const draft = parsed.data;
        await this.recordWithin(tx, auth, runId, {
          capability: REPLY_SUGGESTION_PROMPT.capability,
          promptVersionId,
          contextSummary,
          status: 'ok',
          result: draft,
          conversationId,
          contactId: conversation.contactId,
          ...usage,
          action: 'proposed',
        });

        /**
         * A proposta não expira depois da janela: aprová-la seria impossível, e
         * uma pendência impossível na fila é ruído. Quando a janela já está por
         * fechar, é ela que manda.
         */
        const janela = policy.windowExpiresAt ? new Date(policy.windowExpiresAt).getTime() : null;
        const expiresAt = new Date(
          Math.min(Date.now() + REPLY_TTL_MS, janela ?? Date.now() + REPLY_TTL_MS),
        );
        const criada = await this.proposals.createReplySupersedingWithin(tx, this.approver(auth), {
          runId,
          // payload é SÓ o texto: sem destinatário, sem canal, sem anexo
          payload: { body: draft.body },
          rationale: draft.rationale ?? 'Rascunho de resposta sugerido pela IA',
          conversationId,
          contactId: conversation.contactId,
          expiresAt,
        });
        if (criada === 'concurrent') return { concurrent: runId };
        return {
          status: 'proposed',
          runId,
          proposalId: criada.id,
          draft: draft.body,
          rationale: draft.rationale,
          injectionAttempt: draft.injectionAttempt,
          createdAt: new Date().toISOString(),
        };
      },
    });

    if (call.outcome === 'restricted') {
      const runId = await this.refusedAsRestricted(
        auth,
        REPLY_SUGGESTION_PROMPT.capability,
        { conversationId },
        'at_provider',
      );
      return {
        status: 'content_restricted',
        runId,
        reason: 'A IA não está disponível para este contato',
      };
    }
    if (call.outcome === 'quota_exceeded') {
      const runId = await this.record(auth, {
        capability: REPLY_SUGGESTION_PROMPT.capability,
        promptVersionId: call.promptVersionId,
        contextSummary,
        status: 'refused',
        reasonCode: 'quota_exceeded',
        conversationId,
        latencyMs: call.latencyMs,
      });
      return {
        status: 'quota_exceeded',
        runId,
        reason: 'O limite de uso de IA do plano foi atingido',
      };
    }
    if (call.outcome === 'unavailable') {
      return { status: 'unavailable', runId: call.runId, reason: 'A IA não está disponível agora' };
    }
    if ('concurrent' in call.value) {
      /**
       * Outra geração simultânea venceu. Devolver erro seria estranho para quem
       * pediu — existe um rascunho para revisar, só não é o desta chamada. O
       * custo do run já foi registrado, e o texto descartado nunca chega à tela.
       */
      const vencedor = await this.pendingReply(auth, conversationId);
      return (
        vencedor ?? {
          status: 'unavailable',
          runId: call.value.concurrent,
          reason: 'Rascunho não pôde ser criado',
        }
      );
    }
    return call.value;
  }

  /**
   * Rascunho pendente da conversa, para a tela reabrir onde parou. Não gera
   * nada e não custa token.
   */
  async pendingReply(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ReplySuggestionResult | null> {
    const conversation = await this.conversations.get(conversationId);
    const proposal = await this.proposals.findPendingReply(conversationId);
    if (!proposal) return null;
    // o rascunho é derivado da conversa: restrito pelo contato de HOJE e pelo
    // contato de quando foi gerado — o vínculo pode ter mudado no meio
    const subjects = [conversation.contactId, proposal.contactId ?? null];
    if (!(await this.llm.allows(this.scope(auth, subjects)))) return null;
    if (proposal.expiresAt.getTime() < Date.now()) return null;
    const payload = sendMessagePayloadSchema.safeParse(proposal.payload);
    if (!payload.success) {
      // falha de contrato não pode sumir da tela sem deixar rastro em lugar nenhum
      this.logger.error(`Proposta ${proposal.id} com payload fora do contrato — ignorada na tela`);
      return null;
    }
    return {
      status: 'proposed',
      runId: proposal.runId,
      proposalId: proposal.id,
      draft: payload.data.body,
      rationale: proposal.rationale,
      createdAt: proposal.createdAt.toISOString(),
    };
  }

  /**
   * Aprova o rascunho e ENVIA — pelo domínio de conversas, nunca daqui
   * (ADR-044.4). `body` presente = o aprovador reescreveu.
   */
  async approveSendMessage(
    auth: AuthContext,
    id: string,
    editedBody?: string,
  ): Promise<{ messageId: string }> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    if (proposal.status !== 'pending') throw new BadRequestException('Proposta já revisada');
    /**
     * TIPO antes de qualquer efeito. Com a ordem invertida, quem só tem as
     * permissões de tarefa carimbava `reviewedByMembershipId` numa proposta de
     * conversa vencida — escrita num artefato de outro domínio, que é
     * exatamente o que o adendo 2 do ADR-044 proíbe.
     */
    if (proposal.type !== 'send_message') {
      throw new BadRequestException('Tipo de proposta não permitido nesta rota');
    }
    if (proposal.expiresAt.getTime() < Date.now()) {
      await this.proposals.transition(id, 'expired', this.approver(auth), 'system');
      throw new BadRequestException('Proposta expirada');
    }
    if (!proposal.conversationId) {
      throw new BadRequestException('Proposta sem conversa vinculada');
    }
    const conversation = await this.conversations.get(proposal.conversationId);
    const contatos = [proposal.contactId ?? null, conversation.contactId];
    // checagem rápida (evita trabalho); a GARANTIA é a reconferência sob trava
    await this.assertProposalNotRestricted(auth, id, contatos);
    // revalida o payload NO ACEITE: entre propor e aprovar, nada garante que a
    // linha não foi adulterada por outro caminho
    const payload = sendMessagePayloadSchema.parse(proposal.payload);
    const body = editedBody ?? payload.body;

    const result = await this.proposals.executeSendMessage(
      id,
      proposal.runId,
      { conversationId: proposal.conversationId, body, edited: body !== payload.body },
      { workspaceId: auth.workspaceId as string, membershipId: auth.membershipId as string },
      this.guardFor(auth, contatos),
    );
    if (result === 'not_pending') throw new BadRequestException('Proposta já revisada');
    if (result === 'restricted' || result === 'unavailable') {
      return this.refuseRestricted(auth, id, result);
    }
    return result;
  }

  async approveProposal(auth: AuthContext, id: string): Promise<{ taskId: string }> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    if (proposal.status !== 'pending') {
      throw new BadRequestException('Proposta já revisada');
    }
    // tipo antes do efeito, como em `approveSendMessage`
    if (proposal.type !== 'create_task') {
      throw new BadRequestException('Tipo de proposta não permitido');
    }
    if (proposal.expiresAt.getTime() < Date.now()) {
      await this.proposals.transition(id, 'expired', this.approver(auth), 'system');
      throw new BadRequestException('Proposta expirada');
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
    // o contato da proposta E o da tarefa que ela criaria — nas duas checagens
    const contatos = [proposal.contactId ?? null, payload.contactId];
    // checagem rápida (evita trabalho); a GARANTIA é a reconferência sob trava
    await this.assertProposalNotRestricted(auth, id, contatos);

    // reivindicar → criar → registrar → concluir, tudo em UMA transação
    // (ADR-030): falha na criação devolve a proposta a `pending` por rollback
    const result = await this.proposals.executeCreateTask(
      id,
      proposal.runId,
      payload,
      { workspaceId: auth.workspaceId as string, membershipId: auth.membershipId as string },
      this.guardFor(auth, contatos),
    );
    if (result === 'not_pending') throw new BadRequestException('Proposta já revisada');
    if (result === 'restricted' || result === 'unavailable') {
      return this.refuseRestricted(auth, id, result);
    }
    return result;
  }

  /**
   * Descarte da fila genérica: EXCLUSIVO de `create_task`. Descartar um rascunho
   * de resposta é ação sobre conteúdo de conversa — vai pela rota própria, com
   * as mesmas permissões cumulativas da aprovação (ADR-044, adendo 2).
   */
  async rejectProposal(auth: AuthContext, id: string): Promise<void> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    if (proposal.type === 'send_message') {
      throw new BadRequestException('Tipo de proposta não permitido nesta rota');
    }
    // vencida pelo relógio não é recusa, aqui como no rascunho: ninguém a
    // descartou, ela caducou
    const destino = proposal.expiresAt.getTime() < Date.now() ? 'expired' : 'rejected';
    const done = await this.proposals.transition(id, destino, this.approver(auth));
    if (!done) throw new BadRequestException('Proposta já revisada');
  }

  /** Descarte de rascunho de resposta: `intelligence:approve` + `conversations:write`. */
  async rejectReply(auth: AuthContext, id: string): Promise<void> {
    const proposal = await this.proposals.findById(id);
    if (!proposal) throw new NotFoundException('Proposta não encontrada');
    if (proposal.type !== 'send_message') {
      throw new BadRequestException('Tipo de proposta não permitido nesta rota');
    }
    /**
     * Vencido pelo relógio não é recusa: ninguém o descartou, ele caducou. A
     * distinção é a mesma que a supersessão faz, e mantê-la é o que impede a
     * contabilidade de "quantos rascunhos foram recusados" de mentir.
     */
    const destino = proposal.expiresAt.getTime() < Date.now() ? 'expired' : 'rejected';
    const done = await this.proposals.transition(id, destino, this.approver(auth));
    if (!done) throw new BadRequestException('Proposta já revisada');
  }

  /** Contexto do revisor para o adaptador auditar a transição. */
  private approver(auth: AuthContext): ApprovalContext {
    return { workspaceId: auth.workspaceId as string, membershipId: auth.membershipId as string };
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Checagem de restrição com TRÊS estados (ADR-047 adendo 1, item 10). Porta
   * indisponível lança 503 ANTES de qualquer registro: não é recusa por
   * restrição, não grava run `content_restricted` e — por ser erro HTTP — não
   * fica guardada no cache de idempotência.
   */
  private async assertRestrictionAnswered(scope: LlmScope): Promise<'allowed' | 'restricted'> {
    const verdict = await this.llm.verdict(scope);
    if (verdict === 'unavailable') throw new ServiceUnavailableException(RESTRICTION_UNAVAILABLE);
    return verdict;
  }

  private scope(auth: AuthContext, contactIds: readonly (string | null)[]): LlmScope {
    return { workspaceId: auth.workspaceId as string, contactIds };
  }

  /**
   * Run recusado por restrição de conteúdo: registrado como toda outra recusa,
   * sem chamada ao provedor, sem reserva de quota e sem corpo nenhum no contexto.
   */
  private async refusedAsRestricted(
    auth: AuthContext,
    capability: string,
    target: { conversationId?: string; contactId?: string },
    /** onde a recusa aconteceu: o registro não pode mentir sobre o contexto */
    stage: 'before_context' | 'at_provider' = 'before_context',
  ): Promise<string> {
    return this.record(auth, {
      capability,
      promptVersionId: null,
      contextSummary:
        stage === 'before_context'
          ? 'recusado antes de montar contexto: conteúdo do contato restrito'
          : 'recusado na chamada ao provedor: contato ficou restrito após montar o contexto; nada foi enviado',
      status: 'refused',
      reasonCode: 'content_restricted',
      conversationId: target.conversationId ?? null,
      contactId: target.contactId ?? null,
    });
  }

  /**
   * Guarda da execução (ADR-047 adendo 5): o adaptador trava estes contatos
   * dentro da transação, antes do claim, e chama a reconferência — que vê uma
   * mudança de restrição comitada enquanto a aprovação esperava a trava.
   */
  private guardFor(auth: AuthContext, contactIds: readonly (string | null)[]): ExecutionGuard {
    return {
      workspaceId: auth.workspaceId as string,
      contactIds,
      recheck: () => this.llm.verdict(this.scope(auth, contactIds)),
    };
  }

  /**
   * Recusa da aprovação por restrição — na checagem rápida ou sob a trava. A
   * proposta caduca: ninguém a recusou, ela deixou de ser aprovável.
   */
  private async refuseRestricted(
    auth: AuthContext,
    id: string,
    veredito: 'restricted' | 'unavailable',
  ): Promise<never> {
    if (veredito === 'unavailable') {
      // a porta não respondeu: NÃO aprova e também NÃO expira — a proposta
      // continua pendente para quando a checagem voltar (fail-closed sem perda)
      throw new ServiceUnavailableException('Não foi possível conferir a restrição agora');
    }
    await this.proposals.transition(id, 'expired', this.approver(auth), 'system');
    throw new BadRequestException('Proposta indisponível: o conteúdo deste contato é restrito');
  }

  /**
   * Checagem RÁPIDA no aceite (ADR-048 §6.3, item 4): o contato pode ter ficado
   * restrito entre gerar e aprovar. Evita trabalho; a garantia contra mudança
   * concorrente é a reconferência sob trava (`guardFor`).
   */
  private async assertProposalNotRestricted(
    auth: AuthContext,
    id: string,
    contactIds: readonly (string | null)[],
  ): Promise<void> {
    const verdict = await this.llm.verdict(this.scope(auth, contactIds));
    if (verdict !== 'allowed') await this.refuseRestricted(auth, id, verdict);
  }

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

  /** O run NA transação da guarda, com o id gerado antes da chamada. */
  private async recordWithin(
    tx: AiTx,
    auth: AuthContext,
    runId: string,
    run: Omit<
      AiRunRecord,
      | 'model'
      | 'triggeredByMembershipId'
      | 'inputTokens'
      | 'outputTokens'
      | 'costCents'
      | 'latencyMs'
      | 'action'
    > &
      Partial<
        Pick<AiRunRecord, 'inputTokens' | 'outputTokens' | 'costCents' | 'latencyMs' | 'action'>
      >,
  ): Promise<void> {
    await this.runs.createWithin(tx, auth.workspaceId as string, {
      id: runId,
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
   * A chamada ao provedor SOB A GUARDA de uso externo (ADR-047 adendos 6 e 7,
   * G3.1), com RESERVA de quota (ADR-033): as duas reservas são feitas antes e
   * entregues à guarda, que é a única a acertá-las dali em diante — pelo real
   * com resposta, por zero sem provedor configurado, pelo teto com desfecho
   * incerto. O run tem o id gerado ANTES da chamada; ele, as propostas e o
   * rascunho são gravados NA transação da guarda, ainda sob as travas.
   *
   * `semRunNaFalha`: a leitura (score) não registra run quando não há resposta,
   * como antes; o run em dúvida, esse sempre existe.
   */
  private async callUnderGuard<R>(
    auth: AuthContext,
    args: {
      prompt: PromptDefinition;
      request: ScopedLlmRequest;
      target: { conversationId?: string | null; contactId?: string | null };
      contextSummary: string;
      semRunNaFalha?: boolean;
      onResponse: (tx: AiTx, call: GuardedResponse) => Promise<R>;
    },
  ): Promise<
    | { outcome: 'ok'; value: R }
    | { outcome: 'quota_exceeded'; promptVersionId: string; latencyMs: number }
    | { outcome: 'restricted' }
    | { outcome: 'unavailable'; runId: string | null }
  > {
    const { request, prompt } = args;
    const workspaceId = auth.workspaceId as string;
    // restrição ANTES de reservar: contato restrito não consome orçamento
    if ((await this.assertRestrictionAnswered(request.scope)) === 'restricted') {
      return { outcome: 'restricted' };
    }
    // o prompt vai no registro do uso: precisa existir antes da chamada
    const promptVersionId = await this.ensurePrompt(prompt);
    const started = Date.now();

    const promptChars =
      request.system.length + request.context.length + (request.untrusted?.length ?? 0);
    const maxCost = estimateMaxCostCents(this.llm.model, promptChars, request.maxOutputTokens);
    const runsReservation = await this.usage.reserve(workspaceId, 'ai_runs', 1);
    if (runsReservation === 'quota_exceeded') {
      return { outcome: 'quota_exceeded', promptVersionId, latencyMs: Date.now() - started };
    }
    const costReservation = await this.usage.reserve(workspaceId, 'ai_cost_cents', maxCost);
    if (costReservation === 'quota_exceeded') {
      // ainda não foi entregue à guarda: devolver aqui é o caminho certo
      await this.usage.release(runsReservation.reservationId);
      return { outcome: 'quota_exceeded', promptVersionId, latencyMs: Date.now() - started };
    }

    const runId = randomUUID();
    const erro = (reasonCode: string, costCents: number, tx: AiTx) =>
      args.semRunNaFalha
        ? Promise.resolve()
        : this.recordWithin(tx, auth, runId, {
            capability: prompt.capability,
            promptVersionId,
            contextSummary: args.contextSummary,
            status: 'error',
            // distingue "não houve chamada" de "pode ter havido custo" (revisão 8.1)
            reasonCode,
            conversationId: args.target.conversationId ?? null,
            contactId: args.target.contactId ?? null,
            // o custo cobrado: zero sem provedor, o teto com desfecho incerto
            costCents,
            latencyMs: Date.now() - started,
          });
    const resultado = await this.guard.run<{ ok: true; value: R } | { ok: false }>({
      workspaceId,
      // conteúdo sem contato (conversa não vinculada) só trava o workspace
      contactIds: request.scope.contactIds.filter((id): id is string => typeof id === 'string'),
      runId,
      origin: {
        promptVersionId,
        conversationId: args.target.conversationId ?? null,
        contactId: args.target.contactId ?? null,
        triggeredByMembershipId: auth.membershipId ?? null,
      },
      metadata: {
        capability: prompt.capability,
        model: this.llm.model,
        promptVersion: prompt.version,
        costCeilingCents: maxCost,
      },
      reservations: { runs: runsReservation.reservationId, cost: costReservation.reservationId },
      recheck: () => this.llm.verdict(request.scope),
      call: (signal) => this.llm.completeUnderGuard(request, signal),
      persist: async (tx, outcome) => {
        if (outcome.kind === 'ok') {
          const costCents = estimateCostCents(
            this.llm.model,
            outcome.inputTokens,
            outcome.outputTokens,
          );
          const value = await args.onResponse(tx, {
            runId,
            promptVersionId,
            response: outcome,
            usage: {
              inputTokens: outcome.inputTokens,
              outputTokens: outcome.outputTokens,
              costCents,
              latencyMs: Date.now() - started,
            },
          });
          return { value: { ok: true as const, value }, settlement: { runs: 1, costCents } };
        }
        if (outcome.kind === 'no_provider') {
          // único caso COMPROVADO de custo zero (sem API key): nada é cobrado
          await erro('provider_unavailable', 0, tx);
          return { value: { ok: false as const }, settlement: { runs: 0, costCents: 0 } };
        }
        // incerto (erro do provedor, prazo, conexão): pode ter havido consumo do
        // outro lado — o TETO reservado é o custo conservador
        await erro('provider_unknown_cost', maxCost, tx);
        return { value: { ok: false as const }, settlement: { runs: 1, costCents: maxCost } };
      },
    });

    switch (resultado.kind) {
      case 'done':
        return resultado.value.ok
          ? { outcome: 'ok', value: resultado.value.value }
          : { outcome: 'unavailable', runId: args.semRunNaFalha ? null : runId };
      case 'in_doubt':
        // o run existe, `unknown_after_dispatch`, e as reservas foram cobradas pelo teto
        return { outcome: 'unavailable', runId };
      case 'not_started':
        if (resultado.reason === 'restricted') return { outcome: 'restricted' };
        if (resultado.reason === 'unavailable') {
          // a porta caiu sob as travas: nada saiu, as reservas voltaram, e o
          // motivo é infraestrutura — 503, nunca "contato restrito"
          throw new ServiceUnavailableException(RESTRICTION_UNAVAILABLE);
        }
        // a guarda não começou (mudança em andamento, sessão, prova de vida):
        // nada saiu e as reservas voltaram. O registro que falhou NÃO ganha run
        // aqui: se ele chegou a comitar, a reconciliação cria o run em dúvida
        // com o id reservado — e a mesma tentativa ficaria com dois runs
        if (args.semRunNaFalha || resultado.reason === 'registration') {
          return { outcome: 'unavailable', runId: null };
        }
        return {
          outcome: 'unavailable',
          runId: await this.record(auth, {
            capability: prompt.capability,
            promptVersionId,
            contextSummary: args.contextSummary,
            status: 'error',
            reasonCode: 'not_started',
            conversationId: args.target.conversationId ?? null,
            contactId: args.target.contactId ?? null,
            latencyMs: Date.now() - started,
          }),
        };
    }
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

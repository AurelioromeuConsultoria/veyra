import { z } from 'zod';

export const aiConsentSchema = z
  .object({
    /** corpo de mensagem pode entrar no prompt? nasce FALSE (ADR-028) */
    conversationContent: z.boolean(),
  })
  .strict();
export type AiConsentInput = z.infer<typeof aiConsentSchema>;

/**
 * Rascunho de resposta (ADR-044). O modelo devolve APENAS texto: sem
 * destinatário, sem canal, sem anexo. Não há tool de escrita para ele chamar —
 * a contenção de injection é a ausência de superfície, não o prompt.
 *
 * O teto de 2000 caracteres é DELIBERADAMENTE mais estreito que o do envio à
 * mão (10000, `conversations.ts`): resposta de atendimento é curta, e um limite
 * apertado reduz o que uma saída anômala consegue despejar na tela de revisão.
 * O prompt pede 900 — sugestão ao modelo, não garantia; quem garante é este
 * schema, e o do aceite tem o mesmo teto para que editar não amplie o limite.
 */
export const replyDraftSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
    rationale: z.string().trim().max(300).optional(),
    /** o modelo detectou tentativa de instrução no conteúdo do contato */
    injectionAttempt: z.boolean().optional(),
  })
  .strict();
export type ReplyDraftInput = z.infer<typeof replyDraftSchema>;

/** Payload persistido na `AiProposal` do tipo `send_message`. */
export const sendMessagePayloadSchema = z
  .object({
    body: z.string().trim().min(1).max(2000),
  })
  .strict();
export type SendMessagePayload = z.infer<typeof sendMessagePayloadSchema>;

/**
 * Aprovar o rascunho. `body` ausente = aprova como a IA escreveu; presente =
 * o aprovador reescreveu, e a autoria da mensagem passa a ser dele (ADR-044.8).
 */
export const approveSendMessageSchema = z
  .object({
    body: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ApproveSendMessageInput = z.infer<typeof approveSendMessageSchema>;

export const listProposalsSchema = z.object({
  status: z
    .enum(['pending', 'executing', 'approved', 'rejected', 'expired', 'all'])
    .default('pending'),
});
export type ListProposalsInput = z.infer<typeof listProposalsSchema>;

export const listRunsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListRunsInput = z.infer<typeof listRunsSchema>;

export type AiProposalType = 'create_task' | 'send_message';

export interface AiConsentDto {
  conversationContent: boolean;
}

/**
 * `content_restricted`: o contato está sob restrição de conteúdo para IA
 * (ADR-047 E6, ADR-048 §6). Nada foi enviado ao provedor nem reservado da quota.
 */
export interface ConversationSummaryDto {
  status: 'ok' | 'unavailable' | 'no_consent' | 'quota_exceeded' | 'content_restricted';
  runId: string | null;
  subject?: string;
  summary?: string;
  pendencies?: string[];
  sentiment?: 'positivo' | 'neutro' | 'negativo';
  /** o modelo detectou tentativa de instrução no conteúdo do contato */
  injectionAttempt?: boolean;
}

export interface ScoreFactorDto {
  key: string;
  label: string;
  points: number;
}

export interface LeadScoreDto {
  score: number;
  factors: ScoreFactorDto[];
  /** null quando não há provedor: o score continua valendo */
  explanation: string | null;
  runId: string | null;
}

export interface NextActionDto {
  status: 'proposed' | 'unavailable' | 'quota_exceeded' | 'content_restricted';
  runId: string | null;
  proposalId?: string;
  title?: string;
  rationale?: string;
}

export interface AiProposalDto {
  id: string;
  type: AiProposalType;
  payload: Record<string, unknown>;
  rationale: string;
  status: 'pending' | 'executing' | 'approved' | 'rejected' | 'expired';
  contactId: string | null;
  dealId: string | null;
  conversationId: string | null;
  reviewedByMembershipId: string | null;
  reviewedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/**
 * Visão de CUSTO e histórico. Deliberadamente SEM o resultado: ele pode conter
 * texto derivado de conversa, e quem vê custo (workspace:manage) não é
 * necessariamente quem pode ler conversas. O resultado é servido pelo endpoint
 * do alvo, com a permissão do domínio.
 */
export interface AiRunDto {
  id: string;
  capability: string;
  model: string;
  status: 'ok' | 'refused' | 'error';
  reasonCode: string | null;
  /** descrição do contexto — nunca o payload */
  contextSummary: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * `null` = valor MONETÁRIO omitido porque quem pede não tem `billing:manage`.
   * Tokens e latência ficam: são diagnóstico de administração. Dólar é dado
   * comercial, e por execução é ainda mais granular que o total do período
   * (ADR-041).
   */
  costCents: number | null;
  latencyMs: number;
  action: 'none' | 'proposed' | 'executed';
  createdAt: string;
}

export interface AiUsageDto {
  /** `null` = omitido por falta de `billing:manage` (ADR-041) */
  totalCostCents: number | null;
  /** true = os valores monetários foram omitidos por falta de `billing:manage` */
  monetaryRedacted?: boolean;
  runs: AiRunDto[];
}

/**
 * Sugestão de resposta. Os motivos de indisponibilidade vêm do SERVIDOR: a UI
 * não recalcula janela, opt-in nem quota — reimplementar a política no front
 * criaria duas versões, e a do front seria a errada (ADR-044).
 */
export interface ReplySuggestionDto {
  status:
    | 'proposed'
    /** `AiConsent.conversationContent` desligado: não houve chamada ao modelo */
    | 'no_consent'
    /** política de envio recusa AGORA: janela fechada, opt-in, quota, canal */
    | 'send_blocked'
    /** teto de custo de IA do plano */
    | 'quota_exceeded'
    /** provedor ausente, erro ou saída inválida */
    | 'unavailable'
    /** contato sob restrição de conteúdo para IA (ADR-048 §6): nada saiu */
    | 'content_restricted';
  runId: string | null;
  /** motivo em pt-BR quando não há sugestão utilizável */
  reason?: string;
  proposalId?: string;
  /** rascunho editável antes de aprovar */
  draft?: string;
  rationale?: string;
  injectionAttempt?: boolean;
  createdAt?: string;
}

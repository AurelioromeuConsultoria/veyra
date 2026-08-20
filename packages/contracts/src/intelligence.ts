import { z } from 'zod';

export const aiConsentSchema = z
  .object({
    /** corpo de mensagem pode entrar no prompt? nasce FALSE (ADR-028) */
    conversationContent: z.boolean(),
  })
  .strict();
export type AiConsentInput = z.infer<typeof aiConsentSchema>;

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

export interface AiConsentDto {
  conversationContent: boolean;
}

export interface ConversationSummaryDto {
  status: 'ok' | 'unavailable' | 'no_consent' | 'quota_exceeded';
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
  status: 'proposed' | 'unavailable' | 'quota_exceeded';
  runId: string | null;
  proposalId?: string;
  title?: string;
  rationale?: string;
}

export interface AiProposalDto {
  id: string;
  type: 'create_task';
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
  costCents: number;
  latencyMs: number;
  action: 'none' | 'proposed' | 'executed';
  createdAt: string;
}

export interface AiUsageDto {
  totalCostCents: number;
  runs: AiRunDto[];
}

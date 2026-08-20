/**
 * PORTAS do módulo (ADR-027). O módulo `intelligence` NUNCA importa Prisma:
 * declara o que precisa como interface, e os adaptadores vivem fora, em
 * `src/intelligence-persistence/`. É isso que torna o banimento de import
 * ABSOLUTO — sem pasta de exceção, sem julgamento sobre "o que é escrituração".
 *
 * Os tipos aqui são DTOs de fronteira: nada de tipos gerados pelo Prisma.
 */

export const AI_RUN_REPOSITORY = Symbol('AI_RUN_REPOSITORY');
export const AI_PROPOSAL_REPOSITORY = Symbol('AI_PROPOSAL_REPOSITORY');
export const AI_CONSENT_REPOSITORY = Symbol('AI_CONSENT_REPOSITORY');

export type AiRunStatus = 'ok' | 'refused' | 'error';
export type AiRunAction = 'none' | 'proposed' | 'executed';
export type AiProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type AiProposalType = 'create_task';

/**
 * Registro de um run. `contextSummary` é a DESCRIÇÃO do contexto (quais
 * entidades e campos), nunca o payload; `reasonCode` é código curto, nunca
 * stack trace nem mensagem do provedor.
 */
export interface AiRunRecord {
  capability: string;
  promptVersionId: string | null;
  model: string;
  contextSummary: string;
  status: AiRunStatus;
  reasonCode?: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
  action: AiRunAction;
  triggeredByMembershipId: string | null;
}

export interface AiRunSummary extends AiRunRecord {
  id: string;
  createdAt: Date;
}

export interface AiRunRepository {
  create(workspaceId: string, run: AiRunRecord): Promise<string>;
  list(limit: number): Promise<AiRunSummary[]>;
  totalCostCents(): Promise<number>;
}

export interface AiProposalInput {
  runId: string;
  type: AiProposalType;
  payload: Record<string, unknown>;
  rationale: string;
  contactId?: string | null;
  dealId?: string | null;
  conversationId?: string | null;
  expiresAt: Date;
}

export interface AiProposalRecord extends AiProposalInput {
  id: string;
  status: AiProposalStatus;
  reviewedByMembershipId: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface AiProposalRepository {
  create(workspaceId: string, proposal: AiProposalInput): Promise<string>;
  findById(id: string): Promise<AiProposalRecord | null>;
  list(status: AiProposalStatus | 'all', limit: number): Promise<AiProposalRecord[]>;
  /** Transição atômica: só sai de `pending`, e só uma vez. */
  transition(
    id: string,
    to: Exclude<AiProposalStatus, 'pending'>,
    reviewerMembershipId: string,
  ): Promise<boolean>;
}

export interface AiConsentState {
  conversationContent: boolean;
}

/** O ator viaja explícito: o adaptador precisa dele para auditar a mudança. */
export interface ConsentActor {
  workspaceId: string;
  membershipId: string;
}

export interface AiConsentRepository {
  get(): Promise<AiConsentState>;
  set(state: AiConsentState, actor: ConsentActor): Promise<void>;
}

/** Porta do catálogo global de prompts (ADR-029). */
export const PROMPT_VERSION_REPOSITORY = Symbol('PROMPT_VERSION_REPOSITORY');

export interface PromptVersionRepository {
  /** Garante a linha do catálogo e devolve o id; detecta hash divergente. */
  ensure(capability: string, version: number, hash: string, changelog: string): Promise<string>;
}

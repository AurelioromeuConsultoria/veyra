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
export type AiProposalStatus = 'pending' | 'executing' | 'approved' | 'rejected' | 'expired';
export type AiProposalType = 'create_task' | 'send_message';

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
  /** resultado estruturado já validado — nunca prompt nem corpo bruto */
  result?: Record<string, unknown> | null;
  conversationId?: string | null;
  contactId?: string | null;
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
  /** Último resultado OK de uma capacidade para um alvo — reaproveita o insight. */
  latestResult(
    capability: string,
    target: { conversationId?: string; contactId?: string },
  ): Promise<{ id: string; result: Record<string, unknown>; createdAt: Date } | null>;
  /**
   * ANULA o `result` dos runs mais antigos que `days`, sem apagar a linha
   * (ADR-042): o conteúdo derivado de conversa expira, a contabilidade de custo
   * e a evidência de que a IA agiu permanecem. Devolve quantos foram limpos.
   */
  purgeResultsOlderThan(days: number): Promise<number>;
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

/** Contexto de quem aprovou — preservado mesmo quando o ATOR da mutação é a IA. */
export interface ApprovalContext {
  workspaceId: string;
  membershipId: string;
}

export interface CreateTaskExecution {
  title: string;
  dueAt: string;
  contactId: string;
}

/**
 * Aprovação de rascunho de resposta (ADR-044). `edited` distingue o texto que
 * a IA escreveu do que o aprovador reescreveu: é o que decide a autoria da
 * `Message` e vai para a auditoria.
 */
export interface SendMessageExecution {
  conversationId: string;
  body: string;
  edited: boolean;
}

export interface AiProposalRepository {
  create(workspaceId: string, proposal: AiProposalInput): Promise<string>;
  findById(id: string): Promise<AiProposalRecord | null>;
  /**
   * `excludeTypes` filtra no WHERE, não depois do `take`: excluir na aplicação
   * devolvia página curta ou vazia para quem não lê conversas, escondendo
   * propostas de tarefa que ele PODE ver.
   */
  list(
    status: AiProposalStatus | 'all',
    limit: number,
    excludeTypes?: AiProposalType[],
  ): Promise<AiProposalRecord[]>;
  /**
   * Transições que NÃO executam nada (rejeitar, expirar). O revisor viaja com o
   * workspace porque a transição é AUDITADA: descartar um rascunho é decisão
   * sobre a conversa (ADR-044, adendo 2), e mutação relevante gera `AuditLog`.
   */
  transition(
    id: string,
    to: 'rejected' | 'expired',
    reviewer: ApprovalContext,
    /**
     * Quem PROVOCOU a transição. `system` para a expiração pelo relógio: quem
     * a disparou apenas esbarrou numa proposta já vencida, e registrá-lo como
     * autor da decisão seria atribuição falsa. A membership continua como
     * contexto nos dois casos.
     */
    actorType?: 'user' | 'system',
  ): Promise<boolean>;
  /**
   * Reivindica → executa → conclui em UMA transação (ADR-030). Se qualquer
   * etapa falhar, o rollback devolve a proposta a `pending` e nenhuma tarefa
   * sobra. A mutação é registrada com a IA como ATOR, vinculada ao `runId`,
   * com o aprovador preservado como contexto.
   */
  executeCreateTask(
    id: string,
    runId: string,
    input: CreateTaskExecution,
    approver: ApprovalContext,
  ): Promise<{ taskId: string } | 'not_pending'>;
  /**
   * Mesma garantia para o ENVIO (ADR-044.5): a proposta é reivindicada na
   * MESMA transação que grava a mensagem, o despacho e o evento de outbox —
   * duas aprovações simultâneas produzem uma mensagem, no máximo.
   *
   * A política de envio (janela, opt-in, quota) é reavaliada pelo serviço de
   * domínio ANTES da transação: se mudou, isto LANÇA e a proposta permanece
   * `pending` (ADR-044.6). O adaptador nunca escreve `Message` por conta
   * própria — delega ao serviço de envio.
   */
  executeSendMessage(
    id: string,
    runId: string,
    input: SendMessageExecution,
    approver: ApprovalContext,
  ): Promise<{ messageId: string } | 'not_pending'>;
  /**
   * Rascunho de resposta ainda pendente de UMA conversa. Método próprio em vez
   * de filtrar `list('pending')`: a fila do workspace inteiro pode ser longa, e
   * varrer os N primeiros esconderia o rascunho da conversa aberta.
   */
  findPendingReply(conversationId: string): Promise<AiProposalRecord | null>;
  /**
   * Cria o rascunho de resposta SUPERSEDINDO o pendente anterior da mesma
   * conversa, numa transação só (ADR-044, adendo 1): um rascunho novo torna o
   * anterior obsoleto, e dois pendentes na mesma conversa convidariam a aprovar
   * os dois — duas mensagens reais para a mesma pessoa.
   *
   * `'concurrent'` = outra geração simultânea venceu a corrida (o banco recusou
   * o segundo pendente). Quem chama devolve o rascunho vencedor, não um erro:
   * do ponto de vista de quem pediu, existe um rascunho para revisar.
   */
  createReplySuperseding(
    workspaceId: string,
    // o tipo é fixo e não há deal: a assinatura não promete o que não usa
    proposal: Omit<AiProposalInput, 'type' | 'dealId' | 'conversationId'> & {
      conversationId: string;
    },
  ): Promise<{ id: string } | 'concurrent'>;
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

/** Prompt editado sem subir a versão: erro de programação, não input. */
export class PromptHashMismatchError extends Error {}

export interface PromptVersionRepository {
  /**
   * Garante a linha do catálogo e devolve o id. Se a versão já existir com
   * hash DIFERENTE, falha alto: runs antigos e novos apontariam para a mesma
   * `PromptVersion` com conteúdos distintos, e o histórico de custo e
   * qualidade viraria mentira.
   */
  ensure(capability: string, version: number, hash: string, changelog: string): Promise<string>;
}

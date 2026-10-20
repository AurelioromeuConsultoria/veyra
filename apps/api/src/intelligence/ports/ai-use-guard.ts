import type { LlmOutcome } from '../llm/llm.client';

/**
 * A PORTA da IA para a guarda de uso externo (ADR-047 adendo 6 §3.3, "fronteira
 * de módulos", e adendo 7 §9, G3.1). O módulo `intelligence` entrega a chamada
 * ao provedor e a persistência do resultado; o adaptador do Core roda as duas
 * sob a guarda. O módulo continua sem tocar o Prisma: a transação da guarda
 * chega a ele como um identificador OPACO, que só os repositórios aceitam.
 */
export const AI_USE_GUARD = Symbol('AI_USE_GUARD');

declare const transacaoDaGuarda: unique symbol;
/** A transação da guarda, opaca para o módulo de IA. */
export interface AiTx {
  readonly [transacaoDaGuarda]: true;
}

/** O desfecho da chamada: o do provedor, ou incerto (a chamada lançou depois de começar). */
export type AiCallOutcome = LlmOutcome | { kind: 'uncertain' };

/** O acerto das duas reservas, pelo desfecho: real, zero (nada saiu) ou o teto. */
export interface AiSettlement {
  runs: number;
  costCents: number;
}

export interface AiGuardedUse<R> {
  workspaceId: string;
  /** os contatos do escopo (sem `null`: conteúdo sem contato não chega aqui) */
  contactIds: readonly string[];
  /** o id do run, gerado ANTES da chamada: o registro do uso o leva na origem */
  runId: string;
  origin: {
    promptVersionId: string | null;
    conversationId?: string | null;
    contactId?: string | null;
    triggeredByMembershipId: string | null;
  };
  /**
   * só identificadores e números, na lista fechada do tipo `ai_generation`. O
   * teto de custo reservado é o custo que o run em dúvida registra.
   */
  metadata: { capability: string; model: string; promptVersion: number; costCeilingCents: number };
  /** as duas reservas, feitas antes; daqui em diante só a guarda as acerta */
  reservations: { runs: string; cost: string };
  /** reconferência da porta, SOB as travas */
  recheck(): Promise<'allowed' | 'restricted' | 'unavailable'>;
  /** a chamada ao provedor, com o prazo absoluto da guarda */
  call(signal: AbortSignal): Promise<LlmOutcome>;
  /**
   * NA transação da guarda: grava o run (com `runId`) e o que ele produziu, e
   * diz como acertar as reservas.
   */
  persist(tx: AiTx, outcome: AiCallOutcome): Promise<{ value: R; settlement: AiSettlement }>;
}

export type AiGuardedResult<R> =
  | { kind: 'done'; value: R }
  /**
   * nada saiu; as reservas voltaram. `registration`: o registro falhou — se ele
   * chegou a comitar, a reconciliação cria o run em dúvida com o id reservado,
   * então quem chamou NÃO grava outro
   */
  | { kind: 'not_started'; reason: 'restricted' | 'unavailable' | 'registration' | 'other' }
  /**
   * a chamada pode ter começado e o resultado foi descartado: o run existe como
   * `unknown_after_dispatch`, e as reservas foram cobradas pelo teto
   */
  | { kind: 'in_doubt' };

export interface AiUseGuard {
  run<R>(use: AiGuardedUse<R>): Promise<AiGuardedResult<R>>;
}

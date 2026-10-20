import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import {
  ContentUseGuard,
  ehIncerto,
  type DesfechoIncerto,
  type ResultadoDoUso,
} from '../content-use/content-use.guard';
import { OrigensDosUsos } from '../content-use/content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from '../content-use/content-use.pools';
import type { Prisma } from '../generated/prisma/client';
import { FORMATO_DO_MODELO, type LlmOutcome } from '../intelligence/llm/llm.client';
import type {
  AiCallOutcome,
  AiGuardedResult,
  AiGuardedUse,
  AiTx,
  AiUseGuard,
} from '../intelligence/ports/ai-use-guard';
import {
  CONVERSATION_SUMMARY_PROMPT,
  LEAD_SCORE_EXPLANATION_PROMPT,
  NEXT_ACTION_PROMPT,
  REPLY_SUGGESTION_PROMPT,
} from '../intelligence/prompts';
import type { Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** id de modelo do provedor: o mesmo formato que o ambiente confere na subida */
const MODELO = FORMATO_DO_MODELO;
/** as capacidades do catálogo de prompts: a lista FECHADA */
const CAPACIDADES: readonly string[] = [
  CONVERSATION_SUMMARY_PROMPT,
  NEXT_ACTION_PROMPT,
  LEAD_SCORE_EXPLANATION_PROMPT,
  REPLY_SUGGESTION_PROMPT,
].map((prompt) => prompt.capability);

/** As chaves de origem do tipo `ai_generation`: todas são ids. */
const ORIGEM_DA_IA = [
  'runId',
  'promptVersionId',
  'conversationId',
  'contactId',
  'triggeredByMembershipId',
] as const;

/**
 * O ADAPTADOR da porta da IA para a guarda de uso externo (ADR-047 adendo 7 §9,
 * G3.1), e a ESPECIFICAÇÃO do tipo `ai_generation`, registrada no Core antes de
 * qualquer uso existir.
 *
 * As reservas só mudam aqui dentro, na transação da guarda: a persistência da
 * IA diz o acerto, e o adaptador acerta. A falha da persistência e os
 * detectores deixam o run `unknown_after_dispatch`, com o id gerado antes da
 * chamada.
 */
@Injectable()
export class GuardaDosUsosDaIa implements AiUseGuard, OnModuleInit {
  constructor(
    private readonly guarda: ContentUseGuard,
    private readonly origens: OrigensDosUsos,
    private readonly usage: UsageService,
    @Inject(CONFIG_DA_GUARDA) private readonly config: ConfigDaGuarda,
  ) {}

  onModuleInit(): void {
    this.origens.registrar('ai_generation', {
      origem: ORIGEM_DA_IA,
      metadados: {
        capability: (valor) => typeof valor === 'string' && CAPACIDADES.includes(valor),
        model: (valor) => typeof valor === 'string' && MODELO.test(valor),
        promptVersion: (valor) =>
          typeof valor === 'number' && Number.isInteger(valor) && valor >= 1 && valor <= 9_999,
        costCeilingCents: (valor) =>
          typeof valor === 'number' && Number.isInteger(valor) && valor >= 0 && valor <= 10_000_000,
      },
      marcarIncerta: (tx, uso) => criarRunIncerto(tx, uso.workspaceId, uso.origin, uso.runMetadata),
    });
  }

  async run<R>(use: AiGuardedUse<R>): Promise<AiGuardedResult<R>> {
    const origem = {
      runId: use.runId,
      promptVersionId: use.origin.promptVersionId,
      conversationId: use.origin.conversationId ?? null,
      contactId: use.origin.contactId ?? null,
      triggeredByMembershipId: use.origin.triggeredByMembershipId,
    };
    const metadados = {
      capability: use.metadata.capability,
      model: use.metadata.model,
      promptVersion: use.metadata.promptVersion,
      costCeilingCents: use.metadata.costCeilingCents,
    };
    const resultado: ResultadoDoUso<R> = await this.guarda.executar<LlmOutcome, R>({
      workspaceId: use.workspaceId,
      kind: 'ai_generation',
      contactIds: use.contactIds,
      prazoMs: this.config.prazoDaIaMs,
      origem,
      reservas: [use.reservations.runs, use.reservations.cost],
      metadadosDoRun: metadados,
      reconferir: async () => {
        const veredito = await use.recheck();
        return veredito === 'allowed'
          ? 'liberado'
          : veredito === 'restricted'
            ? 'restrito'
            : 'indisponivel';
      },
      iniciar: (signal) => use.call(signal),
      persistir: async (tx, desfecho: LlmOutcome | DesfechoIncerto) => {
        const outcome: AiCallOutcome = ehIncerto(desfecho) ? { kind: 'uncertain' } : desfecho;
        const { value, settlement } = await use.persist(tx as unknown as AiTx, outcome);
        await this.acertar(tx, use.workspaceId, use.reservations.runs, 'ai_runs', settlement.runs);
        await this.acertar(
          tx,
          use.workspaceId,
          use.reservations.cost,
          'ai_cost_cents',
          settlement.costCents,
        );
        return value;
      },
      // a guarda já voltou ao SAVEPOINT e cobrou as reservas pelo teto
      persistenciaFalhou: (tx) => criarRunIncerto(tx, use.workspaceId, origem, metadados),
    });
    switch (resultado.tipo) {
      case 'concluido':
        // persistência que falhou: o run ficou incerto, e o valor não existe
        return resultado.persistido
          ? { kind: 'done', value: resultado.valor as R }
          : { kind: 'in_doubt' };
      case 'em_duvida':
        return { kind: 'in_doubt' };
      case 'nao_comecou':
        return {
          kind: 'not_started',
          reason:
            resultado.motivo === 'restrito'
              ? 'restricted'
              : resultado.motivo === 'indisponivel'
                ? 'unavailable'
                : resultado.motivo === 'registro'
                  ? 'registration'
                  : 'other',
        };
    }
  }

  /**
   * O acerto de uma reserva pelo valor dito pela persistência. Se a reserva
   * não existe mais (adendo 6 §5), o valor vai pelo caminho acima do teto.
   */
  private async acertar(
    tx: Db,
    workspaceId: string,
    reserva: string,
    metrica: 'ai_runs' | 'ai_cost_cents',
    real: number,
  ): Promise<void> {
    if (await this.usage.settleWithin(tx, workspaceId, reserva, real)) return;
    if (real > 0) await this.usage.consumeOverLimit(tx, workspaceId, metrica, real);
  }
}

/**
 * O run da IA de um uso em dúvida, com o id gerado antes da chamada, se ainda
 * não existir (ADR-047 adendo 7 §3.6). A transação pode ser `raw` (a ativação
 * de um vertical marca os órfãos fora de sessão): TODO `where` e TODO `data`
 * levam o `workspaceId` explícito. Referência do workspace que já não existe
 * (conversa, contato ou membro apagados depois do registro) vira `null`: a
 * falha da FK prenderia o órfão para sempre.
 */
export async function criarRunIncerto(
  tx: Db,
  workspaceId: string,
  origemDoUso: Prisma.JsonValue | Record<string, string | null>,
  metadadosDoUso: Prisma.JsonValue | Record<string, string | number> | null,
): Promise<void> {
  const origem = (origemDoUso ?? {}) as Record<string, unknown>;
  const metadados = (metadadosDoUso ?? {}) as Record<string, unknown>;
  const id = (valor: unknown): string | null =>
    typeof valor === 'string' && UUID.test(valor) ? valor : null;
  const runId = id(origem.runId);
  // sem o id pré-gerado, não há run a criar (registro de outro tipo de origem)
  if (!runId) return;
  const existe = async (modelo: 'conversation' | 'contact' | 'membership', alvo: string | null) =>
    alvo !== null &&
    (await (tx[modelo] as unknown as { count: (a: object) => Promise<number> }).count({
      where: { workspaceId, id: alvo },
    })) > 0;
  const promptVersionId = id(origem.promptVersionId);
  const conversationId = id(origem.conversationId);
  const contactId = id(origem.contactId);
  const membershipId = id(origem.triggeredByMembershipId);
  const capacidade = metadados.capability;
  const modelo = metadados.model;
  const teto = metadados.costCeilingCents;
  await tx.aiRun.createMany({
    data: [
      {
        id: runId,
        workspaceId,
        capability:
          typeof capacidade === 'string' && CAPACIDADES.includes(capacidade)
            ? capacidade
            : 'desconhecida',
        model: typeof modelo === 'string' && MODELO.test(modelo) ? modelo : 'desconhecido',
        // catálogo GLOBAL e nunca apagado (e proibido no client filtrado):
        // o id veio do `ensurePrompt` de antes da chamada
        promptVersionId,
        contextSummary:
          'uso externo em dúvida (ADR-047 adendo 7): a chamada pode ter começado; o resultado foi descartado',
        status: 'unknown_after_dispatch',
        reasonCode: 'in_doubt',
        // o custo é o TETO cobrado pelas reservas: o histórico fecha com o contador
        costCents: typeof teto === 'number' && Number.isInteger(teto) && teto >= 0 ? teto : 0,
        conversationId: (await existe('conversation', conversationId)) ? conversationId : null,
        contactId: (await existe('contact', contactId)) ? contactId : null,
        triggeredByMembershipId: (await existe('membership', membershipId)) ? membershipId : null,
        action: 'none',
      },
    ],
    skipDuplicates: true,
  } as never);
}

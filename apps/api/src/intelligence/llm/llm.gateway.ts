import { Inject, Injectable } from '@nestjs/common';
import { ContentRestrictionService } from '../../extensions/content-restriction';
import { LLM_CLIENT, type LlmClient, type LlmOutcome, type LlmRequest } from './llm.client';

/**
 * DE QUEM é o conteúdo de um pedido ao provedor (ADR-047 E6, ADR-048 §6.3).
 * `null` = conteúdo que não se atribui a contato (conversa sem contato).
 */
export interface LlmScope {
  workspaceId: string;
  contactIds: readonly (string | null)[];
}

export type ScopedLlmRequest = LlmRequest & { scope: LlmScope };

export type GatewayOutcome =
  | LlmOutcome
  | { kind: 'restricted' }
  /** a porta de restrição não respondeu: nada saiu, e isso NÃO é "restrito" */
  | { kind: 'restriction_unavailable' };

/**
 * PONTO ÚNICO por onde todo conteúdo sai para o provedor de IA. O serviço não
 * injeta `LLM_CLIENT` diretamente (o teste `llm.gateway.spec.ts` garante): ele
 * fala com este gateway, que confere a restrição de conteúdo ANTES de qualquer
 * byte sair.
 *
 * Pedido sem escopo, ou com escopo vazio, é recusado. Assim uma capacidade
 * nova não escapa da regra por esquecimento: ela simplesmente não funciona
 * até declarar de quem é o conteúdo que carrega.
 *
 * Os testes substituem `LLM_CLIENT` (o provedor) por um falso, e por isso a
 * guarda mora aqui e não no token: os testes passam por ela também.
 */
@Injectable()
export class LlmGateway {
  constructor(
    @Inject(LLM_CLIENT) private readonly provider: LlmClient,
    private readonly restriction: ContentRestrictionService,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  /** `true` = o conteúdo deste escopo PODE ir ao provedor. */
  async allows(scope: LlmScope | undefined): Promise<boolean> {
    return (await this.verdict(scope)) === 'allowed';
  }

  /**
   * Veredito com três estados, para quem tem efeito durável e precisa
   * distinguir "restrito" (decisão) de "a porta não respondeu" (tente de novo).
   */
  async verdict(scope: LlmScope | undefined): Promise<'allowed' | 'restricted' | 'unavailable'> {
    if (!scope || scope.contactIds.length === 0) return 'restricted';
    const check = await this.restriction.check(scope.workspaceId, 'ai', scope.contactIds);
    if (check.unavailable) return 'unavailable';
    return check.restricted.some(Boolean) ? 'restricted' : 'allowed';
  }

  /**
   * Em LOTE: um booleano por item (`true` = restrito), com UMA consulta à porta
   * para a lista inteira. Item sem sujeito é restrito.
   */
  async restrictedEach(
    workspaceId: string,
    items: readonly (readonly (string | null)[])[],
  ): Promise<boolean[]> {
    const unique = [...new Set(items.flat())];
    const verdicts = await this.restriction.evaluate(workspaceId, 'ai', unique);
    const restricted = new Map(unique.map((subject, index) => [subject, verdicts[index]]));
    return items.map(
      (subjects) => subjects.length === 0 || subjects.some((subject) => restricted.get(subject)),
    );
  }

  async complete(request: ScopedLlmRequest): Promise<GatewayOutcome> {
    // confere de novo aqui, e não só no chamador: é a última barreira antes da rede
    const verdict = await this.verdict(request.scope);
    if (verdict === 'unavailable') return { kind: 'restriction_unavailable' };
    if (verdict === 'restricted') return { kind: 'restricted' };
    // ALLOWLIST do que sai: o escopo é nosso, não do provedor, e campo novo no
    // pedido não vaza para fora por acidente
    const providerRequest: LlmRequest = {
      system: request.system,
      context: request.context,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.untrusted !== undefined ? { untrusted: request.untrusted } : {}),
    };
    return this.provider.complete(providerRequest);
  }
}

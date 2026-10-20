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

/**
 * PONTO ÚNICO por onde todo conteúdo sai para o provedor de IA. O serviço não
 * injeta `LLM_CLIENT` diretamente (o teste `llm.gateway.spec.ts` garante): ele
 * fala com este gateway. Desde a G3.1 (ADR-047 adendo 7 §9) a ÚNICA saída é
 * `completeUnderGuard`, chamada pela guarda de uso externo depois de reconferir
 * a restrição sob as travas: não existe chamada ao provedor fora da guarda.
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

  /**
   * A chamada DENTRO da guarda de uso externo (ADR-047 adendos 6 e 7): a porta
   * já foi reconferida sob as travas, que seguem seguras durante a chamada. Uma
   * segunda checagem aqui seria I/O entre a prova de vida e o início, o
   * intervalo que a guarda proíbe. Só a guarda chama isto (teste estático).
   */
  completeUnderGuard(request: ScopedLlmRequest, signal: AbortSignal): Promise<LlmOutcome> {
    return this.provider.complete(allowlist(request), signal);
  }
}

/**
 * ALLOWLIST do que sai: o escopo é nosso, não do provedor, e campo novo no
 * pedido não vaza para fora por acidente.
 */
function allowlist(request: ScopedLlmRequest): LlmRequest {
  return {
    system: request.system,
    context: request.context,
    maxOutputTokens: request.maxOutputTokens,
    ...(request.untrusted !== undefined ? { untrusted: request.untrusted } : {}),
  };
}

import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Restrição de conteúdo por contato e por CONSUMIDOR (ADR-047 E6, ADR-048 §6).
 *
 * O Core não sabe POR QUE um contato é restrito, só QUE é — e para qual
 * consumidor. Uma liberação para um consumidor nunca vale para outro: cada
 * ponto de checagem pergunta pelo seu.
 */
export type RestrictionConsumer = 'ai' | 'webhook';

/**
 * Sujeito de uma checagem: o id do contato cujo conteúdo será usado, ou `null`
 * para conteúdo que não se atribui a contato nenhum (conversa sem contato,
 * evento cuja entidade sumiu). Quem implementa a porta decide o `null` — e a
 * única resposta segura num workspace com dado sensível é "restrito".
 *
 * Também chegam ids de contatos JÁ EXCLUÍDOS (a fotografia do outbox guarda os
 * contatos da emissão). Contrato: id sem linha de contato no workspace vale
 * como `null` — restrito onde houver dado sensível.
 */
export type RestrictionSubject = string | null;

/**
 * Porta implementada pelas extensões. Recebe o workspace EXPLÍCITO (a entrega de
 * webhook roda fora do CLS) e devolve um booleano por sujeito, na mesma ordem.
 */
export interface ContentRestrictionProvider {
  restricted(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<readonly boolean[]>;
}

export const CONTENT_RESTRICTION_PROVIDERS = Symbol('CONTENT_RESTRICTION_PROVIDERS');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** porta lenta não pode prender request, worker nem reserva de quota */
const PROVIDER_TIMEOUT_MS = 3_000;

/**
 * Resultado com TRÊS estados. `unavailable` significa "a porta não respondeu
 * direito" — exceção, timeout, resposta malformada. Nesse caso tudo vale como
 * restrito (nada sai), MAS quem tem efeito durável deve tentar de novo em vez
 * de descartar: fail-closed é "não sai", não "perde para sempre".
 */
export interface RestrictionCheck {
  restricted: boolean[];
  unavailable: boolean;
}

/**
 * Fachada do Core sobre as portas. FALHA FECHADA em tudo que não for resposta
 * bem-formada. Sem cache: a resposta vale para a chamada.
 *
 * Sem nenhuma extensão composta, nada é restrito — é o Core puro, e o
 * comportamento dele não muda (teste de não regressão).
 */
@Injectable()
export class ContentRestrictionService {
  private readonly logger = new Logger(ContentRestrictionService.name);

  constructor(
    @Inject(CONTENT_RESTRICTION_PROVIDERS)
    private readonly providers: readonly ContentRestrictionProvider[],
  ) {}

  /** Há alguma porta composta? Sem ela, nada é restrito e nada precisa ser resolvido. */
  get active(): boolean {
    return this.providers.length > 0;
  }

  async check(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<RestrictionCheck> {
    if (subjects.length === 0) return { restricted: [], unavailable: false };
    if (!this.active) return { restricted: subjects.map(() => false), unavailable: false };
    const allRestricted = (): RestrictionCheck => ({
      restricted: subjects.map(() => true),
      unavailable: true,
    });
    if (!UUID_RE.test(workspaceId)) return allRestricted();

    const result = subjects.map(() => false);
    for (const provider of this.providers) {
      let answer: readonly boolean[];
      try {
        answer = await withTimeout(provider.restricted(workspaceId, consumer, subjects));
      } catch (error) {
        // só o NOME do erro: a mensagem de erro do Prisma traz a invocação, com
        // ids e valores — log não é lugar de dado do contato
        this.logger.error(
          `Porta de restrição indisponível (${consumer}): ${
            error instanceof Error ? error.name : 'erro desconhecido'
          } — tratando como restrito`,
        );
        return allRestricted();
      }
      if (
        !Array.isArray(answer) ||
        answer.length !== subjects.length ||
        answer.some((value) => typeof value !== 'boolean')
      ) {
        this.logger.error(`Porta de restrição respondeu fora do contrato (${consumer})`);
        return allRestricted();
      }
      answer.forEach((value, index) => {
        if (value) result[index] = true;
      });
    }
    return { restricted: result, unavailable: false };
  }

  /** Um booleano por sujeito: `true` = restrito (indisponível também conta como restrito). */
  async evaluate(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<boolean[]> {
    return (await this.check(workspaceId, consumer, subjects)).restricted;
  }

  /**
   * Algum dos sujeitos é restrito? Exige ao menos um sujeito: checagem sem
   * sujeito é erro de quem chama, e erro aqui só pode significar "restrito".
   */
  async anyRestricted(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<boolean> {
    if (subjects.length === 0) return true;
    return (await this.evaluate(workspaceId, consumer, subjects)).some(Boolean);
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('timeout');
      error.name = 'RestrictionTimeout';
      reject(error);
    }, PROVIDER_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ExperienceStatus } from '@veyra/contracts';
import { EXTENSION_REGISTRY, type ComposedRegistry } from './registry';

/**
 * A disponibilidade da experiência de uma extensão num workspace (ADR-055
 * adendo 1, item 3). A extensão dona responde — o Core não sabe o que torna
 * uma experiência utilizável. Uma por experiência de extensão, registrada pela
 * raiz de composição, como as portas do E6 e do E7.
 *
 * O `workspaceId` vem SÓ de uma membership da própria sessão ou da operação
 * (a CLI), nunca de um parâmetro da requisição: a porta responde sobre o
 * workspace que receber, e um id vindo de fora a tornaria um oráculo de outro
 * tenant (revisão de segurança da E-1). A porta avalia o workspace pedido num
 * contexto próprio, sem herdar a identidade nem o workspace de quem chama.
 */
export interface ExperienceAvailabilityProvider {
  /** a chave da experiência (o nome da extensão dona) */
  readonly experience: string;
  isAvailable(workspaceId: string): Promise<boolean>;
}

export const EXPERIENCE_AVAILABILITY_PROVIDERS = Symbol('EXPERIENCE_AVAILABILITY_PROVIDERS');

/** a porta que não responde em tempo conta como "indisponível" */
const PRAZO_MS = 2_000;

/**
 * Fachada do Core sobre as experiências. FALHA FECHADA: a chave que a
 * composição não declara é `unknown`, e a porta que nega, falha ou estoura o
 * prazo dá `unavailable`. O servidor só informa; quem mostra é o web, que nunca
 * cai em silêncio noutra experiência.
 */
@Injectable()
export class ExperienceService {
  private readonly logger = new Logger(ExperienceService.name);
  private readonly portas = new Map<string, ExperienceAvailabilityProvider>();

  constructor(
    @Inject(EXTENSION_REGISTRY) private readonly registry: ComposedRegistry,
    @Inject(EXPERIENCE_AVAILABILITY_PROVIDERS)
    providers: readonly ExperienceAvailabilityProvider[],
  ) {
    for (const porta of providers) {
      const declarada = registry.experiences.get(porta.experience);
      // o boot recusa a porta sem experiência de extensão, ou repetida
      if (!declarada || declarada.extension === null) {
        throw new Error(
          `Porta de disponibilidade sem experiência de extensão: ${porta.experience}`,
        );
      }
      if (this.portas.has(porta.experience)) {
        throw new Error(`Porta de disponibilidade repetida: ${porta.experience}`);
      }
      this.portas.set(porta.experience, porta);
    }
    // e a experiência de extensão sem porta: sem ela, nunca se saberia se vale
    for (const declarada of registry.experiences.values()) {
      if (declarada.extension !== null && !this.portas.has(declarada.key)) {
        throw new Error(`Experiência sem porta de disponibilidade: ${declarada.key}`);
      }
    }
  }

  declared(key: string) {
    return this.registry.experiences.get(key);
  }

  /** `workspaceId`: só de uma membership da própria sessão ou da operação (ver a porta). */
  async status(workspaceId: string, key: string): Promise<ExperienceStatus> {
    const declarada = this.registry.experiences.get(key);
    if (!declarada) return 'unknown';
    if (declarada.extension === null) return 'ready';
    const porta = this.portas.get(key);
    if (!porta) return 'unavailable';
    let timer: NodeJS.Timeout | undefined;
    try {
      const prazo = new Promise<never>((_, rejeitar) => {
        timer = setTimeout(() => rejeitar(new Error('prazo da porta')), PRAZO_MS);
      });
      return (await Promise.race([porta.isAvailable(workspaceId), prazo])) === true
        ? 'ready'
        : 'unavailable';
    } catch (error) {
      // só o tipo: a mensagem de um erro do banco poderia trazer valores
      this.logger.warn(
        `disponibilidade da experiência ${key} falhou (${(error as Error)?.name ?? 'erro'}); conta como indisponível`,
      );
      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }
}

import { applyDecorators, SetMetadata, type Type } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from './decorators';

export const IDEMPOTENT_KEY = 'veyra:idempotent';
export const IDEMPOTENT_REPLAY_GUARD_KEY = 'veyra:idempotentReplayGuard';

/**
 * Guarda de REPLAY: decide, no momento da repetição, se a resposta guardada
 * ainda pode ser devolvida. Existe para rotas cujo corpo é conteúdo que pode
 * deixar de ser entregável depois de gravado — o caso vivo é a capacidade de IA
 * sobre um contato que ficou restrito (ADR-047 E6, ADR-048 §6.3). Recusar o
 * replay descarta a resposta guardada e a rota executa de novo, com a regra de
 * hoje.
 */
export interface IdempotentReplayGuard {
  /**
   * `replay`: devolve o corpo guardado. `discard`: o corpo deixou de ser
   * entregável — é apagado e a rota executa de novo. `unavailable`: não deu para
   * decidir agora — responde 503 SEM apagar nada (indisponível não descarta).
   */
  verdict(request: Request & { auth?: AuthContext }): Promise<'replay' | 'discard' | 'unavailable'>;
}

/**
 * OPT-IN da idempotência (correção P1 da revisão): só rotas marcadas gravam a
 * resposta para replay. Sem opt-in, um endpoint que devolve segredo (ex.: o
 * `secret` do webhook, exibido uma única vez) teria o valor guardado em claro
 * numa coluna JSONB por 24h — anulando a cifra em repouso.
 *
 * REGRA: nunca marque rota cuja resposta contenha segredo, token ou material
 * de sessão. Rota cuja resposta pode deixar de ser entregável declara uma
 * `replayGuard`.
 */
export const Idempotent = (options: { replayGuard?: Type<IdempotentReplayGuard> } = {}) =>
  options.replayGuard
    ? applyDecorators(
        SetMetadata(IDEMPOTENT_KEY, true),
        SetMetadata(IDEMPOTENT_REPLAY_GUARD_KEY, options.replayGuard),
      )
    : SetMetadata(IDEMPOTENT_KEY, true);

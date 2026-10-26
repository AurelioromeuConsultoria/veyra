import { applyDecorators, SetMetadata, type HttpException, type Type } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from './decorators';

export const IDEMPOTENT_KEY = 'veyra:idempotent';
export const IDEMPOTENT_REPLAY_GUARD_KEY = 'veyra:idempotentReplayGuard';
export const IDEMPOTENT_REQUIRED_KEY = 'veyra:idempotentRequired';

/**
 * O que a guarda decide na repetição:
 * - `replay`: devolve o corpo guardado;
 * - `discard`: o corpo deixou de ser entregável — é apagado e a rota executa
 *   de novo, com a regra de hoje;
 * - `unavailable`: não deu para decidir agora — 503, SEM apagar nada;
 * - `{ refuse }`: quem pede não pode receber este corpo com o acesso de agora
 *   (F4.1b, ADR-052) — responde a recusa, SEM apagar e SEM executar de novo. É
 *   para a rota cujo efeito não se repete: reexecutar seria uma operação nova.
 */
export type ReplayVerdict = 'replay' | 'discard' | 'unavailable' | { refuse: HttpException };

/**
 * Guarda de REPLAY: decide, no momento da repetição, se a resposta guardada
 * ainda pode ser devolvida. Existe para rotas cujo corpo pode deixar de ser
 * entregável depois de gravado — a capacidade de IA sobre um contato que ficou
 * restrito (ADR-047 E6, ADR-048 §6.3), ou o registro pela conversa cuja
 * projeção depende do acesso de quem pede (F4.1b). Recebe o corpo guardado.
 */
export interface IdempotentReplayGuard {
  verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict>;
}

/**
 * OPT-IN da idempotência (correção P1 da revisão): só rotas marcadas gravam a
 * resposta para replay. Sem opt-in, um endpoint que devolve segredo (ex.: o
 * `secret` do webhook, exibido uma única vez) teria o valor guardado em claro
 * numa coluna JSONB por 24h — anulando a cifra em repouso.
 *
 * REGRA: nunca marque rota cuja resposta contenha segredo, token ou material
 * de sessão. Rota cuja resposta pode deixar de ser entregável declara uma
 * `replayGuard`. Rota de REGISTRO com recibo (o consentimento e o pedido de
 * parar, F4.1b) declara `required`: sem a chave, 400 — a repetição de um envio
 * perdido nunca vira um segundo registro.
 */
export const Idempotent = (
  options: { replayGuard?: Type<IdempotentReplayGuard>; required?: boolean } = {},
) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    ...(options.replayGuard ? [SetMetadata(IDEMPOTENT_REPLAY_GUARD_KEY, options.replayGuard)] : []),
    ...(options.required ? [SetMetadata(IDEMPOTENT_REQUIRED_KEY, true)] : []),
  );

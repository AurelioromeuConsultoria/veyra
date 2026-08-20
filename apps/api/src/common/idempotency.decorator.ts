import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'veyra:idempotent';

/**
 * OPT-IN da idempotência (correção P1 da revisão): só rotas marcadas gravam a
 * resposta para replay. Sem opt-in, um endpoint que devolve segredo (ex.: o
 * `secret` do webhook, exibido uma única vez) teria o valor guardado em claro
 * numa coluna JSONB por 24h — anulando a cifra em repouso.
 *
 * REGRA: nunca marque rota cuja resposta contenha segredo, token ou material
 * de sessão.
 */
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

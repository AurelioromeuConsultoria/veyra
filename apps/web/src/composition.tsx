import type { NavGroup, VerticalRoute } from './lib/nav';
import { clinicsRoutes, useClinicsNavGroups } from './verticals/clinics';

/**
 * RAIZ DE COMPOSIÇÃO do web (ADR-047 E5, adendo 4). Único arquivo do web
 * autorizado a importar `verticals/` — a regra está no ESLint e no teste
 * `extensions/boundary.spec.ts`. O Core recebe daqui só um hook de navegação e
 * uma lista de rotas; não conhece vertical nenhum.
 */

/** Grupos contribuídos AGORA (cada vertical decide a própria visibilidade). */
export function useVerticalNavGroups(): readonly NavGroup[] {
  return useClinicsNavGroups();
}

export const VERTICAL_ROUTES: readonly VerticalRoute[] = [...clinicsRoutes];

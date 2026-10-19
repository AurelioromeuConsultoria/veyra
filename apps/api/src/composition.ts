import type { ExtensionsOptions } from './extensions/extensions.module';

/**
 * RAIZ DE COMPOSIÇÃO do produto (ADR-047). Junto com `app.module.ts`, é o
 * único arquivo da API autorizado a importar `verticals/` — a regra está no
 * ESLint e no teste `extensions/boundary.spec.ts`.
 *
 * Hoje nenhum vertical está composto: o produto é o Core puro.
 */
export const COMPOSITION: ExtensionsOptions = {
  extensions: [],
  contentRestrictionProviders: [],
};

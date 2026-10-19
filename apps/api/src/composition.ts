import type { ExtensionsOptions } from './extensions/extensions.module';
import { ClinicsContentRestriction } from './verticals/clinics/clinics-content-restriction';
import { clinicsExtension } from './verticals/clinics/clinics.extension';

/**
 * RAIZ DE COMPOSIÇÃO do produto (ADR-047). Junto com `app.module.ts`, é o
 * único arquivo da API autorizado a importar `verticals/` — a regra está no
 * ESLint e no teste `extensions/boundary.spec.ts`.
 *
 * Composto: o vertical Veyra Clinics (ADR-048). Ativado por workspace, só pela
 * CLI; num workspace sem ele o comportamento é o do Core puro.
 */
export const COMPOSITION: ExtensionsOptions = {
  extensions: [clinicsExtension],
  contentRestrictionProviders: [ClinicsContentRestriction],
};

import type { ExperienceManifest } from './lib/experience';
import { clinicsExperience } from './verticals/clinics/experience';

/**
 * RAIZ DE COMPOSIÇÃO do web (ADR-047 E5; ADR-055 adendo 2). Único arquivo do
 * web autorizado a importar `verticals/` — a regra está no ESLint e no teste
 * `extensions/boundary.spec.ts`. O Core recebe daqui só os manifestos das
 * experiências das extensões; não conhece vertical nenhum.
 */
export const EXPERIENCIAS_DE_EXTENSAO: readonly ExperienceManifest[] = [clinicsExperience];

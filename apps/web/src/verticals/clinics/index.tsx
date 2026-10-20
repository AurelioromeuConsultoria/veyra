import { lazy } from 'react';
import type { VerticalRoute } from '../../lib/nav';
import { CLINICS_AI_RELEASES_PATH, CLINICS_CATALOG_PATH } from './nav';

export { useClinicsNavGroups } from './nav';

const ClinicsCatalogPage = lazy(() =>
  import('./CatalogPage').then((m) => ({ default: m.ClinicsCatalogPage })),
);
const ClinicsAiReleasesPage = lazy(() =>
  import('./AiReleasesPage').then((m) => ({ default: m.ClinicsAiReleasesPage })),
);

/** Rotas do Clinics, montadas pela raiz dentro do shell protegido. */
export const clinicsRoutes: readonly VerticalRoute[] = [
  { path: CLINICS_CATALOG_PATH, element: <ClinicsCatalogPage /> },
  { path: CLINICS_AI_RELEASES_PATH, element: <ClinicsAiReleasesPage /> },
];

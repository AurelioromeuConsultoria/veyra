import { lazy } from 'react';
import type { VerticalRoute } from '../../lib/nav';
import {
  CLINICS_AGENDA_PATH,
  CLINICS_AI_RELEASES_PATH,
  CLINICS_CATALOG_PATH,
  CLINICS_PATIENTS_PATH,
} from './nav';

export { useClinicsNavGroups } from './nav';

const ClinicsCatalogPage = lazy(() =>
  import('./CatalogPage').then((m) => ({ default: m.ClinicsCatalogPage })),
);
const ClinicsAgendaPage = lazy(() =>
  import('./AgendaPage').then((m) => ({ default: m.ClinicsAgendaPage })),
);
const ClinicsPatientsPage = lazy(() =>
  import('./PatientsPage').then((m) => ({ default: m.ClinicsPatientsPage })),
);
const ClinicsAiReleasesPage = lazy(() =>
  import('./AiReleasesPage').then((m) => ({ default: m.ClinicsAiReleasesPage })),
);

/** Rotas do Clinics, montadas pela raiz dentro do shell protegido. */
export const clinicsRoutes: readonly VerticalRoute[] = [
  { path: CLINICS_AGENDA_PATH, element: <ClinicsAgendaPage /> },
  { path: CLINICS_PATIENTS_PATH, element: <ClinicsPatientsPage /> },
  { path: CLINICS_CATALOG_PATH, element: <ClinicsCatalogPage /> },
  { path: CLINICS_AI_RELEASES_PATH, element: <ClinicsAiReleasesPage /> },
];

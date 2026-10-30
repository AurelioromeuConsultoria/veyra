import { lazy } from 'react';
import type { VerticalRoute } from '../../lib/nav';
import {
  CLINICS_AGENDA_PATH,
  CLINICS_AI_RELEASES_PATH,
  CLINICS_CATALOG_PATH,
  CLINICS_LEADS_PATH,
  CLINICS_NO_SHOW_PATH,
  CLINICS_OUTREACH_METRICS_PATH,
  CLINICS_OUTREACH_PATH,
  CLINICS_PATIENT_PATH,
  CLINICS_PATIENTS_PATH,
  CLINICS_PERSON_PATH,
  CLINICS_RETURNS_PATH,
  CLINICS_TODAY_PATH,
} from './nav';

const ClinicsCatalogPage = lazy(() =>
  import('./CatalogPage').then((m) => ({ default: m.ClinicsCatalogPage })),
);
const ClinicsAgendaPage = lazy(() =>
  import('./AgendaPage').then((m) => ({ default: m.ClinicsAgendaPage })),
);
const ClinicsPatientsPage = lazy(() =>
  import('./PatientsPage').then((m) => ({ default: m.ClinicsPatientsPage })),
);
const ClinicsPatientPage = lazy(() =>
  import('./PatientPage').then((m) => ({ default: m.ClinicsPatientPage })),
);
const ClinicsReturnsPage = lazy(() =>
  import('./ReturnsPage').then((m) => ({ default: m.ClinicsReturnsPage })),
);
const ClinicsNoShowPage = lazy(() =>
  import('./NoShowPage').then((m) => ({ default: m.ClinicsNoShowPage })),
);
const ClinicsOutreachPage = lazy(() =>
  import('./envios/EnviosPage').then((m) => ({ default: m.ClinicsOutreachPage })),
);
const ClinicsOutreachMetricsPage = lazy(() =>
  import('./metricas/MetricasDoEnvioPage').then((m) => ({
    default: m.ClinicsOutreachMetricsPage,
  })),
);
const ClinicsTodayPage = lazy(() =>
  import('./hoje/HojePage').then((m) => ({ default: m.ClinicsTodayPage })),
);
const ClinicsLeadsPage = lazy(() =>
  import('./InteressadosPage').then((m) => ({ default: m.ClinicsLeadsPage })),
);
const ClinicsPersonPage = lazy(() =>
  import('./pessoa/PessoaPage').then((m) => ({ default: m.ClinicsPersonPage })),
);
const ClinicsAiReleasesPage = lazy(() =>
  import('./AiReleasesPage').then((m) => ({ default: m.ClinicsAiReleasesPage })),
);

/** Rotas do Clinics, montadas pela raiz dentro do shell protegido. */
export const clinicsRoutes: readonly VerticalRoute[] = [
  { path: CLINICS_TODAY_PATH, element: <ClinicsTodayPage /> },
  { path: CLINICS_LEADS_PATH, element: <ClinicsLeadsPage /> },
  { path: CLINICS_PERSON_PATH, element: <ClinicsPersonPage /> },
  { path: CLINICS_AGENDA_PATH, element: <ClinicsAgendaPage /> },
  { path: CLINICS_PATIENTS_PATH, element: <ClinicsPatientsPage /> },
  { path: CLINICS_PATIENT_PATH, element: <ClinicsPatientPage /> },
  { path: CLINICS_RETURNS_PATH, element: <ClinicsReturnsPage /> },
  { path: CLINICS_NO_SHOW_PATH, element: <ClinicsNoShowPage /> },
  { path: CLINICS_OUTREACH_PATH, element: <ClinicsOutreachPage /> },
  { path: CLINICS_OUTREACH_METRICS_PATH, element: <ClinicsOutreachMetricsPage /> },
  { path: CLINICS_CATALOG_PATH, element: <ClinicsCatalogPage /> },
  { path: CLINICS_AI_RELEASES_PATH, element: <ClinicsAiReleasesPage /> },
];

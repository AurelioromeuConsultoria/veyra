import { lazy } from 'react';
import type { VerticalRoute } from '../../lib/nav';
import { CLINICS_CATALOG_PATH } from './nav';

export { useClinicsNavGroups } from './nav';

const ClinicsCatalogPage = lazy(() =>
  import('./CatalogPage').then((m) => ({ default: m.ClinicsCatalogPage })),
);

/** Rotas do Clinics, montadas pela raiz dentro do shell protegido. */
export const clinicsRoutes: readonly VerticalRoute[] = [
  { path: CLINICS_CATALOG_PATH, element: <ClinicsCatalogPage /> },
];

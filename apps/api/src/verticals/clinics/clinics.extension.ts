import { CLINICS_PERMISSION_CATALOG } from '@veyra/contracts/verticals/clinics';
import type { CoreExtension } from '../../extensions/extension';

/**
 * O vertical Clinics, descrito para o Core (ADR-047). É tudo o que o Core
 * recebe dele: modelos protegidos (E1), catálogo de permissões (E2) e
 * allowlists de auditoria (E4). A porta de restrição de conteúdo (E6) é
 * composta junto, em `composition.ts`.
 */
export const CLINICS_MODELS = ['ClinicsSettings', 'ClinicsUnit', 'ClinicsContactRelease'] as const;

export const clinicsExtension: CoreExtension = {
  name: 'clinics',
  tenantModels: {
    workspaceModels: CLINICS_MODELS,
    relationTargets: {
      ClinicsSettings: { workspace: 'Workspace' },
      ClinicsUnit: { workspace: 'Workspace' },
      ClinicsContactRelease: {
        workspace: 'Workspace',
        contact: 'Contact',
        releasedBy: 'Membership',
      },
      // lado reverso que o Prisma exige nos modelos do Core (ADR-047 adendo 2)
      Contact: { clinicsContactReleases: 'ClinicsContactRelease' },
      Membership: { clinicsReleasesGranted: 'ClinicsContactRelease' },
    },
  },
  permissionCatalog: CLINICS_PERMISSION_CATALOG,
  auditFields: {
    // classe C: o status da ativação
    clinicsSettings: ['status'],
    // classe P: o FATO e os ids (ADR-048 §6.1) — qual contato, consumidor e
    // motivo de lista fechada. Nunca dado do contato. Sem o id, a revogação (que
    // apaga a linha) ou a exclusão do contato deixariam a trilha sem titular
    clinicsContactRelease: ['contactId', 'consumer', 'reason'],
  },
};

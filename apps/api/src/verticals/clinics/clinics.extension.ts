import { CLINICS_PERMISSION_CATALOG } from '@veyra/contracts/verticals/clinics';
import type { CoreExtension } from '../../extensions/extension';

/**
 * O vertical Clinics, descrito para o Core (ADR-047). É tudo o que o Core
 * recebe dele: modelos protegidos (E1), catálogo de permissões (E2) e
 * allowlists de auditoria (E4). A porta de restrição de conteúdo (E6) é
 * composta junto, em `composition.ts`.
 */
export const CLINICS_MODELS = [
  'ClinicsSettings',
  'ClinicsUnit',
  'ClinicsContactRelease',
  'ClinicsService',
  'ClinicsProfessional',
  'ClinicsProfessionalService',
  'ClinicsWorkingHours',
] as const;

export const clinicsExtension: CoreExtension = {
  name: 'clinics',
  tenantModels: {
    workspaceModels: CLINICS_MODELS,
    relationTargets: {
      ClinicsSettings: { workspace: 'Workspace' },
      ClinicsUnit: { workspace: 'Workspace', workingHours: 'ClinicsWorkingHours' },
      ClinicsService: { workspace: 'Workspace', professionals: 'ClinicsProfessionalService' },
      ClinicsProfessional: {
        workspace: 'Workspace',
        membership: 'Membership',
        services: 'ClinicsProfessionalService',
        workingHours: 'ClinicsWorkingHours',
      },
      ClinicsProfessionalService: {
        workspace: 'Workspace',
        professional: 'ClinicsProfessional',
        service: 'ClinicsService',
      },
      ClinicsWorkingHours: {
        workspace: 'Workspace',
        professional: 'ClinicsProfessional',
        unit: 'ClinicsUnit',
      },
      ClinicsContactRelease: {
        workspace: 'Workspace',
        contact: 'Contact',
        releasedBy: 'Membership',
      },
      // lado reverso que o Prisma exige nos modelos do Core (ADR-047 adendo 2)
      Contact: { clinicsContactReleases: 'ClinicsContactRelease' },
      Membership: {
        clinicsReleasesGranted: 'ClinicsContactRelease',
        clinicsProfessional: 'ClinicsProfessional',
      },
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
    // catálogo (ADR-048 adendo 1, item 8). Classe C: allowlist ampla
    clinicsService: ['name', 'durationMin', 'priceCents', 'currency', 'archivedAt'],
    clinicsUnit: ['name', 'timezone'],
    // classe P: ids, vínculo e arquivamento; o NOME vira [changed]. Horários e
    // serviços habilitados entram como o fato e os ids (quantidade, lista)
    clinicsProfessional: ['membershipId', 'archivedAt', 'serviceIds', 'intervalCount'],
  },
};

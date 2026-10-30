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
  'ClinicsPatient',
  'ClinicsAppointment',
  'ClinicsAttendance',
  'ClinicsPackage',
  'ClinicsReturn',
  'ClinicsOutreachRequest',
  'ClinicsAppointmentDeal',
] as const;

export const clinicsExtension: CoreExtension = {
  name: 'clinics',
  // a experiência da clínica (ADR-055). Selecionável desde a E-3, quando o
  // frontend dela existe; a CLI continua exigindo o vertical ATIVO e audita a
  // troca. Mudar um workspace do staging é a E-4, com autorização própria
  experience: { selectable: true },
  tenantModels: {
    workspaceModels: CLINICS_MODELS,
    relationTargets: {
      ClinicsSettings: { workspace: 'Workspace' },
      ClinicsUnit: {
        workspace: 'Workspace',
        workingHours: 'ClinicsWorkingHours',
        appointments: 'ClinicsAppointment',
        returns: 'ClinicsReturn',
      },
      ClinicsService: {
        workspace: 'Workspace',
        professionals: 'ClinicsProfessionalService',
        appointments: 'ClinicsAppointment',
        packages: 'ClinicsPackage',
        returns: 'ClinicsReturn',
      },
      ClinicsProfessional: {
        workspace: 'Workspace',
        membership: 'Membership',
        services: 'ClinicsProfessionalService',
        workingHours: 'ClinicsWorkingHours',
        appointments: 'ClinicsAppointment',
        attendances: 'ClinicsAttendance',
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
      ClinicsPatient: {
        workspace: 'Workspace',
        contact: 'Contact',
        createdBy: 'Membership',
        appointments: 'ClinicsAppointment',
        packages: 'ClinicsPackage',
        returns: 'ClinicsReturn',
      },
      ClinicsAppointment: {
        workspace: 'Workspace',
        patient: 'ClinicsPatient',
        professional: 'ClinicsProfessional',
        service: 'ClinicsService',
        unit: 'ClinicsUnit',
        createdBy: 'Membership',
        attendance: 'ClinicsAttendance',
        returns: 'ClinicsReturn',
        outreach: 'ClinicsOutreachRequest',
        dealLink: 'ClinicsAppointmentDeal',
      },
      ClinicsAttendance: {
        workspace: 'Workspace',
        appointment: 'ClinicsAppointment',
        professional: 'ClinicsProfessional',
        recordedBy: 'Membership',
        package: 'ClinicsPackage',
        returnsOriginated: 'ClinicsReturn',
        returnsFulfilled: 'ClinicsReturn',
      },
      ClinicsPackage: {
        workspace: 'Workspace',
        patient: 'ClinicsPatient',
        service: 'ClinicsService',
        createdBy: 'Membership',
        attendances: 'ClinicsAttendance',
      },
      ClinicsReturn: {
        workspace: 'Workspace',
        patient: 'ClinicsPatient',
        service: 'ClinicsService',
        unit: 'ClinicsUnit',
        originAttendance: 'ClinicsAttendance',
        appointment: 'ClinicsAppointment',
        fulfilledBy: 'ClinicsAttendance',
        assignee: 'Membership',
        createdBy: 'Membership',
        closedBy: 'Membership',
        outreach: 'ClinicsOutreachRequest',
      },
      ClinicsOutreachRequest: {
        workspace: 'Workspace',
        appointment: 'ClinicsAppointment',
        return: 'ClinicsReturn',
        createdBy: 'Membership',
      },
      ClinicsAppointmentDeal: {
        workspace: 'Workspace',
        appointment: 'ClinicsAppointment',
        deal: 'Deal',
        linkedBy: 'Membership',
      },
      ClinicsContactRelease: {
        workspace: 'Workspace',
        contact: 'Contact',
        releasedBy: 'Membership',
      },
      // lado reverso que o Prisma exige nos modelos do Core (ADR-047 adendo 2)
      Contact: {
        clinicsContactReleases: 'ClinicsContactRelease',
        clinicsPatient: 'ClinicsPatient',
      },
      Membership: {
        clinicsReleasesGranted: 'ClinicsContactRelease',
        clinicsProfessional: 'ClinicsProfessional',
        clinicsPatientsCreated: 'ClinicsPatient',
        clinicsAppointmentsCreated: 'ClinicsAppointment',
        clinicsAttendancesRecorded: 'ClinicsAttendance',
        clinicsPackagesCreated: 'ClinicsPackage',
        clinicsReturnsAssigned: 'ClinicsReturn',
        clinicsReturnsCreated: 'ClinicsReturn',
        clinicsReturnsClosed: 'ClinicsReturn',
        clinicsOutreachCreated: 'ClinicsOutreachRequest',
        clinicsDealLinksMade: 'ClinicsAppointmentDeal',
      },
      Deal: {
        clinicsAppointmentLinks: 'ClinicsAppointmentDeal',
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
    clinicsService: [
      'name',
      'durationMin',
      'priceCents',
      'currency',
      'returnIntervalDays',
      'archivedAt',
    ],
    clinicsUnit: ['name', 'timezone'],
    // o marcador da carga da demonstração (ADR-048 adendo 13): só as contagens
    clinicsDemoLoad: [
      'servicos',
      'profissionais',
      'contatos',
      'pacientes',
      'agendamentos',
      'retornos',
      'pulados',
    ],
    // classe P: ids, vínculo e arquivamento; o NOME vira [changed]. Horários e
    // serviços habilitados entram como o fato e os ids (quantidade, lista)
    clinicsProfessional: ['membershipId', 'archivedAt', 'serviceIds', 'intervalCount'],
    // classe S: só o FATO e o id do contato (§6.2, item 3) — nada clínico existe
    clinicsPatient: ['contactId'],
    // classe S: ids, status, instantes e motivo de lista fechada (adendo 4,
    // item 10) — nada clínico existe nesses modelos
    clinicsAppointment: [
      'patientId',
      'professionalId',
      'serviceId',
      'unitId',
      'startsAt',
      'endsAt',
      'status',
      'cancelReason',
    ],
    clinicsAttendance: ['appointmentId', 'professionalId', 'completedAt', 'packageId'],
    // classe S (ADR-048 adendo 7, F3.1): ids, contagens e estado. O PREÇO entra
    // só como o fato de existir (`hasPrice`): o valor não é necessário à trilha
    clinicsPackage: [
      'patientId',
      'serviceId',
      'totalSessions',
      'consumedSessions',
      'status',
      'hasPrice',
    ],
    // classe S (ADR-048 adendo 7, F3.2): ids, vencimento, estado, origem e
    // motivo de lista fechada. Nada clínico existe no retorno
    clinicsReturn: [
      'patientId',
      'serviceId',
      'unitId',
      'dueDate',
      'status',
      'origin',
      'appointmentId',
      'fulfilledByAttendanceId',
      'assigneeMembershipId',
      'cancelReason',
    ],
    // classe S (ADR-048 adendo 9, F4.2): o alvo, o estado derivado e a marca.
    // Nunca o texto, os valores nem o número
    clinicsOutreachRequest: [
      'kind',
      'appointmentId',
      'startsAt',
      'returnId',
      'state',
      'activeMark',
    ],
    // classe S (ADR-048 adendo 10, F4.3): só os ids do vínculo
    clinicsAppointmentDeal: ['appointmentId', 'dealId'],
  },
};

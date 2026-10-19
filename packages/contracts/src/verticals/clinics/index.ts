import { z } from 'zod';

/**
 * Contratos do vertical Veyra Clinics (ADR-048). Expostos pelo subpath
 * `@veyra/contracts/verticals/clinics`: o barrel do Core NÃO os reexporta — o
 * Core não conhece o vertical (ADR-047, barreira de lint e teste de fronteira).
 */

/**
 * Catálogo de permissões do vertical (ADR-048 §5.1). Prefixo `clinics:`
 * obrigatório; registrado no catálogo global SÓ pela CLI de ativação.
 */
export const CLINICS_PERMISSION_CATALOG = {
  'clinics:catalog:read':
    'Ver unidades, serviços (com duração e preço), profissionais, serviços habilitados e horários',
  'clinics:catalog:manage':
    'Criar, editar e arquivar unidades, serviços, preços, profissionais e horários',
  'clinics:schedule:read':
    'Ver a agenda e o perfil operacional do paciente (sem atendimento, pacote ou saldo)',
  'clinics:schedule:write':
    'Criar perfil de paciente; agendar, remarcar, confirmar, cancelar; registrar chegada e falta',
  'clinics:care:read': 'Ver registros de atendimento, pacotes, saldo e histórico de retornos',
  'clinics:care:write':
    'Registrar atendimento realizado, consumir sessão, criar e encerrar pacote, gerar retorno',
  'clinics:restriction:manage':
    'Liberar um contato para uso de IA como sem relação com o Clinics, ou desfazer a liberação',
} as const;

export type ClinicsPermissionKey = keyof typeof CLINICS_PERMISSION_CATALOG;
export const CLINICS_PERMISSION_KEYS = Object.freeze(
  Object.keys(CLINICS_PERMISSION_CATALOG) as ClinicsPermissionKey[],
);

/** `systemKey` do papel padrão do vertical (ADR-047 E3: prefixo do vertical). */
export const CLINICS_PROFESSIONAL_SYSTEM_KEY = 'clinics:professional';

/**
 * Motivos, por LISTA FECHADA, para liberar um contato para IA (ADR-048 §6.4,
 * adendo 2 do ADR-047). Sem "outro" e sem texto livre.
 */
export const clinicsAiReleaseReasonSchema = z.enum([
  'supplier',
  'partner',
  'staff',
  'non_clinical_business',
]);
export type ClinicsAiReleaseReason = z.infer<typeof clinicsAiReleaseReasonSchema>;

export const grantClinicsAiReleaseSchema = z
  .object({ reason: clinicsAiReleaseReasonSchema })
  .strict();
export type GrantClinicsAiReleaseInput = z.infer<typeof grantClinicsAiReleaseSchema>;

export interface ClinicsStatusDto {
  /** o vertical está ATIVO no workspace da sessão */
  active: boolean;
}

export interface ClinicsAiReleaseDto {
  contactId: string;
  reason: ClinicsAiReleaseReason;
  releasedByMembershipId: string;
  createdAt: string;
}

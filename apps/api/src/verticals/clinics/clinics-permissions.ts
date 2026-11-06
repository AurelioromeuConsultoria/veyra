import { SetMetadata } from '@nestjs/common';
import { SYSTEM_ROLE_TEMPLATES, type PermissionKey } from '@veyra/contracts';
import {
  CLINICS_PERMISSION_KEYS,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
  CLINICS_RECEPTION_CARE_SYSTEM_KEY,
  type ClinicsPermissionKey,
} from '@veyra/contracts/verticals/clinics';
import { PERMISSIONS_KEY } from '../../common/decorators';

/**
 * Decorator de autorização do vertical: as MESMAS metadata da `PermissionsGuard`
 * do Core (default-deny), tipadas com as chaves do Clinics — e as do Core, para
 * rotas que exigem as duas famílias (ADR-048 §5.1). A checagem de boot do E2
 * confere que toda chave existe no catálogo composto.
 */
export const RequireClinicsPermissions = (...keys: (ClinicsPermissionKey | PermissionKey)[]) =>
  SetMetadata(PERMISSIONS_KEY, keys);

// recepção: agenda, sem atendimento e sem liberação de contatos. Os pagamentos
// de pacotes, consultar e registrar, sem anular (ADR-063 adendo 1, F6.1b)
const RECEPCAO: readonly ClinicsPermissionKey[] = [
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:schedule:write',
  'clinics:payments:read',
  'clinics:payments:write',
];
// consulta a agenda e registra atendimento; marcar e remarcar é da recepção
const ATENDIMENTO: readonly ClinicsPermissionKey[] = [
  'clinics:catalog:read',
  'clinics:schedule:read',
  'clinics:care:read',
  'clinics:care:write',
];

/**
 * Matriz de concessão aprovada (ADR-048 §5.2), por `systemKey` — nunca por nome
 * de papel (ADR-017). Aplicada SÓ pela ativação. Guest não recebe nada.
 */
export const CLINICS_ROLE_GRANTS: Readonly<Record<string, readonly ClinicsPermissionKey[]>> = {
  owner: CLINICS_PERMISSION_KEYS,
  admin: CLINICS_PERMISSION_KEYS,
  member: RECEPCAO,
  [CLINICS_PROFESSIONAL_SYSTEM_KEY]: ATENDIMENTO,
  // a SOMA das concessões padrão da recepção e do atendimento (ADR-056): sem a
  // liberação para IA, que é só de Owner e Admin. Com o alcance de TODOS os
  // atendimentos (ADR-061, D8): quem coordena a agenda vê a clínica inteira; o
  // `Profissional`, só os próprios
  [CLINICS_RECEPTION_CARE_SYSTEM_KEY]: [
    ...new Set([
      ...RECEPCAO,
      ...ATENDIMENTO,
      'clinics:care:all' as const,
      // as notas e tarefas de pacientes (ADR-061, adendo 2): quem tem o CRM e o atendimento
      'clinics:patient-content:read' as const,
    ]),
  ],
};

/**
 * Chaves do CORE do papel `Profissional`: só ler o workspace. Sem CRM, sem
 * tarefas, sem conversas — onde pode haver texto clínico digitado por pessoas
 * (ADR-048 §6.7). Dadas na criação do papel e não removidas na desativação.
 */
export const CLINICS_PROFESSIONAL_CORE_KEYS: readonly PermissionKey[] = ['workspace:read'];

export const CLINICS_PROFESSIONAL_ROLE_NAME = 'Profissional';

/**
 * Chaves do CORE de "Recepção e atendimento" (ADR-056): as do Member PADRÃO
 * documentado — o template do Core, nunca o papel do workspace, que pode ter
 * sido personalizado. Sem a gestão de equipe nem de papéis, e sem a auditoria.
 */
export const CLINICS_RECEPTION_CARE_CORE_KEYS: readonly PermissionKey[] = [
  ...SYSTEM_ROLE_TEMPLATES.Member,
];

export const CLINICS_RECEPTION_CARE_ROLE_NAME = 'Recepção e atendimento';

/** Um papel de sistema do vertical: criado pela ativação, ou pela sincronização. */
export interface PapelDoVertical {
  systemKey: string;
  name: string;
  description: string;
  /** as chaves do Core, dadas na criação; as do Clinics vêm de `CLINICS_ROLE_GRANTS` */
  coreKeys: readonly PermissionKey[];
}

/**
 * Os papéis de sistema do Clinics. "Atendimento e conversas" fica PROPOSTO
 * (ADR-056): não é criado nem atribuível.
 */
export const CLINICS_VERTICAL_ROLES: readonly PapelDoVertical[] = [
  {
    systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY,
    name: CLINICS_PROFESSIONAL_ROLE_NAME,
    description: 'Consulta a agenda e registra atendimentos da clínica',
    coreKeys: CLINICS_PROFESSIONAL_CORE_KEYS,
  },
  {
    systemKey: CLINICS_RECEPTION_CARE_SYSTEM_KEY,
    name: CLINICS_RECEPTION_CARE_ROLE_NAME,
    description:
      'Agenda e registra atendimentos da clínica, com o CRM e as conversas da recepção. ' +
      'Sem a gestão de equipe e sem a liberação de contatos para IA',
    coreKeys: CLINICS_RECEPTION_CARE_CORE_KEYS,
  },
];

/** A matriz PADRÃO completa de um papel do vertical: as do Core e as do Clinics. */
export function chavesPadraoDoPapel(papel: PapelDoVertical): string[] {
  return [...new Set([...papel.coreKeys, ...(CLINICS_ROLE_GRANTS[papel.systemKey] ?? [])])].sort();
}

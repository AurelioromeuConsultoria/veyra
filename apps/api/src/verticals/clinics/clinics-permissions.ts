import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import {
  CLINICS_PERMISSION_KEYS,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
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

/**
 * Matriz de concessão aprovada (ADR-048 §5.2), por `systemKey` — nunca por nome
 * de papel (ADR-017). Aplicada SÓ pela ativação. Guest não recebe nada.
 */
export const CLINICS_ROLE_GRANTS: Readonly<Record<string, readonly ClinicsPermissionKey[]>> = {
  owner: CLINICS_PERMISSION_KEYS,
  admin: CLINICS_PERMISSION_KEYS,
  // recepção: agenda, sem atendimento e sem liberação de contatos
  member: ['clinics:catalog:read', 'clinics:schedule:read', 'clinics:schedule:write'],
  // consulta a agenda e registra atendimento; marcar e remarcar é da recepção
  [CLINICS_PROFESSIONAL_SYSTEM_KEY]: [
    'clinics:catalog:read',
    'clinics:schedule:read',
    'clinics:care:read',
    'clinics:care:write',
  ],
};

/**
 * Chaves do CORE do papel `Profissional`: só ler o workspace. Sem CRM, sem
 * tarefas, sem conversas — onde pode haver texto clínico digitado por pessoas
 * (ADR-048 §6.7). Dadas na criação do papel e não removidas na desativação.
 */
export const CLINICS_PROFESSIONAL_CORE_KEYS: readonly PermissionKey[] = ['workspace:read'];

export const CLINICS_PROFESSIONAL_ROLE_NAME = 'Profissional';

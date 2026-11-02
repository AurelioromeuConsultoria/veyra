import { z } from 'zod';

// ── Entradas ─────────────────────────────────────────────────────────────────

export const changeMemberRoleSchema = z.object({
  roleId: z.string().uuid(),
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleSchema>;

export const createInviteSchema = z.object({
  email: z.string().email(),
  roleId: z.string().uuid(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

// ── Saídas ───────────────────────────────────────────────────────────────────

export interface MemberDto {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  roleId: string;
  roleName: string;
  /** a chave do papel de sistema, ou `null` no personalizado: só para a apresentação (ADR-056) */
  roleSystemKey: string | null;
  status: 'active' | 'suspended' | 'removed';
  createdAt: string;
}

export interface RoleDto {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  /**
   * a chave do papel de sistema (`member`, `<extensão>:<papel>`…); `null` no
   * personalizado. Só para a APRESENTAÇÃO reconhecer o papel padrão (ADR-056):
   * o código autoriza por permissão, nunca por papel (ADR-017)
   */
  systemKey: string | null;
  permissions: string[];
  /** a descrição de cada chave de `permissions`, do catálogo composto (ADR-054 item 7) */
  permissionDescriptions: Record<string, string>;
}

export interface InviteDto {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  /** a chave do papel de sistema, ou `null` no personalizado: só para a apresentação (ADR-056) */
  roleSystemKey: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  /** a membership de quem emitiu (ADR-054 item 12); nulo no convite da operação */
  createdByMembershipId: string | null;
  /** emitido pelo provisionamento (CLI de operação), sem membership de origem */
  issuedByProvisioning: boolean;
}

/** Retornado UMA única vez, na criação — o token não é recuperável depois. */
export interface InviteCreatedDto extends InviteDto {
  token: string;
}

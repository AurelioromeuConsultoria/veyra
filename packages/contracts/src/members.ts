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
  status: 'active' | 'suspended' | 'removed';
  createdAt: string;
}

export interface RoleDto {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export interface InviteDto {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/** Retornado UMA única vez, na criação — o token não é recuperável depois. */
export interface InviteCreatedDto extends InviteDto {
  token: string;
}

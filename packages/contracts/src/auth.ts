import { z } from 'zod';
import type { PermissionKey } from './permissions';

// ── Entradas (Zod) ───────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const switchWorkspaceSchema = z.object({
  membershipId: z.string().uuid(),
});
export type SwitchWorkspaceInput = z.infer<typeof switchWorkspaceSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(32).max(200),
  // exigidos quando o e-mail do convite ainda não tem conta (única porta de
  // entrada de usuário novo — ADR-014); ignorados quando a conta já existe
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

// ── Saídas (interfaces DTO — nunca hash/token/segredo) ──────────────────────

export interface MembershipSummaryDto {
  membershipId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  roleName: string;
  status: 'active' | 'suspended' | 'removed';
}

export interface AuthUserDto {
  id: string;
  name: string;
  email: string;
  /** membership ativa desta sessão (null = usuário sem workspace) */
  activeMembership: MembershipSummaryDto | null;
  /** permissões da membership ativa */
  permissions: PermissionKey[];
  memberships: MembershipSummaryDto[];
}

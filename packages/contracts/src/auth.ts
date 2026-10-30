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
  // o nome é exigido quando o e-mail do convite ainda não tem conta (única porta
  // de entrada de usuário novo — ADR-014); ignorado quando a conta já existe
  name: z.string().min(1).max(120).optional(),
  // SEMPRE: a senha da conta existente ou a da conta nova. Opcional, o aceite só
  // com o token respondia sem bcrypt quando havia conta, e o tempo revelava a
  // conta (ADR-054 item 4)
  password: z.string().min(8).max(200),
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
  /** a experiência do workspace (ADR-055): a chave, para o seletor de workspace */
  experience: string;
}

/**
 * A experiência do workspace ativo, como o SERVIDOR a vê (ADR-055 adendo 1):
 * `ready` (do Core, ou a extensão dona confirmou), `unavailable` (a extensão
 * negou ou falhou) ou `unknown` (a chave não está declarada na composição). O
 * servidor só informa; o web nunca cai em silêncio noutra experiência.
 */
export type ExperienceStatus = 'ready' | 'unavailable' | 'unknown';
export interface ExperienceDto {
  key: string;
  status: ExperienceStatus;
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
  /** a experiência do workspace ativo (null = usuário sem workspace) */
  experience: ExperienceDto | null;
}

/**
 * Escopo da sessão para o cache da tela (ADR-050): identidade + workspace +
 * experiência (ADR-055 adendo 1). O servidor o devolve em toda resposta
 * autenticada, com a identidade revalidada; o web descarta a resposta cujo
 * escopo não é o da aba. A experiência entra porque ela pode mudar no MESMO
 * workspace, sem troca de identidade, e o que era da experiência anterior não
 * pode chegar à nova.
 */
export const SESSION_SCOPE_HEADER = 'x-veyra-scope';
/**
 * O escopo que a aba ESPERA, mandado pelo web em cada requisição: o servidor
 * recusa (409) a que vier com um cookie de outra sessão — a aba desatualizada,
 * depois de um login ou troca de workspace em outra aba (ADR-050).
 */
export const SESSION_EXPECTED_SCOPE_HEADER = 'x-veyra-expected-scope';
/**
 * Marca da resposta que EMITE sessão (login, troca de workspace, aceite de
 * convite): o web troca de sessão ao vê-la, sem lista de rotas. O refresh
 * também leva a marca, mas é tratado por ADOÇÃO (troca só se o escopo mudou):
 * trocar a cada refresh remontaria a tela a cada expiração do access.
 */
export const SESSION_ISSUED_HEADER = 'x-veyra-new-session';

export function sessionScopeKey(
  userId: string,
  membershipId: string | null | undefined,
  experience: string | null | undefined,
): string {
  return `${userId}:${membershipId ?? '-'}:${experience ?? '-'}`;
}

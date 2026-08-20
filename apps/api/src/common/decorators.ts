import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';

export const IS_PUBLIC_KEY = 'veyra:isPublic';
/** Endpoint NÃO autenticado — a única exceção desse tipo (SECURITY.md §3). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const AUTH_ONLY_KEY = 'veyra:authenticatedOnly';
/**
 * Endpoint que exige APENAS autenticação, sem permissão específica — raro e
 * revisável (ADR-016). Sem este decorator nem @RequirePermissions, a
 * PermissionsGuard NEGA (default-deny).
 */
export const AuthenticatedOnly = () => SetMetadata(AUTH_ONLY_KEY, true);

export const PERMISSIONS_KEY = 'veyra:requiredPermissions';
export const RequirePermissions = (...keys: PermissionKey[]) => SetMetadata(PERMISSIONS_KEY, keys);

/** Contexto autenticado montado pelo JwtAuthGuard e anexado à request. */
export interface AuthContext {
  userId: string;
  email: string;
  /** null = usuário autenticado sem workspace ativo */
  membershipId: string | null;
  workspaceId: string | null;
  /** id do RefreshToken (sessão) que originou este access token */
  sessionId: string;
}

export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<{ auth?: AuthContext }>();
    if (!request.auth) {
      throw new Error('CurrentAuth usado em rota sem JwtAuthGuard — bug de configuração.');
    }
    return request.auth;
  },
);

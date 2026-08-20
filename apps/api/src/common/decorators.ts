import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';

export const IS_PUBLIC_KEY = 'veyra:isPublic';
/** Endpoint NÃO autenticado — a única exceção desse tipo (SECURITY.md §3). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Rota de WEBHOOK DE PROVEDOR: pública, sem cookie e autenticada por outro meio
 * (assinatura HMAC sobre o corpo bruto — ADR-037). Isenta da validação de
 * Origin/CSRF, que existe para impedir o NAVEGADOR de anexar credencial nossa a
 * um pedido de terceiro; aqui não há credencial para anexar, e provedores não
 * mandam `Origin`.
 *
 * Deliberadamente separado de `@Public()`: o login também é público, PORÉM
 * estabelece cookie e precisa da validação de Origin contra login cross-site.
 * Isentar tudo que é público afrouxaria essa proteção — e o teste de auth pegou
 * exatamente isso.
 */
export const PROVIDER_WEBHOOK_KEY = 'veyra:providerWebhook';
export const ProviderWebhook = () => SetMetadata(PROVIDER_WEBHOOK_KEY, true);

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

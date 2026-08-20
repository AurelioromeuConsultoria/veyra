import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTH_ONLY_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../common/decorators';
import { PermissionsGuard } from './permissions.guard';

/** Matriz do default-deny (ADR-016) com dependências falsas — sem banco. */
describe('PermissionsGuard — default-deny', () => {
  function build(options: {
    metadata: Record<string, unknown>;
    auth?: { membershipId: string | null } | undefined;
    granted?: string[];
  }) {
    const reflector = {
      getAllAndOverride: (key: string) => options.metadata[key],
    } as unknown as Reflector;
    const prisma = {
      db: {
        rolePermission: {
          findMany: async () => (options.granted ?? []).map((permissionKey) => ({ permissionKey })),
        },
      },
    };
    const cls = { get: () => 'role-id' };
    const guard = new PermissionsGuard(reflector, prisma as never, cls as never);
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ auth: options.auth }) }),
    } as unknown as ExecutionContext;
    return () => guard.canActivate(context);
  }

  const auth = { membershipId: 'm1' };

  it('@Public passa sem autenticação', async () => {
    await expect(build({ metadata: { [IS_PUBLIC_KEY]: true } })()).resolves.toBe(true);
  });

  it('sem auth em rota privada → 401', async () => {
    await expect(build({ metadata: {}, auth: undefined })()).rejects.toThrow(UnauthorizedException);
  });

  it('DEFAULT-DENY: autenticado mas sem decorator → 403 com referência ao ADR-016', async () => {
    await expect(build({ metadata: {}, auth })()).rejects.toThrow(/ADR-016/);
  });

  it('@AuthenticatedOnly: autenticado passa', async () => {
    await expect(build({ metadata: { [AUTH_ONLY_KEY]: true }, auth })()).resolves.toBe(true);
  });

  it('@RequirePermissions concedida passa; faltante → 403', async () => {
    await expect(
      build({
        metadata: { [PERMISSIONS_KEY]: ['contacts:read'] },
        auth,
        granted: ['contacts:read'],
      })(),
    ).resolves.toBe(true);
    await expect(
      build({ metadata: { [PERMISSIONS_KEY]: ['members:manage'] }, auth, granted: [] })(),
    ).rejects.toThrow(ForbiddenException);
  });

  it('@RequirePermissions sem workspace ativo na sessão → 403', async () => {
    await expect(
      build({
        metadata: { [PERMISSIONS_KEY]: ['contacts:read'] },
        auth: { membershipId: null },
      })(),
    ).rejects.toThrow(/workspace/i);
  });
});

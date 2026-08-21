import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfOriginGuard } from './csrf-origin.guard';

describe('CsrfOriginGuard — Origin + double-submit (ajuste #7)', () => {
  const WEB_ORIGIN = 'http://localhost:5175';
  /** Reflector falso: `false` = rota comum (não é webhook de provedor). */
  const reflector = (isProviderWebhook: boolean) =>
    ({ getAllAndOverride: () => isProviderWebhook }) as never;
  const guard = new CsrfOriginGuard({ getOrThrow: () => WEB_ORIGIN } as never, reflector(false));

  function ctx(req: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext;
  }

  it('métodos seguros passam sem checagem', () => {
    expect(guard.canActivate(ctx({ method: 'GET', headers: {} }))).toBe(true);
  });

  it('Bearer (API) fica isento — não usa cookies', () => {
    expect(guard.canActivate(ctx({ method: 'POST', authVia: 'header', headers: {} }))).toBe(true);
  });

  it('mutação sem Origin/Referer → 403; Origin errado → 403', () => {
    expect(() => guard.canActivate(ctx({ method: 'POST', headers: {} }))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      guard.canActivate(ctx({ method: 'POST', headers: { origin: 'https://mal.example' } })),
    ).toThrow(/Origem/);
  });

  it('Origin certo sem sessão-cookie (login) passa; com sessão exige double-submit', () => {
    expect(guard.canActivate(ctx({ method: 'POST', headers: { origin: WEB_ORIGIN } }))).toBe(true);
    const base = {
      method: 'POST',
      authVia: 'cookie',
      auth: { userId: 'u1' },
      cookies: { veyra_csrf: 'token-ok' },
    };
    expect(() => guard.canActivate(ctx({ ...base, headers: { origin: WEB_ORIGIN } }))).toThrow(
      /CSRF/,
    );
    expect(() =>
      guard.canActivate(
        ctx({ ...base, headers: { origin: WEB_ORIGIN, 'x-csrf-token': 'forjado' } }),
      ),
    ).toThrow(/CSRF/);
    expect(
      guard.canActivate(
        ctx({ ...base, headers: { origin: WEB_ORIGIN, 'x-csrf-token': 'token-ok' } }),
      ),
    ).toBe(true);
  });

  it('Referer do front vale quando Origin está ausente', () => {
    expect(
      guard.canActivate(ctx({ method: 'POST', headers: { referer: `${WEB_ORIGIN}/login` } })),
    ).toBe(true);
  });

  it('webhook de provedor é isento: sem cookie, autenticado por assinatura', () => {
    const doWebhook = new CsrfOriginGuard(
      { getOrThrow: () => WEB_ORIGIN } as never,
      reflector(true),
    );
    // sem Origin e sem CSRF — exatamente o que a Meta manda
    expect(doWebhook.canActivate(ctx({ method: 'POST', headers: {} }))).toBe(true);
  });

  it('rota comum sem Origin continua recusada — a isenção NÃO é geral', () => {
    expect(() => guard.canActivate(ctx({ method: 'POST', headers: {} }))).toThrow(
      ForbiddenException,
    );
  });
});

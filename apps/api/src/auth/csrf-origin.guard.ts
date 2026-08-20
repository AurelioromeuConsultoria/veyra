import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthContext } from '../common/decorators';
import { CSRF_COOKIE, CSRF_HEADER } from './tokens';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Guard global nº 2 — proteção de mutações que dependem de cookies (ajuste #7):
 * 1. Origin (ou Referer) DEVE bater com WEB_ORIGIN em toda mutação sem Bearer —
 *    inclusive @Public (login/refresh/aceite): CORS sozinho não impede um
 *    formulário cross-site de disparar o POST.
 * 2. Sessão via cookie: double-submit — header x-csrf-token === cookie veyra_csrf.
 * Autenticação via Authorization: Bearer (API pública futura) não usa cookies e
 * fica isenta das duas checagens.
 */
@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { auth?: AuthContext; authVia?: 'header' | 'cookie' }>();
    if (SAFE_METHODS.has(request.method)) return true;
    if (request.authVia === 'header') return true;

    const webOrigin = new URL(this.config.getOrThrow<string>('WEB_ORIGIN')).origin;
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const originOk =
      (typeof origin === 'string' && origin === webOrigin) ||
      (!origin && typeof referer === 'string' && new URL(referer).origin === webOrigin);
    if (!originOk) {
      throw new ForbiddenException('Origem não autorizada');
    }

    // double-submit apenas quando há sessão via cookie estabelecida
    if (request.auth && request.authVia === 'cookie') {
      const headerToken = request.headers[CSRF_HEADER];
      const cookieToken = (request.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE];
      if (!headerToken || !cookieToken || headerToken !== cookieToken) {
        throw new ForbiddenException('Token CSRF ausente ou inválido');
      }
    }
    return true;
  }
}

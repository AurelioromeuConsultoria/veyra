import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'veyra_access';
export const REFRESH_COOKIE = 'veyra_refresh';
export const CSRF_COOKIE = 'veyra_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Escopo do JWT: rejeita tokens assinados com o mesmo segredo para outros fins. */
export const JWT_ISSUER = 'veyra';
export const JWT_AUDIENCE = 'veyra-api';

/** Refresh/invite tokens nunca são persistidos em claro — só o SHA-256. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

export function generateCsrfToken(): string {
  return randomBytes(24).toString('base64url');
}

function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}

export interface SessionCookies {
  access: string;
  refresh: string;
  csrf: string;
  accessTtlSeconds: number;
  refreshTtlDays: number;
}

export function setSessionCookies(res: Response, cookies: SessionCookies): void {
  res.cookie(ACCESS_COOKIE, cookies.access, {
    ...baseCookie(),
    maxAge: cookies.accessTtlSeconds * 1000,
  });
  // escopo restrito: o refresh só trafega para os endpoints de auth.
  // refresh vazio = operação que não rotaciona (switch-workspace): preserva o cookie
  if (cookies.refresh) {
    res.cookie(REFRESH_COOKIE, cookies.refresh, {
      ...baseCookie(),
      path: '/api/auth',
      maxAge: cookies.refreshTtlDays * 24 * 60 * 60 * 1000,
    });
  }
  // legível pelo front (double-submit): NÃO httpOnly, por design
  res.cookie(CSRF_COOKIE, cookies.csrf, {
    ...baseCookie(),
    httpOnly: false,
    maxAge: cookies.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, baseCookie());
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { ...baseCookie(), httpOnly: false });
}

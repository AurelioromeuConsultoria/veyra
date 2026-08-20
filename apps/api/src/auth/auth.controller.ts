import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AuthUserDto,
  LoginInput,
  SwitchWorkspaceInput,
  loginSchema,
  switchWorkspaceSchema,
} from '@veyra/contracts';
import type { Request, Response } from 'express';
import { AuthContext, AuthenticatedOnly, CurrentAuth, Public } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { REFRESH_COOKIE, clearSessionCookies, setSessionCookies } from './tokens';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** @Public justificado: é a porta de entrada; rate-limited (brute force). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  async login(
    @Body(new ZodPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUserDto> {
    const session = await this.auth.login(body.email, body.password);
    setSessionCookies(res, session.cookies);
    return session.user;
  }

  /** @Public justificado: access expirado; a credencial é o cookie de refresh. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUserDto> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    const session = await this.auth.refresh(presented);
    setSessionCookies(res, session.cookies);
    return session.user;
  }

  /** @AuthenticatedOnly (ajuste #5): revoga a sessão e limpa cookies. */
  @AuthenticatedOnly()
  @Post('logout')
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await this.auth.logout(auth, presented);
    clearSessionCookies(res);
    return { ok: true };
  }

  /** @AuthenticatedOnly: o caso raro legítimo — identidade da própria sessão. */
  @AuthenticatedOnly()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<AuthUserDto> {
    return this.auth.me(auth);
  }

  /** @AuthenticatedOnly: troca para membership ativa DO PRÓPRIO usuário. */
  @AuthenticatedOnly()
  @Post('switch-workspace')
  async switchWorkspace(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(switchWorkspaceSchema)) body: SwitchWorkspaceInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthUserDto> {
    const session = await this.auth.switchWorkspace(auth, body.membershipId);
    setSessionCookies(res, session.cookies);
    return session.user;
  }
}

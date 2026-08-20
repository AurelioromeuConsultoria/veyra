import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { Request } from 'express';
import { AuthContext, IS_PUBLIC_KEY } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload } from './auth.service';
import { ACCESS_COOKIE, JWT_AUDIENCE, JWT_ISSUER } from './tokens';

/**
 * Guard global nº 1 (SECURITY.md §3): endpoints privados por padrão, @Public()
 * é o opt-out explícito. Valida o access token (Bearer OU cookie) e revalida
 * TUDO no banco a cada request — nada é confiado só pelos claims do JWT:
 *  - a sessão (RefreshToken sessionId) está viva (não revogada, não expirada) —
 *    logout e reuso derrubam access tokens já emitidos na request seguinte;
 *  - o User existe e está ativo (suspensão vale imediatamente);
 *  - quando há workspace: a membership está ativa, tokenVersion casa (ADR-009)
 *    e o workspace está ativo.
 * Tudo via prisma.raw — exceção "autenticação/identidade global" (SECURITY.md §2).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<
        Request & { auth?: AuthContext; authVia?: 'header' | 'cookie'; isPublic?: boolean }
      >();

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      request.isPublic = true;
      return true;
    }

    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const cookieToken = (request.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    const token = bearer ?? cookieToken;
    if (!token) throw new UnauthorizedException('Não autenticado');
    request.authVia = bearer ? 'header' : 'cookie';

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Não autenticado');
    }
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sessionId !== 'string' ||
      typeof payload.email !== 'string'
    ) {
      throw new UnauthorizedException('Não autenticado');
    }

    // sessão viva? (logout/reuso/expiração derrubam o access na request seguinte)
    const session = await this.prisma.raw.refreshToken.findFirst({
      where: {
        id: payload.sessionId,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) throw new UnauthorizedException('Sessão expirada');

    // usuário existe e está ativo? (suspensão global vale imediatamente)
    const user = await this.prisma.raw.user.findFirst({
      where: { id: payload.sub, status: 'active' },
      select: { id: true },
    });
    if (!user) throw new UnauthorizedException('Sessão expirada');

    if (payload.membershipId) {
      // membership ativa + tokenVersion (ADR-009) + workspace ativo
      const membership = await this.prisma.raw.membership.findFirst({
        where: {
          id: payload.membershipId,
          userId: payload.sub,
          status: 'active',
          workspace: { status: 'active' },
        },
        select: { id: true, workspaceId: true, roleId: true, tokenVersion: true },
      });
      if (!membership || membership.tokenVersion !== payload.tokenVersion) {
        throw new UnauthorizedException('Sessão expirada');
      }
      this.cls.set('workspaceId', membership.workspaceId);
      this.cls.set('roleId', membership.roleId);
    }
    this.cls.set('userId', payload.sub);
    this.cls.set('membershipId', payload.membershipId);

    request.auth = {
      userId: payload.sub,
      email: payload.email,
      membershipId: payload.membershipId,
      workspaceId: payload.membershipId ? payload.workspaceId : null,
      sessionId: payload.sessionId,
    };
    return true;
  }
}

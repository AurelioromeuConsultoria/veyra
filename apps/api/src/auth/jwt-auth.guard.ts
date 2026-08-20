import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { Request } from 'express';
import { AuthContext, IS_PUBLIC_KEY } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload } from './auth.service';
import { ACCESS_COOKIE } from './tokens';

/**
 * Guard global nº 1 (SECURITY.md §3): endpoints privados por padrão, @Public()
 * é o opt-out explícito. Valida o access token (Bearer OU cookie), revalida a
 * membership viva + tokenVersion (revogação imediata, ADR-009) e popula o CLS.
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
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Não autenticado');
    }

    if (payload.membershipId) {
      // raw justificado: autenticação — revalida a membership ANTES de existir
      // CLS; tokenVersion divergente = sessão revogada (ADR-009)
      const membership = await this.prisma.raw.membership.findFirst({
        where: { id: payload.membershipId, userId: payload.sub, status: 'active' },
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

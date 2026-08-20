import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';
import type { PermissionKey } from '@veyra/contracts';
import type { Request } from 'express';
import { AUTH_ONLY_KEY, AuthContext, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Guard global nº 3 — DEFAULT-DENY (ADR-016): endpoint privado sem
 * @RequirePermissions(...) nem @AuthenticatedOnly() é NEGADO. Estar
 * autenticado não basta; esquecer decorator quebra em dev (falha visível),
 * nunca abre acesso (falha silenciosa).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    if (!request.auth) throw new UnauthorizedException('Não autenticado');

    if (this.reflector.getAllAndOverride<boolean>(AUTH_ONLY_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    if (required === undefined) {
      throw new ForbiddenException(
        'Endpoint sem permissão declarada — default-deny (ADR-016). ' +
          'Declare @RequirePermissions(...) ou, se só exige autenticação, @AuthenticatedOnly().',
      );
    }
    if (required.length === 0) return true;

    if (!request.auth.membershipId) {
      throw new ForbiddenException('Nenhum workspace ativo nesta sessão');
    }
    const roleId = this.cls.get<string>('roleId');
    // fail-closed: roleId ausente no CLS jamais vira where:{roleId:undefined}
    // (que o Prisma ignoraria, concedendo TODAS as permissões do workspace)
    if (typeof roleId !== 'string' || roleId.length === 0) {
      throw new ForbiddenException('Permissão insuficiente');
    }
    // db (tenant-safe): RolePermission é protegido e o CLS já tem o workspace
    const rows = await this.prisma.db.rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true },
    });
    const granted = new Set(rows.map((r) => r.permissionKey));
    const missing = required.filter((key) => !granted.has(key));
    if (missing.length > 0) {
      throw new ForbiddenException('Permissão insuficiente');
    }
    return true;
  }
}

import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { AuthContext } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Checagem de permissão FORA do guard, para autorização condicional dentro de
 * um handler (ex.: timeline de deal exige pipelines:read além do piso). Mesma
 * fonte do PermissionsGuard: RolePermission do role da membership ativa.
 */
@Injectable()
export class PermissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async has(auth: AuthContext, key: PermissionKey): Promise<boolean> {
    if (!auth.membershipId) return false;
    const roleId = this.cls.get<string>('roleId');
    if (typeof roleId !== 'string' || roleId.length === 0) return false; // fail-closed
    const row = await this.prisma.db.rolePermission.findFirst({
      where: { roleId, permissionKey: key },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * A permissão de OUTRA membership ativa deste workspace (o client filtrado
   * garante o workspace). Usada quando a ação depende de quem recebe, não de
   * quem pede — por exemplo, atribuir uma conversa RAI (ADR-052, C13).
   */
  async membershipHas(membershipId: string, key: PermissionKey): Promise<boolean> {
    const membership = await this.prisma.db.membership.findFirst({
      where: { id: membershipId, status: 'active' },
      select: { roleId: true },
    });
    if (!membership) return false;
    const row = await this.prisma.db.rolePermission.findFirst({
      where: { roleId: membership.roleId, permissionKey: key },
      select: { id: true },
    });
    return row !== null;
  }
}

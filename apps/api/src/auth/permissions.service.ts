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
}

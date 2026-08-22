import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Verificação de permissão EM RUNTIME, para quando o dado da resposta — e não o
 * acesso à rota — depende do direito de quem pede.
 *
 * A `PermissionsGuard` resolve tudo-ou-nada por rota; aqui a rota é permitida a
 * mais gente do que os campos. Caso concreto (ADR-034/041): o medidor de uso é
 * informação de trabalho (`workspace:read`), mas a SITUAÇÃO COMERCIAL da conta
 * (status, preço, fim do período) é de quem gere billing. Esconder na tela não
 * resolve: quem chama a API recebe o payload inteiro.
 *
 * Fail-closed por construção: sem `roleId` no contexto, ninguém tem nada.
 */
@Injectable()
export class PermissionCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async has(permissionKey: string): Promise<boolean> {
    const roleId = this.cls.get<string>('roleId');
    // mesmo cuidado da guarda: roleId ausente NUNCA vira where sem filtro, que o
    // Prisma ignoraria e concederia toda permissão do workspace
    if (typeof roleId !== 'string' || roleId.length === 0) return false;
    const row = await this.prisma.db.rolePermission.findFirst({
      where: { roleId, permissionKey },
      select: { permissionKey: true },
    });
    return row !== null;
  }
}

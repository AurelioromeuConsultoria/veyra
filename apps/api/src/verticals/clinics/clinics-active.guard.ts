import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthContext } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Rotas do vertical só existem onde ele está ATIVO (ADR-047 E3). Roda DEPOIS dos
 * guards globais: num workspace sem o Clinics nenhum papel tem chave
 * `clinics:*`, e a `PermissionsGuard` já responde 403. Este 404 cobre o caso
 * residual de chave presente em workspace desativado (ADR-047 adendo 2, item 4).
 */
@Injectable()
export class ClinicsActiveGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ auth?: AuthContext }>();
    if (!request.auth?.workspaceId) throw new NotFoundException();
    const settings = (await this.prisma.db.clinicsSettings.findFirst({
      select: { status: true },
    })) as { status: string } | null;
    if (settings?.status !== 'active') throw new NotFoundException();
    return true;
  }
}

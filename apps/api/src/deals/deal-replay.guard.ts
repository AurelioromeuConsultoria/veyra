import { Injectable } from '@nestjs/common';
import type { DealDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { ProtectedContentService } from '../extensions/protected-content';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A repetição da criação ou do movimento de uma oportunidade devolve o corpo
 * guardado com a regra de leitura de AGORA (E8; ADR-061, adendo 6): decide
 * pelo contato ATUAL da oportunidade (ele pode ter sido trocado depois); a
 * oportunidade que não existe mais é tratada na dúvida (conservador). Nada é
 * executado de novo.
 */
@Injectable()
export class DealReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    if (!request.auth) return 'unavailable';
    const dto = guardado.body as DealDto;
    const atual = (await this.prisma.db.deal.findFirst({
      where: { id: dto.id },
      select: { contactId: true },
    } as never)) as { contactId: string | null } | null;
    const oculto = atual
      ? (await this.protegido.contatosOcultos(request.auth, [atual.contactId])).size > 0
      : await this.protegido.duvidaOculta(request.auth);
    return { reproject: oculto ? { ...dto, title: '', titleRestricted: true as const } : dto };
  }
}

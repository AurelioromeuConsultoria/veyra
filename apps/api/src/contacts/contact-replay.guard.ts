import { Injectable } from '@nestjs/common';
import type { ContactDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { ProtectedContentService } from '../extensions/protected-content';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A repetição da criação de contato (mesma `Idempotency-Key`) devolve o corpo
 * guardado com a regra de leitura de AGORA (E8; ADR-061, adendo 6): o contato
 * que passou a ser protegido sai com os campos personalizados mascarados. O
 * contato que não existe mais é tratado na dúvida (conservador). A criação
 * aconteceu uma vez; nada é executado de novo.
 */
@Injectable()
export class ContactReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    if (!request.auth) return 'unavailable';
    const dto = guardado.body as ContactDto;
    const existe = (await this.prisma.db.contact.count({ where: { id: dto.id } } as never)) > 0;
    const oculto = existe
      ? (await this.protegido.contatosOcultos(request.auth, [dto.id])).size > 0
      : await this.protegido.duvidaOculta(request.auth);
    return {
      reproject: oculto ? { ...dto, customFields: {}, customFieldsRestricted: true as const } : dto,
    };
  }
}

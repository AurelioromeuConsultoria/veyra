import { ForbiddenException, Injectable } from '@nestjs/common';
import type { TaskDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A repetição da criação de tarefa: se o alvo ATUAL dela (pode ter sido
 * trocado depois) é oculto para quem pede (E8; ADR-061, adendo 6), o corpo
 * guardado não sai — a mesma recusa da criação, sem executar de novo. A
 * tarefa que não existe mais é tratada na dúvida (conservador).
 */
@Injectable()
export class TaskReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    if (!request.auth) return 'unavailable';
    const atual = (await this.prisma.db.task.findFirst({
      where: { id: (guardado.body as TaskDto).id },
      select: { contactId: true, dealId: true },
    } as never)) as { contactId: string | null; dealId: string | null } | null;
    const oculto = atual
      ? await this.protegido.alvoOculto(request.auth, atual)
      : await this.protegido.duvidaOculta(request.auth);
    return oculto ? { refuse: new ForbiddenException(CONTEUDO_RESTRITO) } : 'replay';
  }
}

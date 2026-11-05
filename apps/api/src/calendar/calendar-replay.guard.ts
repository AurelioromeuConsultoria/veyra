import { Injectable } from '@nestjs/common';
import type { CalendarEventDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { ProtectedContentService } from '../extensions/protected-content';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarService, comTextoRestrito } from './calendar.service';

/**
 * A repetição da criação de um evento devolve o corpo guardado com a regra de
 * leitura de AGORA (E8; ADR-061, adendos 6 e 8): decide pelos vínculos ATUAIS
 * do evento (podem ter sido trocados depois, e o interessado pode ter virado
 * paciente); o evento que não existe mais é tratado na dúvida (conservador).
 * Nada é executado de novo.
 */
@Injectable()
export class CalendarReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: CalendarService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    if (!request.auth) return 'unavailable';
    const dto = guardado.body as CalendarEventDto;
    const atual = (await this.prisma.db.calendarEvent.findFirst({
      where: { id: dto.id },
      select: { id: true, contactId: true, dealId: true },
    } as never)) as { id: string; contactId: string | null; dealId: string | null } | null;
    const oculto = atual
      ? (await this.calendar.textosOcultos(request.auth, [atual])).size > 0
      : await this.protegido.duvidaOculta(request.auth);
    return { reproject: oculto ? comTextoRestrito(dto) : dto };
  }
}

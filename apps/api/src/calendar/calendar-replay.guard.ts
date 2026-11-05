import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CalendarEventDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { CalendarService, comTextoRestrito } from './calendar.service';

/**
 * A repetição da criação de um evento segue a regra de AGORA (E8; ADR-061,
 * adendos 6 e 8, com as ressalvas da revisão). O evento é julgado pelos
 * vínculos de agora e pelo histórico deles (podem ter sido trocados depois,
 * e o interessado pode ter virado paciente); o que não existe mais vai na
 * dúvida (conservador). Nada é executado de novo nem apagado.
 *
 * - **`uniforme`** (quem não pode saber quem é protegido): o evento de texto
 *   oculto dá a MESMA resposta que um pedido novo daria agora — 403
 *   "Conteúdo restrito", como a criação para uma pessoa e a edição do evento
 *   dela —, e não o corpo mascarado com 201;
 * - **`restrito`**: o corpo guardado, com o texto restrito se ele é oculto
 *   (um pedido novo da recepção também cria e responde mascarado);
 * - **`livre`**: o corpo guardado.
 *
 * Falha ao ler: 503, sem apagar nada.
 */
@Injectable()
export class CalendarReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly calendar: CalendarService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return 'unavailable';
    try {
      const dto = guardado.body as CalendarEventDto;
      // o evento que não existe mais fica fora do histórico: na dúvida, oculto
      const oculto =
        typeof dto?.id === 'string'
          ? (
              await this.calendar.textosOcultos(auth, [
                { id: dto.id, contactId: dto.contactId ?? null, dealId: dto.dealId ?? null },
              ])
            ).size > 0
          : await this.protegido.duvidaOculta(auth);
      if (!oculto) return { reproject: dto };
      if (await this.protegido.semClassificacao(auth)) {
        return { refuse: new ForbiddenException(CONTEUDO_RESTRITO) };
      }
      return { reproject: comTextoRestrito(dto) };
    } catch {
      // não deu para decidir agora: nem devolve, nem apaga
      return 'unavailable';
    }
  }
}

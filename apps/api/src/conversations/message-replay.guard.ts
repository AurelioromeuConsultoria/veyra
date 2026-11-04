import { Injectable } from '@nestjs/common';
import type { MessageDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { ConversationsService } from './conversations.service';

/**
 * A repetição do registro de mensagem devolve o corpo guardado com a regra de
 * leitura de AGORA (E8; ADR-061, adendo 6): os anexos que passaram a ser
 * protegidos saem restritos, e o marcador do tipo, genérico. Nada é executado
 * de novo — a mensagem foi registrada uma vez.
 */
@Injectable()
export class MessageReplayGuard implements IdempotentReplayGuard {
  constructor(private readonly conversations: ConversationsService) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const conversationId = request.params?.id;
    if (!request.auth || typeof conversationId !== 'string') return 'unavailable';
    return {
      reproject: await this.conversations.reprojetarMensagem(
        request.auth,
        conversationId,
        guardado.body as MessageDto,
      ),
    };
  }
}

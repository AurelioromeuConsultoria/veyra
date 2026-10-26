import { ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../common/decorators';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import { ConversationsService } from '../conversations/conversations.service';

const MENSAGEM_ACESSO_MUDOU =
  'O registro desta chave já foi feito, mas a resposta guardada mostra o número completo, e o seu acesso atual não permite vê-lo.';

/**
 * O replay do pedido de parar e do desbloqueio PELA CONVERSA (F4.1b, ADR-052).
 * O corpo guardado foi projetado com o acesso de quem pediu NAQUELA hora: o
 * número completo só com `contacts:read`, e a RAI só para quem tem
 * `contacts:write` (C13). A rota não exige nenhum dos dois; a membership no
 * hash impede o corpo de ir a OUTRA pessoa, mas não a mesma pessoa depois de
 * perder o acesso. Esta guarda refaz, na repetição:
 *
 * - a leitura da conversa com a visibilidade de agora: sem ela, a mesma recusa
 *   da rota (404), e não o corpo guardado;
 * - a projeção do número: guardado completo, sem `contacts:read` agora, recusa.
 *
 * Nunca descarta nem executa de novo: o registro já aconteceu, e repeti-lo
 * seria uma operação nova. Falha ao ler: 503, sem apagar nada.
 */
@Injectable()
export class ConversationConsentReplayGuard implements IdempotentReplayGuard {
  constructor(private readonly conversations: ConversationsService) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const id = request.params?.conversationId;
    const auth = request.auth;
    if (typeof id !== 'string' || !auth) {
      return { refuse: new NotFoundException('Conversa não encontrada') };
    }
    let mostraNumero: boolean;
    try {
      ({ mostraNumero } = await this.conversations.alvoDoConsentimento(auth, id));
    } catch (erro) {
      // a recusa da rota, com o acesso de agora; outro erro não decide nada
      return erro instanceof HttpException ? { refuse: erro } : 'unavailable';
    }
    const numero = (guardado.body as { number?: unknown } | null)?.number;
    const mascarado = typeof numero === 'string' && numero.startsWith('•••• ');
    if (!mostraNumero && !mascarado) {
      return { refuse: new ForbiddenException(MENSAGEM_ACESSO_MUDOU) };
    }
    return 'replay';
  }
}

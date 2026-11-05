import { HttpException, Injectable } from '@nestjs/common';
import type { ConversationDto, MessageDto } from '@veyra/contracts';
import type { Request } from 'express';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import type { AuthContext } from '../common/decorators';
import { ProtectedContentService } from '../extensions/protected-content';
import { ConversationsService } from './conversations.service';

/**
 * No `uniforme`, a repetição dá a MESMA resposta que um pedido novo daria
 * agora (ADR-061, adendo 9, item 8; o padrão do adendo 6): as conferências que
 * o pedido novo faz antes de escrever rodam de novo, e a recusa delas (o 403
 * "Conteúdo restrito" da conversa com pessoa, o 404 da conversa que quem pede
 * não vê) é a resposta. Nada é executado de novo nem apagado. A falha ao
 * decidir dá 503, sem apagar o guardado.
 */
async function recusaDoUniforme(
  protegido: ProtectedContentService,
  auth: AuthContext,
  conferir: () => Promise<void>,
): Promise<ReplayVerdict | null> {
  try {
    if (!(await protegido.semClassificacao(auth))) return null;
    await conferir();
    return null;
  } catch (erro) {
    if (erro instanceof HttpException) return { refuse: erro };
    return 'unavailable';
  }
}

/**
 * A repetição do registro de mensagem devolve o corpo guardado com a regra de
 * leitura de AGORA (E8; ADR-061, adendo 6): os anexos que passaram a ser
 * protegidos saem restritos, e o marcador do tipo, genérico. Nada é executado
 * de novo — a mensagem foi registrada uma vez. No `uniforme`, a resposta de um
 * pedido novo (adendo 9, item 8).
 */
@Injectable()
export class MessageReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const conversationId = request.params?.id;
    const auth = request.auth;
    if (!auth || typeof conversationId !== 'string') return 'unavailable';
    const recusa = await recusaDoUniforme(this.protegido, auth, () =>
      this.conversations.conferirRegistro(auth, conversationId),
    );
    if (recusa) return recusa;
    return {
      reproject: await this.conversations.reprojetarMensagem(
        auth,
        conversationId,
        guardado.body as MessageDto,
      ),
    };
  }
}

/**
 * A repetição da criação de conversa (ADR-061, adendo 9, item 8): no
 * `uniforme`, a conversa pedida PARA uma pessoa dá a resposta de um pedido
 * novo (403 "Conteúdo restrito") e não o corpo guardado, que traria o assunto
 * escrito sobre ela. A conversa sem pessoa, e o `restrito` e o `livre`,
 * repetem o corpo guardado, como antes.
 */
@Injectable()
export class ConversationCreateReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly protegido: ProtectedContentService,
  ) {}

  async verdict(
    request: Request & { auth?: AuthContext },
    guardado: { status: number; body: unknown },
  ): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return 'unavailable';
    // o corpo é o do pedido guardado: a mesma chave com outro corpo é 409 antes
    const pedido = (request.body ?? {}) as { contactId?: unknown };
    const guardada = guardado.body as Partial<ConversationDto> | null;
    const contactId =
      typeof pedido.contactId === 'string'
        ? pedido.contactId
        : typeof guardada?.contactId === 'string'
          ? guardada.contactId
          : null;
    const recusa = await recusaDoUniforme(this.protegido, auth, () =>
      this.conversations.conferirCriacao(auth, { contactId }),
    );
    return recusa ?? 'replay';
  }
}

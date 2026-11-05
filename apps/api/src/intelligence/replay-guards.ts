import { HttpException, Injectable } from '@nestjs/common';
import { semRepetidos } from './sujeitos';
import type { Request } from 'express';
import type { AuthContext } from '../common/decorators';
import type { IdempotentReplayGuard, ReplayVerdict } from '../common/idempotency.decorator';
import { ConversationsService } from '../conversations/conversations.service';
import { LlmGateway } from './llm/llm.gateway';

type AuthedRequest = Request & { auth?: AuthContext };
type Verdict = 'replay' | 'discard' | 'unavailable';

const fromGateway = (v: 'allowed' | 'restricted' | 'unavailable'): Verdict =>
  v === 'allowed' ? 'replay' : v === 'restricted' ? 'discard' : 'unavailable';

/**
 * O replay de idempotência devolveria o corpo GUARDADO — resumo, rascunho,
 * próxima ação — sem passar pela checagem de restrição (ADR-048 §6.3, item 3).
 * Estas guardas a refazem no momento da repetição: contato restrito descarta o
 * corpo guardado e a rota executa de novo, agora recusando sem custo.
 *
 * Porta indisponível responde 503 sem apagar nada; conversa que sumiu ou
 * pedido sem alvo descartam o corpo guardado (fail-closed).
 */
@Injectable()
export class ConversationContentReplayGuard implements IdempotentReplayGuard {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly llm: LlmGateway,
  ) {}

  async verdict(request: AuthedRequest): Promise<Verdict> {
    const id = request.params?.id;
    const auth = request.auth;
    const workspaceId = auth?.workspaceId;
    if (typeof id !== 'string' || !auth || !workspaceId) return 'discard';
    let conversa: {
      id: string;
      contactId: string | null;
      senderStatus: string;
      textRestricted?: true;
    };
    try {
      conversa = await this.conversations.get(auth, id);
    } catch {
      return 'discard';
    }
    /**
     * E8 (ADR-061, adendo 9, item 8): o texto da conversa é oculto para quem
     * pede (o `uniforme`). O corpo guardado (resumo, rascunho) é texto dela: é
     * descartado, e a rota responde de novo com a recusa de agora — a MESMA
     * para todo contato, antes da E6.
     */
    if (conversa.textRestricted) return 'discard';
    // remetente a identificar (ADR-052 item 2): o corpo guardado nunca volta
    if (conversa.senderStatus === 'unidentified') return 'discard';
    /**
     * O corpo guardado foi derivado do texto de TODAS as mensagens: o escopo
     * soma ao contato atual os contatos do recebimento (ADR-061, adendo 9,
     * ressalvas), como na geração — depois de uma correção de remetente, o
     * resumo da época do paciente não volta pela mesma chave. A falha ao ler
     * não prova nada: 503, sem apagar o guardado.
     */
    let recebidos: string[];
    try {
      recebidos =
        (await this.conversations.contatosDoRecebimento([conversa.id])).get(conversa.id) ?? [];
    } catch {
      return 'unavailable';
    }
    return fromGateway(
      await this.llm.verdict({
        workspaceId,
        contactIds: semRepetidos([conversa.contactId, ...recebidos]),
      }),
    );
  }
}

/**
 * A repetição da aprovação de um rascunho de resposta (ADR-061, adendo 9, item
 * 8): no `uniforme`, a MESMA resposta de um pedido novo, 403 "Conteúdo
 * restrito", e não o id da mensagem guardado. Fora dele, o corpo guardado,
 * como antes. Nada executa de novo; a falha ao decidir dá 503.
 */
@Injectable()
export class ReplyApprovalReplayGuard implements IdempotentReplayGuard {
  constructor(private readonly conversations: ConversationsService) {}

  async verdict(request: AuthedRequest): Promise<ReplayVerdict> {
    const auth = request.auth;
    if (!auth) return 'unavailable';
    try {
      await this.conversations.exigirLeituraDoTextoDasConversas(auth);
      return 'replay';
    } catch (erro) {
      if (erro instanceof HttpException) return { refuse: erro };
      return 'unavailable';
    }
  }
}

@Injectable()
export class ContactContentReplayGuard implements IdempotentReplayGuard {
  constructor(private readonly llm: LlmGateway) {}

  async verdict(request: AuthedRequest): Promise<Verdict> {
    const id = request.params?.id;
    const workspaceId = request.auth?.workspaceId;
    if (typeof id !== 'string' || !workspaceId) return 'discard';
    return fromGateway(await this.llm.verdict({ workspaceId, contactIds: [id] }));
  }
}

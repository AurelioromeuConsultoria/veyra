import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../common/decorators';
import type { IdempotentReplayGuard } from '../common/idempotency.decorator';
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
    let conversa: { contactId: string | null; senderStatus: string };
    try {
      conversa = await this.conversations.get(auth, id);
    } catch {
      return 'discard';
    }
    // remetente a identificar (ADR-052 item 2): o corpo guardado nunca volta
    if (conversa.senderStatus === 'unidentified') return 'discard';
    return fromGateway(await this.llm.verdict({ workspaceId, contactIds: [conversa.contactId] }));
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

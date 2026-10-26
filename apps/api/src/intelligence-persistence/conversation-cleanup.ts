import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AuditService } from '../audit/audit.service';
import type { Db } from '../prisma/prisma.service';
import { REPLAYS_DE_CAPACIDADE } from './ai.repositories';

/**
 * O que a IA produziu sobre UMA conversa, expirado NA TRANSAÇÃO de quem religa
 * a conversa (ADR-052 item 2): identificar, desfazer e rejeitar o remetente.
 *
 * Aqui a limpeza não é complementar, como na mudança de restrição de um
 * contato: o resumo guarda só o `conversationId`, então uma conversa que passou
 * de X a RAI e depois a Y mostraria a Y o que foi gerado na época de X. Por
 * isso ela comita junto da religação, ou não comita.
 *
 * Mesmas trilhas da limpeza por contato (ator `system`, só contagens e tipos,
 * nunca o conteúdo). Os replays de idempotência das capacidades são apagados no
 * workspace inteiro: a chave não guarda a conversa, e apagar a mais só custa um
 * replay.
 */
@Injectable()
export class LimpezaDeConteudoDaConversa {
  constructor(private readonly audit: AuditService) {}

  async expirarNaTransacao(
    tx: Db,
    workspaceId: string,
    conversationId: string,
  ): Promise<{ results: number; proposals: number; replays: number }> {
    const { count: results } = await tx.aiRun.updateMany({
      where: { conversationId, result: { not: Prisma.DbNull } },
      data: { result: Prisma.DbNull },
    } as never);
    if (results > 0) {
      await this.audit.record(tx, workspaceId, 'ai_run.results_expired', {
        entityType: 'aiContent',
        entityId: workspaceId,
        actor: { type: 'system', id: 'sender-relink' },
        after: { results, scope: 'conversation' },
      });
    }

    const alvos = (await tx.aiProposal.findMany({
      where: { conversationId, status: 'pending' },
      select: { id: true, type: true },
    } as never)) as unknown as { id: string; type: string }[];
    let proposals = 0;
    for (const alvo of alvos) {
      const { count } = await tx.aiProposal.updateMany({
        where: { id: alvo.id, status: 'pending' },
        data: { status: 'expired', reviewedAt: new Date(), pendingReplyMark: null },
      });
      if (count === 0) continue;
      proposals += count;
      await this.audit.record(tx, workspaceId, 'ai_proposal.expired', {
        entityType: 'aiProposal',
        entityId: alvo.id,
        actor: { type: 'system', id: 'sender-relink' },
        before: { type: alvo.type, status: 'pending' },
        after: { type: alvo.type, status: 'expired' },
      });
    }

    const { count: replays } = await tx.idempotencyKey.deleteMany({
      where: REPLAYS_DE_CAPACIDADE,
    } as never);
    return { results, proposals, replays };
  }
}

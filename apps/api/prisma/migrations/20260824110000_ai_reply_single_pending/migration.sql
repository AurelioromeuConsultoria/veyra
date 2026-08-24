-- Um rascunho de resposta PENDENTE por conversa (ADR-044, adendo 1).
--
-- A garantia é do BANCO, não da aplicação: duas gerações simultâneas na mesma
-- conversa deixariam duas propostas aprováveis — duas mensagens reais para a
-- mesma pessoa, cada uma "aprovada por um humano". A marca segue o padrão de
-- `ContactChannelConsent.activeMark`: TRUE enquanto pendente, NULL em qualquer
-- outro estado, porque NULLs são distintos no unique e Prisma não expressa
-- índice parcial. Proposta de tarefa nasce com NULL e não é constrangida.
ALTER TABLE "AiProposal" ADD COLUMN "pendingReplyMark" BOOLEAN;

CREATE UNIQUE INDEX "AiProposal_workspaceId_conversationId_pendingReplyMark_key"
  ON "AiProposal"("workspaceId", "conversationId", "pendingReplyMark");

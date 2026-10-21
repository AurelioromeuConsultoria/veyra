-- ADR-047 adendo 7 §9 (G3.2), decisão do usuário de 2026-10-21: fecha a
-- transição do rascunho EDITADO aprovado antes do deploy. O despacho ainda
-- pendente cuja mensagem a trilha registra como criada de proposta da IA
-- (`message.created_from_ai_proposal`, entityId = messageId) recebe a origem
-- de IA e passa a sair sob a restrição e a guarda. Só pendentes: o histórico
-- terminal não é reescrito (o trigger do banco tocaria o `updatedAt`).
-- Somente dados; idempotente; usa o índice (workspaceId, entityType, entityId).
UPDATE "MessageDispatch" AS d
   SET "fromAiProposal" = true
 WHERE d."fromAiProposal" = false
   AND d."state" IN ('reserved', 'failed_before_send', 'sending')
   AND EXISTS (
         SELECT 1
           FROM "AuditLog" AS a
          WHERE a."workspaceId" = d."workspaceId"
            AND a."entityType" = 'message'
            AND a."entityId" = d."messageId"
            AND a."action" = 'message.created_from_ai_proposal'
       );

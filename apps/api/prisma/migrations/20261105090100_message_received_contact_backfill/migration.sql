-- B1 (ADR-061, adendo 9, item 2): o preenchimento do contato do recebimento
-- das mensagens existentes.
--
-- O que faz, numa transação só (ADR-051), separada do DDL (create-migration,
-- passo 4: backfill em migration própria): grava em "Message"."receivedContactId"
-- o contato ATUAL da conversa de cada mensagem que ainda não o tem. A
-- mensagem de conversa a identificar (sem contato) fica com NULL, como a API
-- grava. A conversa é casada pela FK tripla da mensagem (workspace, canal e
-- id), então o contato é sempre do mesmo workspace. Nada é apagado; nenhuma
-- outra coluna muda.
--
-- O LIMITE declarado: a história anterior das religações não é recomposta. A
-- mensagem de uma conversa que já foi de outro contato recebe o contato de
-- agora. É o mesmo que a regra derivada fazia até aqui; o staging só tem dados
-- fictícios e nenhum piloto rodou (ADR-061, adendo 9, resultado do item 2).
--
-- Locks: o UPDATE pega a trava ROW EXCLUSIVE de "Message" e a de cada linha
-- que muda; leituras seguem, e uma escrita na mesma linha espera o COMMIT. A
-- mensagem é append-only na API, então só a ingestão e o registro novos
-- disputam a tabela, e nunca a mesma linha. A espera pela trava é limitada a
-- 5 s; a execução é proporcional ao número de mensagens (segundos no
-- staging). É estimativa, não limite.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo: nenhuma
-- mensagem fica preenchida, e a API nova trata o NULL como o contato atual.

BEGIN;

SET LOCAL lock_timeout = '5s';

UPDATE "Message" AS m
   SET "receivedContactId" = c."contactId"
  FROM "Conversation" AS c
 WHERE c."workspaceId" = m."workspaceId"
   AND c."channelId" = m."channelId"
   AND c."id" = m."conversationId"
   AND c."contactId" IS NOT NULL
   AND m."receivedContactId" IS NULL;

COMMIT;

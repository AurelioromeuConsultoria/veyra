-- B1 (ADR-061, adendo 9, item 2): o contato do recebimento de cada mensagem.
--
-- O que faz, numa transação só (ADR-051): acrescenta a coluna
-- "Message"."receivedContactId" (uuid, NULL), o contato da conversa no momento
-- em que a mensagem foi gravada. A mídia da mensagem passa a ser protegida
-- (E8) se esse contato OU o atual da conversa for oculto para quem pede.
-- Só acréscimo: sem DEFAULT, sem NOT NULL, sem índice e sem FK (de propósito:
-- DOMAIN_MODEL §9 e o comentário do schema). O código anterior ignora a
-- coluna; a mensagem que ele gravar fica com NULL, que a API nova trata como
-- "vale o contato atual". O preenchimento das mensagens existentes é a
-- migration seguinte (`20261105090100_message_received_contact_backfill`).
--
-- Locks: o ADD COLUMN sem DEFAULT só muda o catálogo, mas pede a trava
-- ACCESS EXCLUSIVE de "Message" pelo instante da troca (sem reescrever a
-- tabela). A espera pela trava é limitada a 5 s; a execução é instantânea.
-- É estimativa, não limite.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "receivedContactId" UUID;

COMMIT;

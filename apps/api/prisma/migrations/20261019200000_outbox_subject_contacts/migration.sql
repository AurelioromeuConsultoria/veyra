-- Fotografia dos contatos de quem é cada evento do outbox NO MOMENTO DA EMISSÃO
-- (ADR-047, adendo 2). A entrega de webhook soma esta lista à resolução feita
-- na hora da entrega: um deal desligado do contato entre emitir e entregar não
-- escapa da restrição de conteúdo.
--
-- SEM FK de propósito: é registro histórico, e excluir o contato depois não
-- pode apagar nem bloquear o evento. O isolamento por workspace é conferido no
-- `OutboxService.enqueue`, na mesma transação da emissão.
--
-- Aditiva e anulável: eventos já existentes ficam NULL ("sem fotografia") e
-- continuam sendo resolvidos só na entrega, como antes.

-- O ALTER só mexe em metadados (anulável, sem default nem índice), mas pede
-- ACCESS EXCLUSIVE na tabela mais escrita do sistema: com uma transação longa
-- aberta, a fila de locks pararia todas as escritas. Melhor falhar em 5s do que
-- travar a aplicação. Se falhar, o Prisma registra a migration como falha
-- (P3009): rode `prisma migrate resolve --rolled-back <esta migration>` e
-- repita o deploy (runbook: docs/DEPLOY_STAGING.md §4).
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "subjectContactIds" UUID[];

RESET lock_timeout;

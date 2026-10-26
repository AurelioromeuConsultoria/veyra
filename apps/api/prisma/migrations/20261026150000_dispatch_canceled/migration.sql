-- F4.1c-1 (ADR-052; decisões do usuário de 2026-10-26): o estado `canceled` do
-- despacho e o pedido de cancelamento do despacho em voo.
--
-- O que faz, numa transação só (ADR-051):
--   1. o valor `canceled` no tipo "DispatchState" — comprovadamente não
--      enviado, com a reserva devolvida, terminal. O valor NÃO é usado nesta
--      transação (o Postgres não permite usar o valor novo antes do COMMIT);
--   2. as colunas "MessageDispatch"."cancelRequestedAt" e "cancelReason",
--      nulas: o pedido de cancelamento e o motivo dele, gravados juntos pelo
--      cancelamento neutro — o motivo é o que o despacho grava ao terminar
--      `canceled`, por qualquer caminho;
--   3. a restrição "MessageDispatch_cancel_check": o pedido e o motivo andam
--      juntos, e o motivo é da lista fechada do serviço (`stop_requested`). O
--      motivo vira `errorCode` e aparece a quem lê a conversa: nem uma escrita
--      `raw` grava texto livre. Motivo novo entra por migration.
-- Os estados já gravados não mudam.
--
-- Locks: o ALTER TYPE pega a trava do tipo. Os ADD COLUMN nuláveis, sem
-- DEFAULT, são só de catálogo, mas pegam ACCESS EXCLUSIVE em
-- "MessageDispatch", que, dentro do BEGIN/COMMIT, vale ATÉ O COMMIT — e cobre
-- a varredura da tabela inteira que a restrição faz (as colunas novas são
-- nulas em toda linha, e ela passa). Nesse tempo, o worker e o envio esperam.
-- No staging e no piloto, a tabela é pequena e a varredura é curta; se ela
-- crescer antes da produção, a restrição vai `NOT VALID` e é validada numa
-- migration seguinte (o VALIDATE pega só SHARE UPDATE EXCLUSIVE). Espera por
-- lock limitada a 5 s por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "DispatchState" ADD VALUE 'canceled';

-- AlterTable
ALTER TABLE "MessageDispatch" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3);

-- o pedido e o motivo juntos, e o motivo da lista fechada. O `IS NOT NULL`
-- explícito é necessário: com o motivo nulo, o `IN` daria NULL, e um CHECK
-- que avalia para NULL passa
ALTER TABLE "MessageDispatch" ADD CONSTRAINT "MessageDispatch_cancel_check" CHECK (
  ("cancelRequestedAt" IS NULL AND "cancelReason" IS NULL)
  OR (
    "cancelRequestedAt" IS NOT NULL
    AND "cancelReason" IS NOT NULL
    AND "cancelReason" IN ('stop_requested')
  )
);

COMMIT;

-- F4.2, a parte do Core (ADR-048 adendo 9; decisões do usuário de 2026-10-28):
-- a origem de vertical no envio iniciado pelo negócio.
--
-- O que faz, numa transação só (ADR-051):
--   1. confere que nenhuma aprovação tem origem de vertical: nenhuma porta do
--      E7 foi composta em ambiente nenhum, e a regra nova só vale daqui em
--      diante. Se houver, a migration falha, em vez de marcar à mão;
--   2. a coluna "OutboundApproval"."originMark", nula: `true` na origem de
--      vertical, `null` na do Core;
--   3. o único ("workspaceId", "originRef", "originMark"): uma aprovação por
--      pedido do vertical — uma prévia nova do mesmo pedido não gera segunda
--      mensagem. A origem do Core continua livre (a marca nula não colide);
--   4. a restrição "OutboundApproval_originMark_check": a marca é a da origem
--      — nula na do Core (`conversation:`), `true` em toda outra;
--   5. a restrição "MessageDispatch_cancel_check" com o motivo novo
--      `origin_invalidated` (o vertical cancela quando a origem deixa de
--      valer), além do `stop_requested`.
-- Os estados já gravados não mudam.
--
-- Locks: as duas tabelas, ACCESS EXCLUSIVE, logo no começo ("OutboundApproval"
-- e depois "MessageDispatch", a ordem da guarda do despacho), até o COMMIT. O
-- ADD COLUMN nulável, sem DEFAULT, é só de catálogo; o índice e a restrição
-- varrem a tabela (pequena: ela nasceu na F4.1c-3). Trocar a restrição do
-- despacho pega ACCESS EXCLUSIVE em "MessageDispatch" e a valida pela tabela
-- inteira: nesse tempo, o worker e o envio esperam. Espera por lock limitada a
-- 5 s por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- as duas tabelas de uma vez, logo no começo. A ordem é a da GUARDA do
-- despacho, que lê a aprovação e escreve o despacho depois da chamada à Meta:
-- o impasse com ela sacrificaria um envio que já saiu. Com a aprovação (que
-- escreve o despacho antes da aprovação), o impasse possível desfaz uma
-- aprovação que ainda não enviou nada. O runbook roda as migrations com os
-- jobs desligados (DEPLOY_STAGING §4), e nenhum dos dois roda junto
LOCK TABLE "OutboundApproval", "MessageDispatch" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OutboundApproval" WHERE "originRef" NOT LIKE 'conversation:%') THEN
    RAISE EXCEPTION 'há aprovação de origem de vertical antes da regra da F4.2: confira antes de migrar';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "OutboundApproval" ADD COLUMN     "originMark" BOOLEAN;

-- CreateIndex
CREATE UNIQUE INDEX "OutboundApproval_workspaceId_originRef_originMark_key" ON "OutboundApproval"("workspaceId", "originRef", "originMark");

-- a marca é a da origem: nula na do Core, `true` na de vertical. `IS TRUE`, e
-- não `= TRUE`: com a marca nula, `= TRUE` daria NULL, e o CHECK aceita NULL
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_originMark_check" CHECK (
  ("originRef" LIKE 'conversation:%' AND "originMark" IS NULL)
  OR ("originRef" NOT LIKE 'conversation:%' AND "originMark" IS TRUE)
);

-- o motivo novo do cancelamento neutro
ALTER TABLE "MessageDispatch" DROP CONSTRAINT "MessageDispatch_cancel_check";
ALTER TABLE "MessageDispatch" ADD CONSTRAINT "MessageDispatch_cancel_check" CHECK (
  ("cancelRequestedAt" IS NULL AND "cancelReason" IS NULL)
  OR (
    "cancelRequestedAt" IS NOT NULL
    AND "cancelReason" IS NOT NULL
    AND "cancelReason" IN ('stop_requested', 'origin_invalidated')
  )
);

COMMIT;

-- F4.1c-3 (ADR-052 itens 6 a 8; decisões do usuário de 2026-10-26 e
-- 2026-10-27): o envio iniciado pelo negócio, aprovado sobre a prévia.
--
-- O que faz, numa transação só (ADR-051):
--   1. o valor `business_outbound` no tipo "ContentUseKind" — o uso externo
--      próprio do envio do negócio, sob a guarda. O valor NÃO é usado nesta
--      transação (o Postgres não permite usar o valor novo antes do COMMIT);
--   2. o único ("workspaceId", "id") em "Consent": o alvo da FK composta da
--      aprovação;
--   3. a tabela "OutboundApproval" (o pedido aprovado, 1:1 com a mensagem),
--      com os índices — entre eles o único do hash: uma aprovação por prévia —
--      e as FKs COMPOSTAS (mensagem, contato, canal, versão, revisão,
--      finalidade, consentimento, membership). A versão, a revisão, a
--      finalidade e quem aprovou ficam SEM AÇÃO: a aprovação nunca some sem a
--      mensagem dela;
--   4. as restrições do hash (HMAC-SHA256 em hex), do número ("+dígitos"), do
--      id do número na Meta (só dígitos) e da origem (prefixo:uuid);
--   5. o gatilho da imutabilidade: a aprovação não muda depois de gravada (a
--      exclusão em cascata, pelo contato ou pela mensagem, continua).
-- A tabela nasce vazia: não há preenchimento. Os estados já gravados não mudam.
--
-- Locks: o ALTER TYPE pega a trava do tipo. O índice único em "Consent" pega
-- SHARE em "Consent" pelo tempo da construção (a tabela é pequena no staging e
-- no piloto), e nesse tempo conceder e revogar esperam. As FKs pegam SHARE ROW
-- EXCLUSIVE nas tabelas referenciadas pelo tempo da validação (a tabela nova
-- está vazia, e ela é imediata), até o COMMIT. Espera por lock limitada a 5 s
-- por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterEnum
ALTER TYPE "ContentUseKind" ADD VALUE 'business_outbound';

-- CreateTable
CREATE TABLE "OutboundApproval" (
    "messageId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "channelId" UUID NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "templateVersionId" UUID NOT NULL,
    "templateReviewId" UUID NOT NULL,
    "purposeId" UUID NOT NULL,
    "consentId" UUID NOT NULL,
    "originRef" TEXT NOT NULL,
    "validityKeys" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "approvedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "OutboundApproval_pkey" PRIMARY KEY ("messageId")
);

-- CreateIndex
CREATE INDEX "OutboundApproval_workspaceId_contactId_idx" ON "OutboundApproval"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "OutboundApproval_workspaceId_originRef_idx" ON "OutboundApproval"("workspaceId", "originRef");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundApproval_workspaceId_messageId_key" ON "OutboundApproval"("workspaceId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundApproval_workspaceId_approvalHash_key" ON "OutboundApproval"("workspaceId", "approvalHash");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_workspaceId_id_key" ON "Consent"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_templateVersionId_fkey" FOREIGN KEY ("workspaceId", "templateVersionId") REFERENCES "MessageTemplateVersion"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_templateReviewId_fkey" FOREIGN KEY ("workspaceId", "templateReviewId") REFERENCES "TemplateReview"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_purposeId_fkey" FOREIGN KEY ("workspaceId", "purposeId") REFERENCES "ConsentPurpose"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_consentId_fkey" FOREIGN KEY ("workspaceId", "consentId") REFERENCES "Consent"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_workspaceId_approvedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "approvedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- o HMAC-SHA256 da forma canônica, em hex
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_approvalHash_check"
  CHECK ("approvalHash" ~ '^[0-9a-f]{64}$');

-- o número exato, como o endereço da conversa
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_number_check"
  CHECK ("number" ~ '^\+[1-9][0-9]{7,14}$');

-- o id do número na Meta é só dígitos, como os ids da versão de template
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_phoneNumberId_check"
  CHECK ("phoneNumberId" ~ '^[0-9]{1,30}$');

-- a origem: `conversation:<uuid>` ou o prefixo de um vertical
ALTER TABLE "OutboundApproval" ADD CONSTRAINT "OutboundApproval_originRef_check"
  CHECK ("originRef" ~ '^[a-z][a-z0-9_.-]{0,40}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- A aprovação é imutável: o que a pessoa aprovou não muda depois. O client
-- protegido já recusa a escrita (append-only); o gatilho vale também para o
-- `raw`. A exclusão em cascata (contato, mensagem, workspace) continua.
CREATE FUNCTION outbound_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OutboundApproval %: a aprovação é imutável', OLD."messageId"
    USING ERRCODE = 'check_violation';
END
$$;

CREATE TRIGGER outbound_approval_guard BEFORE UPDATE ON "OutboundApproval"
  FOR EACH ROW EXECUTE FUNCTION outbound_approval_guard();

COMMIT;

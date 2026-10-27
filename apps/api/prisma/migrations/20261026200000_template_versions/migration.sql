-- F4.1c-2 (ADR-052 item 4; decisões do usuário de 2026-10-26): os templates do
-- WhatsApp versionados, revisados e relidos. NÃO abre envio: nada no worker nem
-- no compositor lê estas tabelas nesta subentrega.
--
-- O que faz, numa transação só (ADR-051):
--   1. os tipos "TemplateCategory", "TemplateParameterFormat" e
--      "TemplateVersionStatus";
--   2. a tabela "MessageTemplateVersion" (a versão, com a forma canônica, os
--      vínculos e o hash) e a "TemplateReview" (a revisão por versão e
--      finalidade), com os únicos, os índices e as FKs COMPOSTAS (canal,
--      versão, finalidade, membership);
--   3. as restrições do hash (SHA-256 em hex), da versão (>= 1) e dos ids da
--      Meta (a WABA e o template, só dígitos);
--   4. os gatilhos da imutabilidade: a versão só muda de `active` para
--      `divergent`, uma vez; a revisão é imutável e só nasce para uma versão
--      ATIVA com o MESMO hash (a linha da versão fica presa pela revisão, e a
--      divergência concorrente espera).
-- As tabelas nascem vazias: não há preenchimento. O `MessageTemplate` da 9.1
-- não muda.
--
-- Locks: as tabelas e os tipos são novos; as FKs pegam SHARE ROW EXCLUSIVE em
-- "Workspace", "Channel", "ConsentPurpose" e "Membership" pelo tempo da
-- validação (as tabelas novas estão vazias, e ela é imediata), até o COMMIT.
-- Espera por lock limitada a 5 s por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('utility', 'marketing');

-- CreateEnum
CREATE TYPE "TemplateParameterFormat" AS ENUM ('positional', 'named');

-- CreateEnum
CREATE TYPE "TemplateVersionStatus" AS ENUM ('active', 'divergent');

-- CreateTable
CREATE TABLE "MessageTemplateVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "businessAccountId" TEXT NOT NULL,
    "metaTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "parameterFormat" "TemplateParameterFormat" NOT NULL,
    "components" JSONB NOT NULL,
    "bindings" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "MessageTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateReview" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "templateVersionId" UUID NOT NULL,
    "purposeId" UUID NOT NULL,
    "contentHash" TEXT NOT NULL,
    "reviewedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "TemplateReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplateVersion_workspaceId_channelId_name_language_idx" ON "MessageTemplateVersion"("workspaceId", "channelId", "name", "language");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplateVersion_workspaceId_id_key" ON "MessageTemplateVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplateVersion_workspaceId_channelId_name_language__key" ON "MessageTemplateVersion"("workspaceId", "channelId", "name", "language", "version");

-- CreateIndex
CREATE INDEX "TemplateReview_workspaceId_purposeId_idx" ON "TemplateReview"("workspaceId", "purposeId");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateReview_workspaceId_id_key" ON "TemplateReview"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateReview_workspaceId_templateVersionId_purposeId_key" ON "TemplateReview"("workspaceId", "templateVersionId", "purposeId");

-- AddForeignKey
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateReview" ADD CONSTRAINT "TemplateReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateReview" ADD CONSTRAINT "TemplateReview_workspaceId_templateVersionId_fkey" FOREIGN KEY ("workspaceId", "templateVersionId") REFERENCES "MessageTemplateVersion"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateReview" ADD CONSTRAINT "TemplateReview_workspaceId_purposeId_fkey" FOREIGN KEY ("workspaceId", "purposeId") REFERENCES "ConsentPurpose"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TemplateReview" ADD CONSTRAINT "TemplateReview_workspaceId_reviewedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "reviewedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── as restrições do conteúdo ────────────────────────────────────────────────
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_contentHash_check"
  CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_version_check"
  CHECK ("version" >= 1);
ALTER TABLE "MessageTemplateVersion" ADD CONSTRAINT "MessageTemplateVersion_metaIds_check"
  CHECK ("businessAccountId" ~ '^[0-9]{1,30}$' AND "metaTemplateId" ~ '^[0-9]{1,30}$');
ALTER TABLE "TemplateReview" ADD CONSTRAINT "TemplateReview_contentHash_check"
  CHECK ("contentHash" ~ '^[0-9a-f]{64}$');

-- ── a imutabilidade da versão: nasce ativa; só vai a divergente, uma vez ─────
CREATE FUNCTION template_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'MessageTemplateVersion %: nasce ativa', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'divergent' OR NEW."status" IS DISTINCT FROM 'divergent' THEN
    RAISE EXCEPTION 'MessageTemplateVersion %: só vai de ativa a divergente, uma vez', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."workspaceId", NEW."channelId", NEW."businessAccountId",
      NEW."metaTemplateId", NEW."name", NEW."language", NEW."version", NEW."category",
      NEW."parameterFormat", NEW."components", NEW."bindings", NEW."contentHash", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."workspaceId", OLD."channelId", OLD."businessAccountId",
      OLD."metaTemplateId", OLD."name", OLD."language", OLD."version", OLD."category",
      OLD."parameterFormat", OLD."components", OLD."bindings", OLD."contentHash", OLD."createdAt") THEN
    RAISE EXCEPTION 'MessageTemplateVersion %: o conteúdo é imutável', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER template_version_guard BEFORE INSERT OR UPDATE ON "MessageTemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION template_version_guard();

-- ── a revisão: imutável, e só de uma versão ATIVA com o MESMO hash ───────────
-- A linha da versão fica presa (FOR SHARE) até o commit da revisão: a
-- divergência concorrente espera, e a revisão nunca nasce para um conteúdo que
-- a Meta já trocou.
CREATE FUNCTION template_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_hash text;
  v_status "TemplateVersionStatus";
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'TemplateReview %: a revisão é imutável', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."contentHash", v."status" INTO v_hash, v_status
    FROM "MessageTemplateVersion" v
   WHERE v."workspaceId" = NEW."workspaceId" AND v."id" = NEW."templateVersionId"
     FOR SHARE;
  IF v_status IS DISTINCT FROM 'active' OR v_hash IS DISTINCT FROM NEW."contentHash" THEN
    RAISE EXCEPTION 'TemplateReview: a versão precisa estar ativa, com o mesmo conteúdo'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER template_review_guard BEFORE INSERT OR UPDATE ON "TemplateReview"
  FOR EACH ROW EXECUTE FUNCTION template_review_guard();

COMMIT;

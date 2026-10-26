-- F4.1b (ADR-052 item 5; decisões do usuário de 2026-10-26): finalidades,
-- consentimentos, o pedido de parar e as chaves de permissão.
--
-- O que faz, numa transação só (ADR-051):
--   1. os tipos "ConsentOrigin", "ConsentPurposeCategory" e "ConsentRevocationReason";
--   2. as tabelas "ConsentPurpose" (a finalidade versionada), "Consent" (o
--      consentimento), "StopBlock" (o pedido de parar, por workspace e número,
--      sem contato nem nome), "ConsentReceiptCounter" (os recibos) e
--      "PermissionBackfill" (o livro do preenchimento), todas novas e vazias;
--   3. a imutabilidade: os CHECKs de coerência da marca ativa e do formato do
--      número, e os gatilhos — o registro nasce ativo e sem desfecho, só o
--      desfecho se preenche, uma vez, e os instantes são do banco, gravados
--      pelo gatilho depois das travas;
--   4. as chaves novas no catálogo ("consents:read", "consents:manage",
--      "consents:unblock", "templates:review");
--   5. o PREENCHIMENTO das chaves nos papéis owner, admin e member que já
--      existem, pela matriz explícita e com os pré-requisitos; só acréscimo,
--      com o livro e a auditoria. Fora: o guest, os papéis de vertical e os
--      personalizados.
--
-- Locks: as tabelas novas não têm leitor. As FKs das tabelas novas pegam SHARE
-- ROW EXCLUSIVE em "Workspace", "Contact", "Channel", "Membership", "Role" e
-- "Permission" até o COMMIT: as ESCRITAS nessas tabelas esperam a migration
-- inteira (as leituras seguem). O preenchimento escreve em "RolePermission",
-- "PermissionBackfill" e "AuditLog" (linha a linha) e lê "Role" e
-- "RolePermission". Espera por lock limitada a 5 s por instrução — no pior
-- caso, as esperas somam; execução de poucos segundos no volume atual (dados
-- fictícios).
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ConsentOrigin" AS ENUM ('in_person', 'phone', 'paper_form');

-- CreateEnum
CREATE TYPE "ConsentPurposeCategory" AS ENUM ('utility', 'marketing');

-- CreateEnum
CREATE TYPE "ConsentRevocationReason" AS ENUM ('manual', 'number_removed', 'stop_requested');

-- CreateTable
CREATE TABLE "ConsentPurpose" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "category" "ConsentPurposeCategory" NOT NULL,
    "fields" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ConsentPurpose_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "purposeId" UUID NOT NULL,
    "origin" "ConsentOrigin" NOT NULL,
    "receipt" TEXT NOT NULL,
    "purposeDescription" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),
    "grantedByMembershipId" UUID NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByMembershipId" UUID,
    "revocationReason" "ConsentRevocationReason",
    "revocationOrigin" "ConsentOrigin",
    "activeMark" BOOLEAN DEFAULT true,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StopBlock" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "origin" "ConsentOrigin" NOT NULL,
    "receipt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),
    "createdByMembershipId" UUID NOT NULL,
    "liftedAt" TIMESTAMP(3),
    "liftedByMembershipId" UUID,
    "liftOrigin" "ConsentOrigin",
    "liftReceipt" TEXT,
    "activeMark" BOOLEAN DEFAULT true,

    CONSTRAINT "StopBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentReceiptCounter" (
    "workspaceId" UUID NOT NULL,
    "next" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "ConsentReceiptCounter_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "PermissionBackfill" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "permissionKey" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "PermissionBackfill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsentPurpose_workspaceId_id_key" ON "ConsentPurpose"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentPurpose_workspaceId_key_version_key" ON "ConsentPurpose"("workspaceId", "key", "version");

-- CreateIndex
CREATE INDEX "Consent_workspaceId_number_idx" ON "Consent"("workspaceId", "number");

-- CreateIndex
CREATE INDEX "Consent_workspaceId_channelId_idx" ON "Consent"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "Consent_workspaceId_purposeId_idx" ON "Consent"("workspaceId", "purposeId");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_workspaceId_receipt_key" ON "Consent"("workspaceId", "receipt");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_workspaceId_contactId_channelId_number_purposeId_ac_key" ON "Consent"("workspaceId", "contactId", "channelId", "number", "purposeId", "activeMark");

-- CreateIndex
CREATE UNIQUE INDEX "StopBlock_workspaceId_id_key" ON "StopBlock"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StopBlock_workspaceId_receipt_key" ON "StopBlock"("workspaceId", "receipt");

-- CreateIndex
CREATE UNIQUE INDEX "StopBlock_workspaceId_liftReceipt_key" ON "StopBlock"("workspaceId", "liftReceipt");

-- CreateIndex
CREATE UNIQUE INDEX "StopBlock_workspaceId_number_activeMark_key" ON "StopBlock"("workspaceId", "number", "activeMark");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionBackfill_workspaceId_roleId_permissionKey_key" ON "PermissionBackfill"("workspaceId", "roleId", "permissionKey");

-- AddForeignKey
ALTER TABLE "ConsentPurpose" ADD CONSTRAINT "ConsentPurpose_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_purposeId_fkey" FOREIGN KEY ("workspaceId", "purposeId") REFERENCES "ConsentPurpose"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_grantedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "grantedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_workspaceId_revokedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "revokedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StopBlock" ADD CONSTRAINT "StopBlock_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StopBlock" ADD CONSTRAINT "StopBlock_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "StopBlock" ADD CONSTRAINT "StopBlock_workspaceId_liftedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "liftedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ConsentReceiptCounter" ADD CONSTRAINT "ConsentReceiptCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionBackfill" ADD CONSTRAINT "PermissionBackfill_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionBackfill" ADD CONSTRAINT "PermissionBackfill_workspaceId_roleId_fkey" FOREIGN KEY ("workspaceId", "roleId") REFERENCES "Role"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionBackfill" ADD CONSTRAINT "PermissionBackfill_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "Permission"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── A coerência da marca ativa e o formato do número (ADR-052 item 5) ──────
-- O único "um ativo por tupla" só vale se a marca acompanha o desfecho: ativo
-- é TRUE e sem desfecho; desfeito é NULL e com o desfecho completo. Sem isto,
-- uma linha com a marca FALSE conviveria com a ativa (o mesmo motivo do
-- `ContactChannelConsent_activeMark_coerente`).
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_outcome_check" CHECK (
  ("activeMark" = true AND "revokedAt" IS NULL AND "revokedByMembershipId" IS NULL
    AND "revocationReason" IS NULL AND "revocationOrigin" IS NULL)
  OR ("activeMark" IS NULL AND "revokedAt" IS NOT NULL AND "revocationReason" IS NOT NULL)
);
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_number_check" CHECK ("number" ~ '^\+[0-9]{8,20}$');
ALTER TABLE "StopBlock" ADD CONSTRAINT "StopBlock_outcome_check" CHECK (
  ("activeMark" = true AND "liftedAt" IS NULL AND "liftedByMembershipId" IS NULL
    AND "liftOrigin" IS NULL AND "liftReceipt" IS NULL)
  OR ("activeMark" IS NULL AND "liftedAt" IS NOT NULL AND "liftedByMembershipId" IS NOT NULL
    AND "liftOrigin" IS NOT NULL AND "liftReceipt" IS NOT NULL)
);
ALTER TABLE "StopBlock" ADD CONSTRAINT "StopBlock_number_check" CHECK ("number" ~ '^\+[0-9]{8,20}$');

-- ── A imutabilidade: nasce ativo, e só o desfecho se preenche, uma vez ───────
-- Os instantes são do relógio do banco (ADR-049) e de DEPOIS das travas
-- (`clock_timestamp()`, como o `recordedAt` do atendimento): o gatilho os grava
-- na criação e no desfecho, e o que vier na escrita é descartado. Com o início
-- da transação, uma revogação que esperou a trava podia ficar antes da concessão.
CREATE FUNCTION consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activeMark" IS DISTINCT FROM true OR NEW."revokedAt" IS NOT NULL
       OR NEW."revokedByMembershipId" IS NOT NULL OR NEW."revocationReason" IS NOT NULL
       OR NEW."revocationOrigin" IS NOT NULL THEN
      RAISE EXCEPTION 'Consent %: nasce ativo, sem revogação', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."grantedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Consent %: a revogação é registrada uma vez', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revocationReason" IS NULL OR NEW."activeMark" IS NOT NULL THEN
    RAISE EXCEPTION 'Consent %: só a revogação completa se preenche', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."workspaceId", NEW."contactId", NEW."channelId", NEW."number",
      NEW."purposeId", NEW."origin", NEW."receipt", NEW."purposeDescription",
      NEW."grantedAt", NEW."grantedByMembershipId")
     IS DISTINCT FROM
     (OLD."id", OLD."workspaceId", OLD."contactId", OLD."channelId", OLD."number",
      OLD."purposeId", OLD."origin", OLD."receipt", OLD."purposeDescription",
      OLD."grantedAt", OLD."grantedByMembershipId") THEN
    RAISE EXCEPTION 'Consent %: a concessão é imutável', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."revokedAt" := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER consent_guard BEFORE INSERT OR UPDATE ON "Consent"
  FOR EACH ROW EXECUTE FUNCTION consent_guard();

CREATE FUNCTION stop_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activeMark" IS DISTINCT FROM true OR NEW."liftedAt" IS NOT NULL
       OR NEW."liftedByMembershipId" IS NOT NULL OR NEW."liftOrigin" IS NOT NULL
       OR NEW."liftReceipt" IS NOT NULL THEN
      RAISE EXCEPTION 'StopBlock %: nasce ativo, sem desbloqueio', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."liftedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'StopBlock %: o desbloqueio é registrado uma vez', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."liftedByMembershipId" IS NULL OR NEW."liftOrigin" IS NULL OR NEW."liftReceipt" IS NULL
     OR NEW."activeMark" IS NOT NULL THEN
    RAISE EXCEPTION 'StopBlock %: só o desbloqueio completo se preenche', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."workspaceId", NEW."number", NEW."origin", NEW."receipt", NEW."createdAt",
      NEW."createdByMembershipId")
     IS DISTINCT FROM
     (OLD."id", OLD."workspaceId", OLD."number", OLD."origin", OLD."receipt", OLD."createdAt",
      OLD."createdByMembershipId") THEN
    RAISE EXCEPTION 'StopBlock %: o pedido é imutável', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."liftedAt" := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER stop_block_guard BEFORE INSERT OR UPDATE ON "StopBlock"
  FOR EACH ROW EXECUTE FUNCTION stop_block_guard();

-- ── As chaves novas no catálogo ──────────────────────────────────────────────
INSERT INTO "Permission" ("key", "description")
VALUES
  ('consents:read', 'Ver consentimentos e pedidos de parar de contatos e conversas'),
  ('consents:manage', 'Registrar e revogar consentimentos e registrar pedidos de parar'),
  ('consents:unblock', 'Retirar um pedido de parar, com a nova solicitação da pessoa'),
  ('templates:review', 'Revisar versões de template antes do uso (F4.1c)')
ON CONFLICT ("key") DO NOTHING;

-- PREENCHIMENTO:INICIO (o teste de integração executa exatamente este trecho)
-- A matriz explícita dos três papéis do Core, pelo systemKey EXATO (nunca
-- "systemKey preenchido": um vertical tem papéis de sistema próprios), e cada
-- chave só onde o papel já tem o pré-requisito. Só acréscimo; o livro registra
-- o que foi aplicado, e a reaplicação pula — uma revogação posterior não é
-- desfeita. O livro não prova que a concessão inicial respeita toda intenção
-- anterior: isso é o que a matriz e os pré-requisitos limitam.
WITH matriz ("systemKey", "permissionKey", "preRequisito") AS (
  VALUES
    ('owner', 'consents:read', 'contacts:read'),
    ('owner', 'consents:manage', 'contacts:write'),
    ('owner', 'consents:unblock', 'contacts:write'),
    ('owner', 'templates:review', 'contacts:write'),
    ('admin', 'consents:read', 'contacts:read'),
    ('admin', 'consents:manage', 'contacts:write'),
    ('admin', 'consents:unblock', 'contacts:write'),
    ('admin', 'templates:review', 'contacts:write'),
    ('member', 'consents:read', 'contacts:read'),
    ('member', 'consents:manage', 'contacts:write')
),
alvo AS (
  SELECT r."workspaceId", r."id" AS "roleId", m."permissionKey"
    FROM "Role" r
    JOIN matriz m ON m."systemKey" = r."systemKey"
   WHERE r."isSystem" = true
     AND EXISTS (
       SELECT 1 FROM "RolePermission" rp
        WHERE rp."workspaceId" = r."workspaceId"
          AND rp."roleId" = r."id"
          AND rp."permissionKey" = m."preRequisito"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "PermissionBackfill" b
        WHERE b."workspaceId" = r."workspaceId"
          AND b."roleId" = r."id"
          AND b."permissionKey" = m."permissionKey"
     )
),
concedidas AS (
  INSERT INTO "RolePermission" ("id", "workspaceId", "roleId", "permissionKey")
  SELECT gen_random_uuid(), a."workspaceId", a."roleId", a."permissionKey"
    FROM alvo a
   WHERE NOT EXISTS (
     SELECT 1 FROM "RolePermission" rp
      WHERE rp."workspaceId" = a."workspaceId"
        AND rp."roleId" = a."roleId"
        AND rp."permissionKey" = a."permissionKey"
   )
  RETURNING "workspaceId", "roleId", "permissionKey"
),
-- o livro registra todo alvo aplicado, inclusive o papel que já tinha a chave:
-- um CTE que escreve roda inteiro, mesmo sem ninguém ler o resultado
livro AS (
  INSERT INTO "PermissionBackfill" ("id", "workspaceId", "roleId", "permissionKey")
  SELECT gen_random_uuid(), a."workspaceId", a."roleId", a."permissionKey"
    FROM alvo a
  RETURNING "id"
)
INSERT INTO "AuditLog" ("id", "workspaceId", "actorType", "actorId", "action", "entityType", "entityId", "after")
SELECT gen_random_uuid(), c."workspaceId", 'system', 'migration:20261026120000_consents_and_stop_block',
       'role.permission_backfilled', 'role', c."roleId",
       jsonb_build_object('permissionKey', c."permissionKey")
  FROM concedidas c;
-- PREENCHIMENTO:FIM

COMMIT;

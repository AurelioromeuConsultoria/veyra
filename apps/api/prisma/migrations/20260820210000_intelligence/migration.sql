-- CreateEnum
CREATE TYPE "AiRunStatus" AS ENUM ('ok', 'refused', 'error');

-- CreateEnum
CREATE TYPE "AiRunAction" AS ENUM ('none', 'proposed', 'executed');

-- CreateEnum
CREATE TYPE "AiProposalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "AiProposalType" AS ENUM ('create_task');

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "changelog" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "capability" TEXT NOT NULL,
    "promptVersionId" UUID,
    "model" TEXT NOT NULL,
    "contextSummary" TEXT NOT NULL,
    "status" "AiRunStatus" NOT NULL,
    "reasonCode" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "action" "AiRunAction" NOT NULL DEFAULT 'none',
    "triggeredByMembershipId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProposal" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "type" "AiProposalType" NOT NULL,
    "payload" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "AiProposalStatus" NOT NULL DEFAULT 'pending',
    "contactId" UUID,
    "dealId" UUID,
    "conversationId" UUID,
    "reviewedByMembershipId" UUID,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConsent" (
    "workspaceId" UUID NOT NULL,
    "conversationContent" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMembershipId" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConsent_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_capability_version_key" ON "PromptVersion"("capability", "version");

-- CreateIndex
CREATE INDEX "AiRun_workspaceId_createdAt_idx" ON "AiRun"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiRun_workspaceId_capability_createdAt_idx" ON "AiRun"("workspaceId", "capability", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AiRun_workspaceId_id_key" ON "AiRun"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "AiProposal_workspaceId_status_createdAt_idx" ON "AiProposal"("workspaceId", "status", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AiProposal_workspaceId_id_key" ON "AiProposal"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_workspaceId_triggeredByMembershipId_fkey" FOREIGN KEY ("workspaceId", "triggeredByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "AiRun"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_dealId_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProposal" ADD CONSTRAINT "AiProposal_workspaceId_reviewedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "reviewedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "AiConsent" ADD CONSTRAINT "AiConsent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Backfill das permissões de IA ────────────────────────────────────────────
-- O guard é default-deny: sem estas linhas, workspaces JÁ EXISTENTES ficariam
-- sem acesso às capacidades de IA mesmo com papéis de sistema corretos. As
-- chaves do catálogo entram primeiro (idempotente), depois as concessões,
-- espelhando SYSTEM_ROLE_TEMPLATES: Owner e Admin recebem as duas; Member
-- recebe apenas intelligence:use; Guest, nenhuma. Papéis CUSTOMIZADOS não são
-- tocados — quem os criou decide o que eles podem.
INSERT INTO "Permission" ("key", "description")
VALUES
  ('intelligence:use', 'Usar capacidades de IA (leitura, sinais, insights)'),
  ('intelligence:approve', 'Aprovar ações externas propostas pela IA')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "RolePermission" ("id", "workspaceId", "roleId", "permissionKey")
SELECT gen_random_uuid(), r."workspaceId", r."id", p."key"
  FROM "Role" r
  CROSS JOIN (VALUES ('intelligence:use'), ('intelligence:approve')) AS p("key")
 WHERE r."isSystem" = true
   AND (
     r."systemKey" IN ('owner', 'admin')
     OR (r."systemKey" = 'member' AND p."key" = 'intelligence:use')
   )
   AND NOT EXISTS (
     SELECT 1 FROM "RolePermission" rp
      WHERE rp."workspaceId" = r."workspaceId"
        AND rp."roleId" = r."id"
        AND rp."permissionKey" = p."key"
   );

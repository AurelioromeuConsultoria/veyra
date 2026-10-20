-- Usos externos de conteúdo de contato (ADR-047, adendos 6 e 7): o registro
-- durável comitado ANTES da chamada externa. Aditiva: tabela e tipos novos,
-- nenhum dado existente muda.

-- CreateEnum
CREATE TYPE "ContentUseKind" AS ENUM ('ai_generation', 'ai_message_dispatch', 'webhook_delivery');

-- CreateEnum
CREATE TYPE "ContentUseStatus" AS ENUM ('authorized', 'concluded', 'aborted', 'in_doubt');

-- CreateEnum
CREATE TYPE "ContentUseDetector" AS ENUM ('commit', 'change', 'workspace_change', 'reconciliation', 'missing_record');

-- CreateTable
CREATE TABLE "ContentUse" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "ContentUseKind" NOT NULL,
    "status" "ContentUseStatus" NOT NULL,
    "detectedBy" "ContentUseDetector",
    "contactIds" UUID[],
    "entityKeys" TEXT[],
    "origin" JSONB NOT NULL,
    "reservationIds" UUID[],
    "runMetadata" JSONB,
    "instanceId" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT transaction_timestamp(),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "lateAttemptAt" TIMESTAMP(3),

    CONSTRAINT "ContentUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentUse_workspaceId_status_idx" ON "ContentUse"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ContentUse_status_deadlineAt_idx" ON "ContentUse"("status", "deadlineAt");

-- AddForeignKey
ALTER TABLE "ContentUse" ADD CONSTRAINT "ContentUse_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

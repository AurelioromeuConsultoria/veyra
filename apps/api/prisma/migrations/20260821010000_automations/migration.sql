-- CreateEnum
CREATE TYPE "AutomationAction" AS ENUM ('create_task');

-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('executed', 'skipped', 'failed');

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "chainId" UUID,
ADD COLUMN     "depth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originAutomationId" UUID;

-- CreateTable
CREATE TABLE "Automation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "action" "AutomationAction" NOT NULL,
    "actionConfig" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationExecution" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_workspaceId_trigger_enabled_idx" ON "Automation"("workspaceId", "trigger", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_workspaceId_id_key" ON "Automation"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Automation_workspaceId_name_key" ON "Automation"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "AutomationExecution_workspaceId_createdAt_idx" ON "AutomationExecution"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AutomationExecution_workspaceId_automationId_outboxEventId_key" ON "AutomationExecution"("workspaceId", "automationId", "outboxEventId");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_workspaceId_originAutomationId_fkey" FOREIGN KEY ("workspaceId", "originAutomationId") REFERENCES "Automation"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_workspaceId_automationId_fkey" FOREIGN KEY ("workspaceId", "automationId") REFERENCES "Automation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationExecution" ADD CONSTRAINT "AutomationExecution_workspaceId_outboxEventId_fkey" FOREIGN KEY ("workspaceId", "outboxEventId") REFERENCES "OutboxEvent"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;



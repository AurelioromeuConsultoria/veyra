-- CreateEnum
CREATE TYPE "StageType" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'done');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('low', 'normal', 'high');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('contact_created', 'deal_created', 'deal_stage_changed', 'deal_won', 'deal_lost', 'task_created', 'task_completed', 'note_added', 'note_deleted');

-- CreateEnum
CREATE TYPE "ActivityActor" AS ENUM ('user', 'system');

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "defaultMark" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "probability" INTEGER,
    "type" "StageType" NOT NULL DEFAULT 'open',

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "pipelineId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "contactId" UUID,
    "companyId" UUID,
    "ownerMembershipId" UUID,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "expectedCloseDate" TIMESTAMP(3),
    "status" "DealStatus" NOT NULL DEFAULT 'open',
    "position" INTEGER NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "assigneeMembershipId" UUID,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "priority" "TaskPriority" NOT NULL DEFAULT 'normal',
    "contactId" UUID,
    "dealId" UUID,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "authorMembershipId" UUID NOT NULL,
    "contactId" UUID,
    "companyId" UUID,
    "dealId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "ActivityType" NOT NULL,
    "actorType" "ActivityActor" NOT NULL DEFAULT 'user',
    "actorMembershipId" UUID,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contactId" UUID,
    "companyId" UUID,
    "dealId" UUID,
    "taskId" UUID,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_workspaceId_id_key" ON "Pipeline"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_workspaceId_name_key" ON "Pipeline"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_workspaceId_defaultMark_key" ON "Pipeline"("workspaceId", "defaultMark");

-- CreateIndex
CREATE INDEX "Stage_workspaceId_pipelineId_order_idx" ON "Stage"("workspaceId", "pipelineId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_workspaceId_id_key" ON "Stage"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_workspaceId_pipelineId_id_key" ON "Stage"("workspaceId", "pipelineId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_workspaceId_pipelineId_name_key" ON "Stage"("workspaceId", "pipelineId", "name");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_pipelineId_stageId_position_idx" ON "Deal"("workspaceId", "pipelineId", "stageId", "position");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_contactId_idx" ON "Deal"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_companyId_idx" ON "Deal"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_ownerMembershipId_idx" ON "Deal"("workspaceId", "ownerMembershipId");

-- CreateIndex
CREATE INDEX "Deal_workspaceId_status_idx" ON "Deal"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_workspaceId_id_key" ON "Deal"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_assigneeMembershipId_idx" ON "Task"("workspaceId", "assigneeMembershipId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_contactId_idx" ON "Task"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_dealId_idx" ON "Task"("workspaceId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_workspaceId_id_key" ON "Task"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Note_workspaceId_contactId_createdAt_idx" ON "Note"("workspaceId", "contactId", "createdAt");

-- CreateIndex
CREATE INDEX "Note_workspaceId_companyId_idx" ON "Note"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "Note_workspaceId_dealId_createdAt_idx" ON "Note"("workspaceId", "dealId", "createdAt");

-- CreateIndex
CREATE INDEX "Note_workspaceId_authorMembershipId_idx" ON "Note"("workspaceId", "authorMembershipId");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_contactId_occurredAt_id_idx" ON "Activity"("workspaceId", "contactId", "occurredAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_dealId_occurredAt_id_idx" ON "Activity"("workspaceId", "dealId", "occurredAt" DESC, "id");

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_workspaceId_pipelineId_fkey" FOREIGN KEY ("workspaceId", "pipelineId") REFERENCES "Pipeline"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_pipelineId_fkey" FOREIGN KEY ("workspaceId", "pipelineId") REFERENCES "Pipeline"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_pipelineId_stageId_fkey" FOREIGN KEY ("workspaceId", "pipelineId", "stageId") REFERENCES "Stage"("workspaceId", "pipelineId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_assigneeMembershipId_fkey" FOREIGN KEY ("workspaceId", "assigneeMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_dealId_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_authorMembershipId_fkey" FOREIGN KEY ("workspaceId", "authorMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_dealId_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_actorMembershipId_fkey" FOREIGN KEY ("workspaceId", "actorMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_dealId_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_taskId_fkey" FOREIGN KEY ("workspaceId", "taskId") REFERENCES "Task"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- BACKFILL idempotente (ajuste #2 da revisão do plano): todo workspace já
-- existente sem pipeline default ganha o pipeline "Vendas" com stages padrão.
-- SQL de DADOS (não estrutura): invisível ao diff do Prisma — sem risco de
-- drift. Workspaces novos recebem o mesmo seed pelo ProvisioningService.
INSERT INTO "Pipeline" ("id", "workspaceId", "name", "defaultMark", "updatedAt")
SELECT gen_random_uuid(), w."id", 'Vendas', true, now()
FROM "Workspace" w
WHERE NOT EXISTS (
  SELECT 1 FROM "Pipeline" p WHERE p."workspaceId" = w."id" AND p."defaultMark" = true
);

INSERT INTO "Stage" ("id", "workspaceId", "pipelineId", "name", "order", "probability", "type")
SELECT gen_random_uuid(), p."workspaceId", p."id", s.name, s.ord, s.prob, s.type::"StageType"
FROM "Pipeline" p
CROSS JOIN (VALUES
  ('Novo', 0, 10, 'open'),
  ('Qualificado', 1, 30, 'open'),
  ('Proposta', 2, 60, 'open'),
  ('Fechamento', 3, 85, 'open'),
  ('Ganhou', 4, 100, 'won'),
  ('Perdeu', 5, 0, 'lost')
) AS s(name, ord, prob, type)
WHERE p."defaultMark" = true
  AND NOT EXISTS (SELECT 1 FROM "Stage" st WHERE st."pipelineId" = p."id");

-- CreateEnum
CREATE TYPE "CalendarEventStatus" AS ENUM ('scheduled', 'done', 'canceled');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'event_scheduled';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "calendarEventId" UUID;

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "status" "CalendarEventStatus" NOT NULL DEFAULT 'scheduled',
    "organizerMembershipId" UUID NOT NULL,
    "contactId" UUID,
    "dealId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "recipientMembershipId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarEvent_workspaceId_startAt_idx" ON "CalendarEvent"("workspaceId", "startAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_workspaceId_organizerMembershipId_startAt_idx" ON "CalendarEvent"("workspaceId", "organizerMembershipId", "startAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_workspaceId_contactId_idx" ON "CalendarEvent"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "CalendarEvent_workspaceId_dealId_idx" ON "CalendarEvent"("workspaceId", "dealId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEvent_workspaceId_id_key" ON "CalendarEvent"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Notification_workspaceId_recipientMembershipId_readAt_creat_idx" ON "Notification"("workspaceId", "recipientMembershipId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_workspaceId_dedupeKey_key" ON "Notification"("workspaceId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_calendarEventId_fkey" FOREIGN KEY ("workspaceId", "calendarEventId") REFERENCES "CalendarEvent"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_workspaceId_organizerMembershipId_fkey" FOREIGN KEY ("workspaceId", "organizerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_workspaceId_dealId_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_recipientMembershipId_fkey" FOREIGN KEY ("workspaceId", "recipientMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Invariante de tempo NO BANCO: evento não pode terminar antes de começar.
-- Deixar isso só no service significa aceitar que um raw ou um bug futuro grave
-- janela invertida — e toda consulta por período passaria a mentir.
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_end_after_start"
  CHECK ("endAt" > "startAt");

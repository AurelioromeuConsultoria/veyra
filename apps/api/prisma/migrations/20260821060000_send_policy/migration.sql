-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('approved', 'paused');

-- AlterEnum
ALTER TYPE "DispatchState" ADD VALUE 'failed_permanent';

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "externalAddress" TEXT;

-- AlterTable
ALTER TABLE "InboundMedia" ADD COLUMN     "claimToken" UUID,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessageDispatch" ADD COLUMN     "reservationId" UUID;

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "paramCount" INTEGER NOT NULL DEFAULT 0,
    "status" "TemplateStatus" NOT NULL DEFAULT 'approved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplate_workspaceId_channelId_idx" ON "MessageTemplate"("workspaceId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_channelId_name_language_key" ON "MessageTemplate"("workspaceId", "channelId", "name", "language");

-- CreateIndex
CREATE INDEX "InboundMedia_state_leaseExpiresAt_idx" ON "InboundMedia"("state", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


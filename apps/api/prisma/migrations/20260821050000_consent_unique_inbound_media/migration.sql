-- CreateEnum
CREATE TYPE "InboundMediaState" AS ENUM ('pending', 'fetched', 'failed');

-- AlterTable
ALTER TABLE "ContactChannelConsent" ADD COLUMN     "activeMark" BOOLEAN;

-- CreateTable
CREATE TABLE "InboundMedia" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "providerMediaId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT,
    "state" "InboundMediaState" NOT NULL DEFAULT 'pending',
    "fileObjectId" UUID,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InboundMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InboundMedia_workspaceId_state_idx" ON "InboundMedia"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "InboundMedia_workspaceId_messageId_providerMediaId_key" ON "InboundMedia"("workspaceId", "messageId", "providerMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactChannelConsent_workspaceId_contactId_channelType_act_key" ON "ContactChannelConsent"("workspaceId", "contactId", "channelType", "activeMark");

-- AddForeignKey
ALTER TABLE "InboundMedia" ADD CONSTRAINT "InboundMedia_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMedia" ADD CONSTRAINT "InboundMedia_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundMedia" ADD CONSTRAINT "InboundMedia_workspaceId_fileObjectId_fkey" FOREIGN KEY ("workspaceId", "fileObjectId") REFERENCES "FileObject"("workspaceId", "id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A marca de vigência é TRUE ou NULL: FALSE derrotaria o unique (vários FALSE
-- convivem), e `revokedAt` preenchido tem de significar marca nula.
ALTER TABLE "ContactChannelConsent" ADD CONSTRAINT "ContactChannelConsent_activeMark_coerente"
  CHECK (
    ("activeMark" = TRUE AND "revokedAt" IS NULL)
    OR ("activeMark" IS NULL AND "revokedAt" IS NOT NULL)
  );

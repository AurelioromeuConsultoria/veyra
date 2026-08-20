-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('form', 'agent', 'import');

-- CreateEnum
CREATE TYPE "DispatchState" AS ENUM ('reserved', 'sent', 'failed_before_send', 'unknown_after_dispatch');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('sent', 'delivered', 'read', 'failed');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastInboundAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ChannelCredential" (
    "channelId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "businessAccountId" TEXT NOT NULL,
    "tokenCipher" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelCredential_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "ContactChannelConsent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channelType" "ChannelType" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "evidence" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "grantedByMembershipId" UUID,

    CONSTRAINT "ContactChannelConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDispatch" (
    "messageId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "state" "DispatchState" NOT NULL DEFAULT 'reserved',
    "externalId" TEXT,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDispatch_pkey" PRIMARY KEY ("messageId")
);

-- CreateTable
CREATE TABLE "MessageStatusEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelCredential_workspaceId_idx" ON "ChannelCredential"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelCredential_phoneNumberId_key" ON "ChannelCredential"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelCredential_workspaceId_channelId_key" ON "ChannelCredential"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "ContactChannelConsent_workspaceId_contactId_channelType_idx" ON "ContactChannelConsent"("workspaceId", "contactId", "channelType");

-- CreateIndex
CREATE INDEX "MessageDispatch_workspaceId_state_idx" ON "MessageDispatch"("workspaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDispatch_workspaceId_externalId_key" ON "MessageDispatch"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "MessageStatusEvent_workspaceId_messageId_occurredAt_idx" ON "MessageStatusEvent"("workspaceId", "messageId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageStatusEvent_workspaceId_messageId_status_key" ON "MessageStatusEvent"("workspaceId", "messageId", "status");

-- AddForeignKey
ALTER TABLE "ChannelCredential" ADD CONSTRAINT "ChannelCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelCredential" ADD CONSTRAINT "ChannelCredential_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactChannelConsent" ADD CONSTRAINT "ContactChannelConsent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactChannelConsent" ADD CONSTRAINT "ContactChannelConsent_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactChannelConsent" ADD CONSTRAINT "ContactChannelConsent_workspaceId_grantedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "grantedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MessageDispatch" ADD CONSTRAINT "MessageDispatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDispatch" ADD CONSTRAINT "MessageDispatch_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageStatusEvent" ADD CONSTRAINT "MessageStatusEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageStatusEvent" ADD CONSTRAINT "MessageStatusEvent_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


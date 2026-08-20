-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('internal', 'email', 'whatsapp');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'pending', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('contact', 'user', 'ai', 'system');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ActivityType" ADD VALUE 'message_sent';
ALTER TYPE "ActivityType" ADD VALUE 'message_received';

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "conversationId" UUID;

-- CreateTable
CREATE TABLE "Channel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "ChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "systemMark" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "contactId" UUID,
    "subject" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',
    "assigneeMembershipId" UUID,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "authorType" "MessageAuthor" NOT NULL,
    "authorMembershipId" UUID,
    "authorContactId" UUID,
    "body" TEXT NOT NULL,
    "externalId" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Channel_workspaceId_type_idx" ON "Channel"("workspaceId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_workspaceId_id_key" ON "Channel"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_workspaceId_systemMark_key" ON "Channel"("workspaceId", "systemMark");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "status", "lastMessageAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_id_idx" ON "Conversation"("workspaceId", "lastMessageAt" DESC, "id");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_contactId_idx" ON "Conversation"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assigneeMembershipId_idx" ON "Conversation"("workspaceId", "assigneeMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_id_key" ON "Conversation"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Message_workspaceId_conversationId_createdAt_id_idx" ON "Message"("workspaceId", "conversationId", "createdAt" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_id_key" ON "Message"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_workspaceId_channelId_externalId_key" ON "Message"("workspaceId", "channelId", "externalId");

-- CreateIndex
CREATE INDEX "Activity_workspaceId_conversationId_occurredAt_id_idx" ON "Activity"("workspaceId", "conversationId", "occurredAt" DESC, "id");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_assigneeMembershipId_fkey" FOREIGN KEY ("workspaceId", "assigneeMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_channelId_fkey" FOREIGN KEY ("workspaceId", "channelId") REFERENCES "Channel"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_authorMembershipId_fkey" FOREIGN KEY ("workspaceId", "authorMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_authorContactId_fkey" FOREIGN KEY ("workspaceId", "authorContactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A marca de sistema é TRUE ou NULL: FALSE derrotaria o unique parcial (vários
-- FALSE convivem). E só canal interno pode ser o canal de sistema.
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_systemMark_true_or_null"
  CHECK ("systemMark" IS NULL OR ("systemMark" = TRUE AND "type" = 'internal'));

-- BACKFILL idempotente (mesmo padrão do pipeline padrão): todo workspace que
-- ainda não tem canal interno ganha um. O WHERE NOT EXISTS torna a migration
-- segura de reaplicar.
INSERT INTO "Channel" ("id", "workspaceId", "type", "name", "systemMark")
SELECT gen_random_uuid(), w."id", 'internal', 'Interno', TRUE
  FROM "Workspace" w
 WHERE NOT EXISTS (
   SELECT 1 FROM "Channel" c WHERE c."workspaceId" = w."id" AND c."systemMark" = TRUE
 );

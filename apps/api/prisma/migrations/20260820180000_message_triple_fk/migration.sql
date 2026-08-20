-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_workspaceId_conversationId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_channelId_id_key" ON "Conversation"("workspaceId", "channelId", "id");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_channelId_conversationId_fkey" FOREIGN KEY ("workspaceId", "channelId", "conversationId") REFERENCES "Conversation"("workspaceId", "channelId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


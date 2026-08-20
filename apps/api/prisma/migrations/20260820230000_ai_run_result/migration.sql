-- AlterEnum
ALTER TYPE "ActivityActor" ADD VALUE 'ai';

-- AlterEnum
ALTER TYPE "AiProposalStatus" ADD VALUE 'executing';

-- AlterTable
ALTER TABLE "AiRun" ADD COLUMN     "contactId" UUID,
ADD COLUMN     "conversationId" UUID,
ADD COLUMN     "result" JSONB;

-- CreateIndex
CREATE INDEX "AiRun_workspaceId_conversationId_capability_createdAt_idx" ON "AiRun"("workspaceId", "conversationId", "capability", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AiRun_workspaceId_contactId_capability_createdAt_idx" ON "AiRun"("workspaceId", "contactId", "capability", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_workspaceId_conversationId_fkey" FOREIGN KEY ("workspaceId", "conversationId") REFERENCES "Conversation"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


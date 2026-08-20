-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_workspaceId_chainId_fkey" FOREIGN KEY ("workspaceId", "chainId") REFERENCES "OutboxEvent"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


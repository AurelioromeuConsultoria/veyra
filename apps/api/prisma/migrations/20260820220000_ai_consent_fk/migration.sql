-- AddForeignKey
ALTER TABLE "AiConsent" ADD CONSTRAINT "AiConsent_workspaceId_updatedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "updatedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


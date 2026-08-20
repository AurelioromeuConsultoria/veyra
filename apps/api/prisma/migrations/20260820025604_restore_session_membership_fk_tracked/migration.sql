-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_activeMembershipId_fkey" FOREIGN KEY ("userId", "activeMembershipId") REFERENCES "Membership"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "Company" DROP CONSTRAINT "Company_workspaceId_ownerMembershipId_fkey";

-- DropForeignKey
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_workspaceId_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_workspaceId_ownerMembershipId_fkey";

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "CompanySize" AS ENUM ('solo', 'small', 'medium', 'large', 'enterprise');

-- CreateEnum
CREATE TYPE "TagColor" AS ENUM ('slate', 'stone', 'accent', 'positive', 'negative', 'warning', 'info');

-- CreateEnum
CREATE TYPE "CustomFieldEntity" AS ENUM ('contact', 'company');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'date', 'boolean', 'select', 'multiselect');

-- DropForeignKey
ALTER TABLE "RefreshToken" DROP CONSTRAINT "RefreshToken_userId_activeMembershipId_fkey";

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "size" "CompanySize",
    "ownerMembershipId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ContactStatus" NOT NULL DEFAULT 'active',
    "companyId" UUID,
    "ownerMembershipId" UUID,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" "TagColor" NOT NULL DEFAULT 'slate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTag" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyTag" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "companyId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "CompanyTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "entityType" "CustomFieldEntity" NOT NULL,
    "entityId" UUID NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Company_workspaceId_name_idx" ON "Company"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_id_key" ON "Company"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_domain_key" ON "Company"("workspaceId", "domain");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_status_createdAt_idx" ON "Contact"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_name_idx" ON "Contact"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_companyId_idx" ON "Contact"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_ownerMembershipId_idx" ON "Contact"("workspaceId", "ownerMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_workspaceId_id_key" ON "Contact"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspaceId_id_key" ON "Tag"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_workspaceId_name_key" ON "Tag"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ContactTag_workspaceId_tagId_idx" ON "ContactTag"("workspaceId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactTag_workspaceId_contactId_tagId_key" ON "ContactTag"("workspaceId", "contactId", "tagId");

-- CreateIndex
CREATE INDEX "CompanyTag_workspaceId_tagId_idx" ON "CompanyTag"("workspaceId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyTag_workspaceId_companyId_tagId_key" ON "CompanyTag"("workspaceId", "companyId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_workspaceId_id_key" ON "CustomFieldDefinition"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_workspaceId_entityType_key_key" ON "CustomFieldDefinition"("workspaceId", "entityType", "key");

-- CreateIndex
CREATE INDEX "CustomFieldValue_workspaceId_entityType_entityId_idx" ON "CustomFieldValue"("workspaceId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_workspaceId_definitionId_entityId_key" ON "CustomFieldValue"("workspaceId", "definitionId", "entityId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_ownerMembershipId_fkey" FOREIGN KEY ("workspaceId", "ownerMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_workspaceId_tagId_fkey" FOREIGN KEY ("workspaceId", "tagId") REFERENCES "Tag"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTag" ADD CONSTRAINT "CompanyTag_workspaceId_companyId_fkey" FOREIGN KEY ("workspaceId", "companyId") REFERENCES "Company"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyTag" ADD CONSTRAINT "CompanyTag_workspaceId_tagId_fkey" FOREIGN KEY ("workspaceId", "tagId") REFERENCES "Tag"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_workspaceId_definitionId_fkey" FOREIGN KEY ("workspaceId", "definitionId") REFERENCES "CustomFieldDefinition"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

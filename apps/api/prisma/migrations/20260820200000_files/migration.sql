-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('pending', 'clean', 'quarantined');

-- CreateTable
CREATE TABLE "FileObject" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedByMembershipId" UUID NOT NULL,
    "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "fileObjectId" UUID NOT NULL,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileObject_workspaceId_createdAt_idx" ON "FileObject"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FileObject_workspaceId_scanStatus_idx" ON "FileObject"("workspaceId", "scanStatus");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_workspaceId_id_key" ON "FileObject"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_workspaceId_key_key" ON "FileObject"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "MessageAttachment_workspaceId_fileObjectId_idx" ON "MessageAttachment"("workspaceId", "fileObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_workspaceId_messageId_fileObjectId_key" ON "MessageAttachment"("workspaceId", "messageId", "fileObjectId");

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_workspaceId_uploadedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "uploadedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_workspaceId_messageId_fkey" FOREIGN KEY ("workspaceId", "messageId") REFERENCES "Message"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_workspaceId_fileObjectId_fkey" FOREIGN KEY ("workspaceId", "fileObjectId") REFERENCES "FileObject"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


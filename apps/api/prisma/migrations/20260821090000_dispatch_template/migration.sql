-- AlterTable
ALTER TABLE "MessageDispatch" ADD COLUMN     "templateLanguage" TEXT,
ADD COLUMN     "templateName" TEXT,
ADD COLUMN     "templateParams" JSONB;


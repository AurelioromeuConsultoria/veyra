-- AlterEnum
ALTER TYPE "DispatchState" ADD VALUE 'sending';

-- AlterTable
ALTER TABLE "MessageDispatch" ADD COLUMN     "claimToken" UUID,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MessageDispatch_state_leaseExpiresAt_idx" ON "MessageDispatch"("state", "leaseExpiresAt");


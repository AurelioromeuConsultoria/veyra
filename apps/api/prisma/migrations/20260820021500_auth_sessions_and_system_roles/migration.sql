-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "activeMembershipId" UUID;

-- AlterTable
ALTER TABLE "Role" ADD COLUMN     "systemKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_id_key" ON "Membership"("userId", "id");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_activeMembershipId_idx" ON "RefreshToken"("userId", "activeMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_workspaceId_systemKey_key" ON "Role"("workspaceId", "systemKey");

-- SQL MANUAL (não regenerar): FK composta (userId, activeMembershipId) →
-- Membership(userId, id). O Prisma não modela relação com nulidade mista;
-- MATCH SIMPLE do Postgres ignora a FK quando activeMembershipId é NULL e,
-- quando preenchido, o BANCO garante que a membership pertence ao dono do
-- token (ajuste aprovado #1 da Entrega 2). ON DELETE CASCADE: excluída a
-- membership ativa, a sessão cai junto (re-login resolve).
ALTER TABLE "RefreshToken"
  ADD CONSTRAINT "RefreshToken_userId_activeMembershipId_fkey"
  FOREIGN KEY ("userId", "activeMembershipId")
  REFERENCES "Membership"("userId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

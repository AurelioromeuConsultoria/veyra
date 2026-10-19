-- Veyra Clinics — fundação do vertical (F1.b, ADR-047 e ADR-048).
--
-- Só CRIA: três tabelas do vertical e seus enums. Nenhuma tabela do Core é
-- alterada (o lado reverso das relações no schema do Core não gera SQL).
-- Toda FK para entidade do Core é COMPOSTA por (workspaceId, id) (ADR-010).
-- Tabelas novas e vazias, sem backfill. MAS cada `ADD FOREIGN KEY` pede SHARE
-- ROW EXCLUSIVE também na tabela REFERENCIADA (`Workspace`, `Contact`,
-- `Membership`): com uma transação longa aberta, as escritas nelas parariam
-- atrás do ALTER. Melhor falhar em 5s; se falhar (P3009), `prisma migrate
-- resolve --rolled-back <esta migration>` e repita (DEPLOY_STAGING §4).
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsActivationStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "ClinicsReleaseConsumer" AS ENUM ('ai');

-- CreateEnum
CREATE TYPE "ClinicsReleaseReason" AS ENUM ('supplier', 'partner', 'staff', 'non_clinical_business');

-- CreateTable
CREATE TABLE "ClinicsSettings" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "status" "ClinicsActivationStatus" NOT NULL DEFAULT 'active',
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsUnit" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsContactRelease" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "consumer" "ClinicsReleaseConsumer" NOT NULL,
    "reason" "ClinicsReleaseReason" NOT NULL,
    "releasedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsContactRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsSettings_workspaceId_key" ON "ClinicsSettings"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsSettings_workspaceId_id_key" ON "ClinicsSettings"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsUnit_workspaceId_archivedAt_idx" ON "ClinicsUnit"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsUnit_workspaceId_id_key" ON "ClinicsUnit"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsContactRelease_workspaceId_releasedByMembershipId_idx" ON "ClinicsContactRelease"("workspaceId", "releasedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsContactRelease_workspaceId_contactId_consumer_key" ON "ClinicsContactRelease"("workspaceId", "contactId", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsContactRelease_workspaceId_id_key" ON "ClinicsContactRelease"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "ClinicsSettings" ADD CONSTRAINT "ClinicsSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsUnit" ADD CONSTRAINT "ClinicsUnit_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsContactRelease" ADD CONSTRAINT "ClinicsContactRelease_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsContactRelease" ADD CONSTRAINT "ClinicsContactRelease_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsContactRelease" ADD CONSTRAINT "ClinicsContactRelease_workspaceId_releasedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "releasedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;

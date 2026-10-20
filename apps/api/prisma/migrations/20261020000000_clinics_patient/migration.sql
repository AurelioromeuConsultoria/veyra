-- Veyra Clinics — perfil de paciente (F2.1, ADR-048 adendo 2, itens 1 a 3).
--
-- Só CRIA: a tabela do perfil de paciente, com FKs COMPOSTAS (ADR-010). A FK
-- para o contato é NO ACTION de propósito: excluir um contato que é paciente
-- é recusado (409, ADR-048 §9.1) até a decisão jurídica (B3).
--
-- Os `ADD FOREIGN KEY` pedem SHARE ROW EXCLUSIVE também em `Contact`,
-- `Membership` e `Workspace`. Melhor falhar em 5s; se falhar (P3009), `prisma
-- migrate resolve --rolled-back <esta migration>` e repita (DEPLOY_STAGING §4).
SET lock_timeout = '5s';
-- CreateTable
CREATE TABLE "ClinicsPatient" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicsPatient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsPatient_workspaceId_createdByMembershipId_idx" ON "ClinicsPatient"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPatient_workspaceId_contactId_key" ON "ClinicsPatient"("workspaceId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPatient_workspaceId_id_key" ON "ClinicsPatient"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "ClinicsPatient" ADD CONSTRAINT "ClinicsPatient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsPatient" ADD CONSTRAINT "ClinicsPatient_workspaceId_contactId_fkey" FOREIGN KEY ("workspaceId", "contactId") REFERENCES "Contact"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPatient" ADD CONSTRAINT "ClinicsPatient_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;

-- Veyra Clinics — catálogo da clínica (F1.c, ADR-048 adendo 1).
--
-- Só ACRESCENTA: o fuso da unidade (default, sem backfill) e as tabelas de
-- serviço, profissional, serviços habilitados e horários semanais. Toda FK
-- para entidade do Core é COMPOSTA por (workspaceId, id) (ADR-010).
--
-- Os `ADD FOREIGN KEY` pedem SHARE ROW EXCLUSIVE também na tabela referenciada
-- (`Workspace`, `Membership`), e o `ADD COLUMN` em `ClinicsUnit` (no fim) pede
-- lock exclusivo nela (só metadados: default constante, sem reescrita). Melhor
-- falhar em 5s; se falhar (P3009), `prisma migrate resolve --rolled-back <esta
-- migration>` e repita o deploy (DEPLOY_STAGING §4).
SET lock_timeout = '5s';

-- Igualdade de uuid/int dentro de um índice GiST, para o EXCLUDE dos horários
-- (e da agenda, na F2). Extensão CONFIÁVEL (trusted) no Postgres 13+: o dono
-- do banco a cria sem superusuário.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "ClinicsService" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "priceCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsProfessional" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "membershipId" UUID,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsProfessional_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsProfessionalService" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicsProfessionalService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsWorkingHours" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicsWorkingHours_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsService_workspaceId_archivedAt_idx" ON "ClinicsService"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsService_workspaceId_id_key" ON "ClinicsService"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsProfessional_workspaceId_archivedAt_idx" ON "ClinicsProfessional"("workspaceId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsProfessional_workspaceId_membershipId_key" ON "ClinicsProfessional"("workspaceId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsProfessional_workspaceId_id_key" ON "ClinicsProfessional"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsProfessionalService_workspaceId_serviceId_idx" ON "ClinicsProfessionalService"("workspaceId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsProfessionalService_workspaceId_professionalId_servi_key" ON "ClinicsProfessionalService"("workspaceId", "professionalId", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsProfessionalService_workspaceId_id_key" ON "ClinicsProfessionalService"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsWorkingHours_workspaceId_professionalId_idx" ON "ClinicsWorkingHours"("workspaceId", "professionalId");

-- CreateIndex
CREATE INDEX "ClinicsWorkingHours_workspaceId_unitId_idx" ON "ClinicsWorkingHours"("workspaceId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsWorkingHours_workspaceId_id_key" ON "ClinicsWorkingHours"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "ClinicsService" ADD CONSTRAINT "ClinicsService_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsProfessional" ADD CONSTRAINT "ClinicsProfessional_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsProfessional" ADD CONSTRAINT "ClinicsProfessional_workspaceId_membershipId_fkey" FOREIGN KEY ("workspaceId", "membershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsProfessionalService" ADD CONSTRAINT "ClinicsProfessionalService_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsProfessionalService" ADD CONSTRAINT "ClinicsProfessionalService_workspaceId_professionalId_fkey" FOREIGN KEY ("workspaceId", "professionalId") REFERENCES "ClinicsProfessional"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsProfessionalService" ADD CONSTRAINT "ClinicsProfessionalService_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "ClinicsService"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsWorkingHours" ADD CONSTRAINT "ClinicsWorkingHours_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsWorkingHours" ADD CONSTRAINT "ClinicsWorkingHours_workspaceId_professionalId_fkey" FOREIGN KEY ("workspaceId", "professionalId") REFERENCES "ClinicsProfessional"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsWorkingHours" ADD CONSTRAINT "ClinicsWorkingHours_workspaceId_unitId_fkey" FOREIGN KEY ("workspaceId", "unitId") REFERENCES "ClinicsUnit"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- Faixas que o banco garante (o contrato também valida; aqui é a última linha)
ALTER TABLE "ClinicsService" ADD CONSTRAINT "ClinicsService_duration_check"
  CHECK ("durationMin" BETWEEN 5 AND 480 AND "durationMin" % 5 = 0);
ALTER TABLE "ClinicsService" ADD CONSTRAINT "ClinicsService_price_check"
  CHECK ("priceCents" IS NULL OR "priceCents" >= 0);
ALTER TABLE "ClinicsWorkingHours" ADD CONSTRAINT "ClinicsWorkingHours_range_check"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "startMinute" >= 0 AND "endMinute" <= 1440
         AND "startMinute" < "endMinute");

-- SEM SOBREPOSIÇÃO: o mesmo profissional não tem dois intervalos que se
-- cruzam no mesmo dia, em NENHUMA unidade (ninguém atende em dois lugares ao
-- mesmo tempo). `[início, fim)`: um intervalo que termina às 12h e outro que
-- começa às 12h não se sobrepõem. O Prisma não declara exclusão; a violação
-- (23P01) responde 409 (ADR-048 adendo 1, item 5).
ALTER TABLE "ClinicsWorkingHours" ADD CONSTRAINT "ClinicsWorkingHours_no_overlap"
  EXCLUDE USING gist (
    "workspaceId" WITH =,
    "professionalId" WITH =,
    "weekday" WITH =,
    int4range("startMinute", "endMinute") WITH &&
  );

-- Fuso da unidade POR ÚLTIMO: o ADD COLUMN pede lock exclusivo em
-- `ClinicsUnit`, que a checagem de presença da porta E6 lê a cada webhook ou
-- chamada de IA. Feito antes das FKs, ficaria preso enquanto elas esperam.
-- Default constante: só metadados, sem reescrita da tabela.
ALTER TABLE "ClinicsUnit" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;

-- Veyra Clinics — agenda e registro de atendimento (F2.2, ADR-048 adendos 2 e 4).
--
-- Só ACRESCENTA: dois enums e duas tabelas novas, vazias. Toda FK para entidade
-- do Core é COMPOSTA por (workspaceId, id) (ADR-010), com NO ACTION para o
-- catálogo e o paciente (nada disso é apagado; só arquivado).
--
-- Os `ADD FOREIGN KEY` pedem SHARE ROW EXCLUSIVE nas tabelas referenciadas
-- (`Workspace`, `Membership` e as do catálogo). Melhor falhar em 5s; se falhar
-- (P3009), `prisma migrate resolve --rolled-back <esta migration>` e repita o
-- deploy (DEPLOY_STAGING §4).
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsAppointmentStatus" AS ENUM ('scheduled', 'confirmed', 'arrived', 'canceled', 'no_show', 'attended');

-- CreateEnum
CREATE TYPE "ClinicsCancelReason" AS ENUM ('patient_request', 'clinic_request', 'professional_unavailable', 'scheduling_error');

-- CreateTable
CREATE TABLE "ClinicsAppointment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ClinicsAppointmentStatus" NOT NULL DEFAULT 'scheduled',
    "cancelReason" "ClinicsCancelReason",
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicsAppointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsAttendance" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "professionalId" UUID NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicsAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsAppointment_workspaceId_unitId_startsAt_idx" ON "ClinicsAppointment"("workspaceId", "unitId", "startsAt");

-- CreateIndex
CREATE INDEX "ClinicsAppointment_workspaceId_professionalId_startsAt_idx" ON "ClinicsAppointment"("workspaceId", "professionalId", "startsAt");

-- CreateIndex
CREATE INDEX "ClinicsAppointment_workspaceId_patientId_idx" ON "ClinicsAppointment"("workspaceId", "patientId");

-- CreateIndex
CREATE INDEX "ClinicsAppointment_workspaceId_serviceId_idx" ON "ClinicsAppointment"("workspaceId", "serviceId");

-- CreateIndex
CREATE INDEX "ClinicsAppointment_workspaceId_createdByMembershipId_idx" ON "ClinicsAppointment"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAppointment_workspaceId_id_key" ON "ClinicsAppointment"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsAttendance_workspaceId_professionalId_idx" ON "ClinicsAttendance"("workspaceId", "professionalId");

-- CreateIndex
CREATE INDEX "ClinicsAttendance_workspaceId_recordedByMembershipId_idx" ON "ClinicsAttendance"("workspaceId", "recordedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAttendance_workspaceId_appointmentId_key" ON "ClinicsAttendance"("workspaceId", "appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAttendance_workspaceId_id_key" ON "ClinicsAttendance"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_patientId_fkey" FOREIGN KEY ("workspaceId", "patientId") REFERENCES "ClinicsPatient"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_professionalId_fkey" FOREIGN KEY ("workspaceId", "professionalId") REFERENCES "ClinicsProfessional"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "ClinicsService"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_unitId_fkey" FOREIGN KEY ("workspaceId", "unitId") REFERENCES "ClinicsUnit"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_appointmentId_fkey" FOREIGN KEY ("workspaceId", "appointmentId") REFERENCES "ClinicsAppointment"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_professionalId_fkey" FOREIGN KEY ("workspaceId", "professionalId") REFERENCES "ClinicsProfessional"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_recordedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "recordedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- O fim depois do início (o contrato e o serviço também garantem).
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_range_check"
  CHECK ("endsAt" > "startsAt");

-- SEM SOBREPOSIÇÃO entre agendamentos ATIVOS do mesmo profissional, em
-- qualquer unidade (ninguém atende dois ao mesmo tempo). `[início, fim)`:
-- terminar às 10h e começar às 10h não se sobrepõem. Cancelado e falta saem
-- da regra, e liberam o horário. A violação (23P01) responde 409 (adendo 4,
-- item 1). O `btree_gist` vem da migration do catálogo.
ALTER TABLE "ClinicsAppointment" ADD CONSTRAINT "ClinicsAppointment_no_overlap"
  EXCLUDE USING gist (
    "workspaceId" WITH =,
    "professionalId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  ) WHERE ("status" IN ('scheduled', 'confirmed', 'arrived', 'attended'));

-- devolve o padrão para o resto da sessão do `migrate deploy`
RESET lock_timeout;

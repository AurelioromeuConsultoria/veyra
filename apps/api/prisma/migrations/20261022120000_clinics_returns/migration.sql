-- Veyra Clinics — retornos (F3.2, ADR-048 adendo 7). ACRESCENTA: dois enums, a
-- tabela nova e vazia `ClinicsReturn`, a coluna anulável
-- `ClinicsService.returnIntervalDays`, a coluna `ClinicsAttendance.recordedAt`
-- (relógio do banco), dois índices únicos de apoio (no agendamento e no
-- atendimento) e as regras abaixo.
-- Único dado escrito: o `recordedAt` dos registros de atendimento já
-- existentes, com o instante desta migration (um gatilho o força e o fixa
-- daqui em diante). Toda FK de tenant é COMPOSTA por
-- (workspaceId, id) (ADR-010), com NO ACTION; só a do workspace é em cascata.
--
-- TRANSAÇÃO EXPLÍCITA (ADR-051): o `prisma migrate deploy` executa instrução
-- por instrução; aqui, ou tudo, ou nada.
--
-- Locks em tabelas existentes: os índices únicos em `ClinicsAppointment` e
-- `ClinicsAttendance` (constroem sobre as linhas existentes); as FKs para `Workspace`,
-- `ClinicsPatient`, `ClinicsService`, `ClinicsUnit`, `ClinicsAttendance`,
-- `ClinicsAppointment` e `Membership`; e, POR
-- ÚLTIMO, os ADD COLUMN em `ClinicsService` e `ClinicsAttendance` (exclusivos;
-- o de `ClinicsAttendance` reescreve a tabela, pelo default volátil). O
-- `lock_timeout` limita só a espera de CADA lock, não a soma nem a execução, e
-- a transação segura os locks até o COMMIT: a ESTIMATIVA do pior caso é de
-- cerca de 55 s de espera (até onze esperas de 5 s), mais a execução. Roda em
-- manutenção, sem acesso externo e com os jobs desligados (DEPLOY_STAGING §4).
--
-- Se falhar: a transação volta inteira; o Prisma mostra só "current
-- transaction is aborted", e a causa está no log do Postgres. NÃO marque
-- rolled-back às cegas: siga o DEPLOY_STAGING §4, com o inventário desta
-- migration.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsReturnStatus" AS ENUM ('pending', 'done', 'canceled');

-- CreateEnum
CREATE TYPE "ClinicsReturnCancelReason" AS ENUM ('patient_declined', 'patient_unreachable', 'not_needed', 'created_in_error');

-- CreateTable
CREATE TABLE "ClinicsReturn" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "originAttendanceId" UUID,
    "dueDate" DATE NOT NULL,
    "status" "ClinicsReturnStatus" NOT NULL DEFAULT 'pending',
    "assigneeMembershipId" UUID,
    "appointmentId" UUID,
    "fulfilledByAttendanceId" UUID,
    "cancelReason" "ClinicsReturnCancelReason",
    "createdByMembershipId" UUID NOT NULL,
    "closedByMembershipId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ClinicsReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_status_dueDate_idx" ON "ClinicsReturn"("workspaceId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_patientId_idx" ON "ClinicsReturn"("workspaceId", "patientId");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_serviceId_idx" ON "ClinicsReturn"("workspaceId", "serviceId");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_unitId_idx" ON "ClinicsReturn"("workspaceId", "unitId");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_assigneeMembershipId_idx" ON "ClinicsReturn"("workspaceId", "assigneeMembershipId");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_createdByMembershipId_idx" ON "ClinicsReturn"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE INDEX "ClinicsReturn_workspaceId_closedByMembershipId_idx" ON "ClinicsReturn"("workspaceId", "closedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsReturn_workspaceId_id_key" ON "ClinicsReturn"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsReturn_workspaceId_originAttendanceId_key" ON "ClinicsReturn"("workspaceId", "originAttendanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsReturn_workspaceId_appointmentId_key" ON "ClinicsReturn"("workspaceId", "appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAppointment_return_link_key" ON "ClinicsAppointment"("workspaceId", "id", "patientId", "serviceId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAttendance_return_proof_key" ON "ClinicsAttendance"("workspaceId", "appointmentId", "id");

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_workspaceId_patientId_fkey" FOREIGN KEY ("workspaceId", "patientId") REFERENCES "ClinicsPatient"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "ClinicsService"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_workspaceId_unitId_fkey" FOREIGN KEY ("workspaceId", "unitId") REFERENCES "ClinicsUnit"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_originAttendance_fkey" FOREIGN KEY ("workspaceId", "originAttendanceId") REFERENCES "ClinicsAttendance"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_appointment_fkey" FOREIGN KEY ("workspaceId", "appointmentId", "patientId", "serviceId", "unitId") REFERENCES "ClinicsAppointment"("workspaceId", "id", "patientId", "serviceId", "unitId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_fulfilledBy_fkey" FOREIGN KEY ("workspaceId", "appointmentId", "fulfilledByAttendanceId") REFERENCES "ClinicsAttendance"("workspaceId", "appointmentId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_assignee_fkey" FOREIGN KEY ("workspaceId", "assigneeMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_createdBy_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsReturn" ADD CONSTRAINT "ClinicsReturn_closedBy_fkey" FOREIGN KEY ("workspaceId", "closedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Os estados. `done` exige o agendamento E a prova (a FK `fulfilledBy` amarra
-- o registro de atendimento ao MESMO agendamento: o rótulo `attended` sozinho
-- não conclui). O cancelado libera o agendamento.
ALTER TABLE "ClinicsReturn"
  ADD CONSTRAINT "ClinicsReturn_status_check" CHECK (
    ("status" = 'pending' AND "closedAt" IS NULL AND "cancelReason" IS NULL
      AND "fulfilledByAttendanceId" IS NULL AND "closedByMembershipId" IS NULL)
    OR ("status" = 'done' AND "appointmentId" IS NOT NULL AND "fulfilledByAttendanceId" IS NOT NULL
      AND "cancelReason" IS NULL AND "closedAt" IS NOT NULL AND "closedByMembershipId" IS NOT NULL)
    OR ("status" = 'canceled' AND "cancelReason" IS NOT NULL AND "appointmentId" IS NULL
      AND "fulfilledByAttendanceId" IS NULL AND "closedAt" IS NOT NULL AND "closedByMembershipId" IS NOT NULL)
  ),
  -- "criado por engano" só vale para o retorno criado à mão
  ADD CONSTRAINT "ClinicsReturn_created_in_error_check"
    CHECK (NOT ("cancelReason" = 'created_in_error' AND "originAttendanceId" IS NOT NULL)),
  -- o atendimento que GEROU o retorno nunca o cumpre
  ADD CONSTRAINT "ClinicsReturn_fulfilled_not_origin_check"
    CHECK ("fulfilledByAttendanceId" IS NULL OR "originAttendanceId" IS NULL
      OR "fulfilledByAttendanceId" <> "originAttendanceId");

-- O retorno (ADR-048 adendo 7, F3.2):
--  - NASCE pendente, sem agendamento, sem encerramento;
--  - paciente, serviço, unidade, origem, vencimento, autoria e criação são
--    IMUTÁVEIS; encerrado (`done` ou `canceled`) não muda mais;
--  - um vínculo NOVO exige agendamento marcado, confirmado, com chegada ou
--    atendido, QUALQUER que seja o início (a regra temporal é sobre o registro,
--    e o início variável não sonda a criação, que não é projetada); PENDENTE nunca
--    aponta para agendamento já atendido: o vínculo a um atendido conclui na
--    mesma instrução;
--  - CONCLUIR exige a prova registrada DEPOIS da criação do retorno (os dois
--    instantes são do relógio do banco): um atendimento anterior à existência
--    do retorno, inclusive o que o gerou, não o cumpre. Comprova a ordem dos
--    REGISTROS, não a da visita física (hipótese do protótipo);
--  - a criação e o encerramento são escritos pelo relógio do banco.
CREATE OR REPLACE FUNCTION "clinics_return_guard"() RETURNS trigger AS $$
DECLARE
  estado "ClinicsAppointmentStatus";
  registrado TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'pending' OR NEW."appointmentId" IS NOT NULL OR NEW."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Retorno nasce pendente e sem agendamento'
        USING ERRCODE = 'check_violation';
    END IF;
    -- a criação é sempre do relógio do banco: as regras de tempo dependem dela
    NEW."createdAt" := transaction_timestamp();
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."patientId" <> OLD."patientId"
     OR NEW."serviceId" <> OLD."serviceId"
     OR NEW."unitId" <> OLD."unitId"
     OR NEW."originAttendanceId" IS DISTINCT FROM OLD."originAttendanceId"
     OR NEW."dueDate" <> OLD."dueDate"
     OR NEW."createdByMembershipId" <> OLD."createdByMembershipId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Paciente, serviço, unidade, origem, vencimento e criação do retorno são imutáveis'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'Retorno encerrado (%) não muda mais', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."appointmentId" IS NOT NULL AND NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId" THEN
    SELECT a."status" INTO estado
      FROM "ClinicsAppointment" a
     WHERE a."workspaceId" = NEW."workspaceId" AND a."id" = NEW."appointmentId";
    IF estado IS NULL
       OR estado NOT IN ('scheduled', 'confirmed', 'arrived', 'attended')
       OR (estado = 'attended' AND NEW."status" = 'pending') THEN
      RAISE EXCEPTION 'Este agendamento não pode cumprir este retorno'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" = 'done' THEN
    SELECT a."recordedAt" INTO registrado
      FROM "ClinicsAttendance" a
     WHERE a."workspaceId" = NEW."workspaceId" AND a."id" = NEW."fulfilledByAttendanceId";
    IF registrado IS NULL OR registrado <= NEW."createdAt" THEN
      RAISE EXCEPTION 'Este agendamento não pode cumprir este retorno'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" <> 'pending' THEN
    NEW."closedAt" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsReturn_guard"
  BEFORE INSERT OR UPDATE ON "ClinicsReturn"
  FOR EACH ROW EXECUTE FUNCTION "clinics_return_guard"();

-- POR ÚLTIMO, as instruções que pedem lock EXCLUSIVO em tabela existente: ele
-- fica preso só até o COMMIT, sem atravessar as esperas acima.
-- O intervalo do retorno automático: de 1 a 365 dias, ou nenhum.
ALTER TABLE "ClinicsService" ADD COLUMN "returnIntervalDays" INTEGER;
ALTER TABLE "ClinicsService" ADD CONSTRAINT "ClinicsService_returnIntervalDays_check"
  CHECK ("returnIntervalDays" IS NULL OR "returnIntervalDays" BETWEEN 1 AND 365);

-- O instante do registro de atendimento pelo relógio do banco. O default é
-- VOLÁTIL: reescreve a tabela, e os registros já existentes ficam com o
-- instante desta migration, anterior à criação de qualquer retorno.
ALTER TABLE "ClinicsAttendance" ADD COLUMN "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp();

-- A prova não se forja: o `recordedAt` é sempre o relógio do banco no INSERT e
-- nunca muda depois. É `clock_timestamp()`, e não o `transaction_timestamp()`
-- do ADR-049, porque o registro pode ESPERAR a trava do agendamento: o
-- instante que vale é o de depois da espera. (Gatilho próprio: a função da
-- F3.1, já publicada, não é editada.)
CREATE OR REPLACE FUNCTION "clinics_attendance_recorded_at"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."recordedAt" := clock_timestamp();
  ELSIF NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt" THEN
    RAISE EXCEPTION 'O instante do registro de atendimento não muda'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAttendance_recorded_at"
  BEFORE INSERT OR UPDATE ON "ClinicsAttendance"
  FOR EACH ROW EXECUTE FUNCTION "clinics_attendance_recorded_at"();

COMMIT;

-- Veyra Clinics — correção de um consumo de pacote registrado por engano (F5.2a,
-- ADR-059). Acrescenta:
--  - o enum do motivo e a tabela `ClinicsPackageCorrection`, nova e vazia, só de
--    acréscimo;
--  - em `ClinicsAttendance`, o consumo VIGENTE (`currentPackageId`), preenchido
--    aqui com a escolha do registro, e a revisão do consumo (`consumptionRevision`,
--    0 em todos);
--  - os gatilhos: a correção avança o vigente e a revisão; nada mais os muda; o
--    atendimento não é apagado (salvo a cascata do workspace); o pacote aceita
--    a devolução de uma sessão; e a igualdade "consumidas = atendimentos com o
--    consumo vigente no pacote", conferida no COMMIT.
-- Altera dois objetos existentes, pelo `CREATE OR REPLACE`: as funções
-- `clinics_package_guard` (a devolução) e `clinics_attendance_package_is_final`
-- (o vigente só pela correção). Toda FK é COMPOSTA por (workspaceId, …), com NO
-- ACTION; só a do workspace é em cascata.
--
-- TRANSAÇÃO EXPLÍCITA (ADR-051): ou tudo, ou nada.
--
-- Os locks, todos presos até o COMMIT: ACCESS EXCLUSIVE em `ClinicsAttendance`
-- (as colunas), SHARE em `ClinicsPackage` (o índice único) e SHARE ROW EXCLUSIVE
-- nas tabelas referidas pelas FKs e nas que ganham gatilho (`ClinicsPackage`,
-- `ClinicsAttendance`, `ClinicsAppointment`, `Membership` e `Workspace`). O
-- `lock_timeout` de 5 s vale POR lock: o pior caso soma cinco esperas, cerca de
-- 25 s, mais a execução (o preenchimento e o índice percorrem `ClinicsAttendance`
-- e `ClinicsPackage`, tabelas pequenas). É estimativa, não limite.
--
-- PARA SOZINHA se algum pacote já tiver o contador divergente dos atendimentos
-- que o consomem: a igualdade conferida no COMMIT faria toda escrita nele falhar
-- depois. O DEPLOY_STAGING §7.1 tem a consulta de conferência.
--
-- Se falhar: a transação volta inteira, e o Prisma mostra só "current
-- transaction is aborted"; a causa está no log do Postgres. NÃO marque
-- rolled-back às cegas: o inventário do DEPLOY_STAGING §4 precisa dar zero
-- antes do `migrate resolve --rolled-back` e da repetição.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsPackageCorrectionReason" AS ENUM ('wrong_choice', 'package_registered_late');

-- AlterTable
ALTER TABLE "ClinicsAttendance" ADD COLUMN     "consumptionRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentPackageId" UUID;

-- O consumo vigente dos atendimentos existentes é a escolha do registro. Vem
-- ANTES dos gatilhos novos: o guarda de hoje só confere o `packageId`, que não
-- muda aqui
UPDATE "ClinicsAttendance" SET "currentPackageId" = "packageId" WHERE "packageId" IS NOT NULL;

-- A igualdade já precisa valer, ou a migration para (cabeçalho)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ClinicsPackage" p
     WHERE p."consumedSessions" <> (SELECT count(*) FROM "ClinicsAttendance" a
                                     WHERE a."workspaceId" = p."workspaceId"
                                       AND a."currentPackageId" = p."id")
  ) THEN
    RAISE EXCEPTION 'Há pacote com o contador divergente dos atendimentos: a migration parou (DEPLOY_STAGING §7.1)';
  END IF;
END $$;

-- CreateTable
CREATE TABLE "ClinicsPackageCorrection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "attendanceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "fromPackageId" UUID,
    "toPackageId" UUID,
    "revision" INTEGER NOT NULL,
    "reason" "ClinicsPackageCorrectionReason" NOT NULL,
    "correctedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ClinicsPackageCorrection_pkey" PRIMARY KEY ("id")
);

-- uma correção MUDA o consumo; a revisão começa em 1; o pacote cadastrado
-- depois só vale de avulso para pacote
ALTER TABLE "ClinicsPackageCorrection"
  ADD CONSTRAINT "ClinicsPackageCorrection_change_check"
    CHECK ("fromPackageId" IS DISTINCT FROM "toPackageId"),
  ADD CONSTRAINT "ClinicsPackageCorrection_revision_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "ClinicsPackageCorrection_late_check" CHECK (
    "reason" <> 'package_registered_late'
    OR ("fromPackageId" IS NULL AND "toPackageId" IS NOT NULL)
  );

-- CreateIndex
CREATE INDEX "ClinicsPackageCorrection_workspaceId_appointmentId_patientI_idx" ON "ClinicsPackageCorrection"("workspaceId", "appointmentId", "patientId", "serviceId", "unitId");

-- CreateIndex
CREATE INDEX "ClinicsPackageCorrection_workspaceId_fromPackageId_idx" ON "ClinicsPackageCorrection"("workspaceId", "fromPackageId");

-- CreateIndex
CREATE INDEX "ClinicsPackageCorrection_workspaceId_toPackageId_idx" ON "ClinicsPackageCorrection"("workspaceId", "toPackageId");

-- CreateIndex
CREATE INDEX "ClinicsPackageCorrection_workspaceId_correctedByMembershipI_idx" ON "ClinicsPackageCorrection"("workspaceId", "correctedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackageCorrection_workspaceId_id_key" ON "ClinicsPackageCorrection"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackageCorrection_workspaceId_attendanceId_revision_key" ON "ClinicsPackageCorrection"("workspaceId", "attendanceId", "revision");

-- CreateIndex
CREATE INDEX "ClinicsAttendance_workspaceId_currentPackageId_idx" ON "ClinicsAttendance"("workspaceId", "currentPackageId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackage_correction_key" ON "ClinicsPackage"("workspaceId", "id", "patientId", "serviceId");

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_currentPackageId_fkey" FOREIGN KEY ("workspaceId", "currentPackageId") REFERENCES "ClinicsPackage"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_appointmentId_attenda_fkey" FOREIGN KEY ("workspaceId", "appointmentId", "attendanceId") REFERENCES "ClinicsAttendance"("workspaceId", "appointmentId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_appointmentId_patient_fkey" FOREIGN KEY ("workspaceId", "appointmentId", "patientId", "serviceId", "unitId") REFERENCES "ClinicsAppointment"("workspaceId", "id", "patientId", "serviceId", "unitId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_fromPackageId_patient_fkey" FOREIGN KEY ("workspaceId", "fromPackageId", "patientId", "serviceId") REFERENCES "ClinicsPackage"("workspaceId", "id", "patientId", "serviceId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_toPackageId_patientId_fkey" FOREIGN KEY ("workspaceId", "toPackageId", "patientId", "serviceId") REFERENCES "ClinicsPackage"("workspaceId", "id", "patientId", "serviceId") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackageCorrection" ADD CONSTRAINT "ClinicsPackageCorrection_workspaceId_correctedByMembership_fkey" FOREIGN KEY ("workspaceId", "correctedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- O atendimento NASCE com o consumo vigente igual à escolha e a revisão 0,
-- quem quer que o insira (inclusive o código anterior a esta migration, que não
-- conhece as colunas)
CREATE OR REPLACE FUNCTION "clinics_attendance_consumption_init"() RETURNS trigger AS $$
BEGIN
  NEW."currentPackageId" := NEW."packageId";
  NEW."consumptionRevision" := 0;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAttendance_consumption_init"
  BEFORE INSERT ON "ClinicsAttendance"
  FOR EACH ROW EXECUTE FUNCTION "clinics_attendance_consumption_init"();

-- A escolha do registro continua IMUTÁVEL. O consumo vigente e a revisão só
-- mudam pelo gatilho da correção (abaixo), e só para o que uma correção JÁ
-- INSERIDA registra: a da revisão nova, saindo do vigente antigo para o novo.
-- As duas conferências se somam: o gatilho da correção roda no nível 2 de
-- gatilhos (uma instrução do cliente roda no nível 1), e nenhum outro gatilho
-- move o consumo sem a linha da correção. A revisão avança de uma em uma
CREATE OR REPLACE FUNCTION "clinics_attendance_package_is_final"() RETURNS trigger AS $$
BEGIN
  IF NEW."packageId" IS DISTINCT FROM OLD."packageId" THEN
    RAISE EXCEPTION 'O pacote de um atendimento não muda depois do registro'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currentPackageId" IS DISTINCT FROM OLD."currentPackageId"
     OR NEW."consumptionRevision" <> OLD."consumptionRevision" THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'O consumo de um atendimento só muda por uma correção registrada'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."consumptionRevision" <> OLD."consumptionRevision" + 1 THEN
      RAISE EXCEPTION 'A revisão do consumo avança de uma em uma'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "ClinicsPackageCorrection" c
       WHERE c."workspaceId" = NEW."workspaceId"
         AND c."attendanceId" = NEW."id"
         AND c."revision" = NEW."consumptionRevision"
         AND c."fromPackageId" IS NOT DISTINCT FROM OLD."currentPackageId"
         AND c."toPackageId" IS NOT DISTINCT FROM NEW."currentPackageId"
    ) THEN
      RAISE EXCEPTION 'O consumo de um atendimento só muda por uma correção registrada'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- O atendimento NUNCA é apagado: a escolha original e a contagem do pacote
-- dependem dele, e a igualdade no COMMIT não vê exclusão. Só a cascata da
-- exclusão do workspace passa (ela roda depois de a linha do workspace sumir)
CREATE OR REPLACE FUNCTION "clinics_attendance_is_kept"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Um registro de atendimento não é apagado'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAttendance_is_kept"
  BEFORE DELETE ON "ClinicsAttendance"
  FOR EACH ROW EXECUTE FUNCTION "clinics_attendance_is_kept"();

-- A criação do pacote é carimbada pelo BANCO: o Prisma manda o `createdAt` no
-- INSERT, pelo relógio do Node (conferido no log do Postgres, ADR-059). O motivo
-- "pacote cadastrado depois" compara este instante com o `recordedAt` do
-- atendimento, também do banco: o mesmo relógio nos dois lados (ADR-049). É a
-- mesma exceção do `recordedAt` da F3.2: `clock_timestamp()`, e não o início da
-- transação, para os dois lados da comparação usarem o mesmo relógio. A coluna
-- é `timestamp` sem fuso, em UTC
CREATE OR REPLACE FUNCTION "clinics_package_created_at"() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackage_created_stamp"
  BEFORE INSERT ON "ClinicsPackage"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_created_at"();

-- A CORREÇÃO: trava o atendimento, confere que ela parte da revisão e do
-- consumo vigentes, e os avança. Roda DEPOIS da inserção: só a linha de fato
-- inserida move o consumo — uma inserção descartada (`ON CONFLICT DO NOTHING`)
-- não dispara nada. O pacote cadastrado depois exige um pacote criado depois do
-- REGISTRO do atendimento, os dois pelo relógio do banco (acima)
CREATE OR REPLACE FUNCTION "clinics_package_correction_apply"() RETURNS trigger AS $$
DECLARE
  atual RECORD;
  pacote_criado TIMESTAMP(3);
BEGIN
  SELECT "currentPackageId", "consumptionRevision", "recordedAt" INTO atual
    FROM "ClinicsAttendance"
   WHERE "workspaceId" = NEW."workspaceId" AND "id" = NEW."attendanceId"
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atendimento da correção não encontrado'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NEW."revision" <> atual."consumptionRevision" + 1 THEN
    RAISE EXCEPTION 'A correção não parte da revisão vigente do consumo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."fromPackageId" IS DISTINCT FROM atual."currentPackageId" THEN
    RAISE EXCEPTION 'A correção não parte do consumo vigente'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."reason" = 'package_registered_late' THEN
    SELECT "createdAt" INTO pacote_criado FROM "ClinicsPackage"
     WHERE "workspaceId" = NEW."workspaceId" AND "id" = NEW."toPackageId";
    IF pacote_criado IS NULL OR (pacote_criado AT TIME ZONE 'UTC') <= atual."recordedAt" THEN
      RAISE EXCEPTION 'O pacote já existia no registro do atendimento'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  UPDATE "ClinicsAttendance"
     SET "currentPackageId" = NEW."toPackageId", "consumptionRevision" = NEW."revision"
   WHERE "workspaceId" = NEW."workspaceId" AND "id" = NEW."attendanceId";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackageCorrection_apply"
  AFTER INSERT ON "ClinicsPackageCorrection"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_correction_apply"();

-- O instante da correção é do banco, quem quer que a insira (ADR-049)
CREATE OR REPLACE FUNCTION "clinics_package_correction_stamp"() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := transaction_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackageCorrection_stamp"
  BEFORE INSERT ON "ClinicsPackageCorrection"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_correction_stamp"();

-- A correção é IMUTÁVEL: nunca alterada, e só apagada junto do workspace. A
-- única passagem é o DELETE da cascata, que roda depois de a linha do
-- workspace sumir; todo o resto é recusado
CREATE OR REPLACE FUNCTION "clinics_package_correction_is_final"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Uma correção de consumo não muda nem é apagada'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackageCorrection_is_final"
  BEFORE UPDATE OR DELETE ON "ClinicsPackageCorrection"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_correction_is_final"();

-- O guarda do pacote, com a DEVOLUÇÃO de uma sessão (ADR-059): a correção a
-- devolve ao pacote ativo (que continua ativo), ao concluído (que volta a ativo,
-- sem encerramento) e ao cancelado (que continua cancelado). Que a devolução
-- corresponda a uma sessão de fato devolvida, a igualdade no COMMIT confere. O
-- resto é o de antes (F3.1):
--  - nasce ativo, com zero consumidas;
--  - paciente, serviço, total, preço, moeda, criador e criação são imutáveis;
--  - o consumo sobe de um em um, só com o pacote ativo, e a última sessão o
--    passa a `completed` na mesma instrução;
--  - o cancelamento muda só o estado;
--  - fora da devolução, o pacote encerrado não muda mais.
CREATE OR REPLACE FUNCTION "clinics_package_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedSessions" <> 0 OR NEW."status" <> 'active' OR NEW."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Pacote nasce ativo, com zero sessões consumidas'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."patientId" <> OLD."patientId"
     OR NEW."serviceId" <> OLD."serviceId"
     OR NEW."totalSessions" <> OLD."totalSessions"
     OR NEW."totalPriceCents" IS DISTINCT FROM OLD."totalPriceCents"
     OR NEW."currency" <> OLD."currency"
     OR NEW."createdByMembershipId" <> OLD."createdByMembershipId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Paciente, serviço, total, preço e moeda do pacote são imutáveis'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."consumedSessions" = OLD."consumedSessions" - 1 THEN
    -- a devolução não escolhe o estado: ele segue a regra abaixo
    IF NEW."status" <> OLD."status" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
      RAISE EXCEPTION 'A devolução de uma sessão não muda o estado por conta própria'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'completed' THEN
      NEW."status" := 'active';
      NEW."closedAt" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" <> 'active' THEN
    RAISE EXCEPTION 'Pacote encerrado (%) não muda mais', OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."consumedSessions" = OLD."consumedSessions" + 1 THEN
    -- o consumo: o estado só pode ficar ativo (o trigger decide a conclusão)
    IF NEW."status" <> 'active' THEN
      RAISE EXCEPTION 'O consumo não muda o estado por conta própria'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."consumedSessions" = NEW."totalSessions" THEN
      NEW."status" := 'completed';
      NEW."closedAt" := now();
    ELSE
      NEW."closedAt" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."consumedSessions" = OLD."consumedSessions" THEN
    -- sem incremento: só o cancelamento
    IF NEW."status" = 'canceled' THEN
      NEW."closedAt" := now();
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Sem consumo, o pacote só pode ser cancelado'
      USING ERRCODE = 'check_violation';
  END IF;

  RAISE EXCEPTION 'As sessões consumidas só mudam de uma em uma: o registro consome, a correção devolve'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- A IGUALDADE, conferida no COMMIT: as consumidas de cada pacote tocado na
-- transação são o número de atendimentos com o consumo vigente nele. Vale para
-- os três caminhos (o registro, o cancelamento e a correção) e para qualquer
-- inserção ou alteração fora deles; a exclusão de atendimento é recusada antes
-- (`ClinicsAttendance_is_kept`). Pacote que não existe mais (a cascata do workspace) não
-- tem o que conferir
CREATE OR REPLACE FUNCTION "clinics_package_counter_matches"(ws UUID, pacote UUID) RETURNS void AS $$
DECLARE
  consumidas INTEGER;
  vigentes INTEGER;
BEGIN
  IF pacote IS NULL THEN
    RETURN;
  END IF;
  -- uma instrução só: o contador e a contagem vêm do MESMO instante
  SELECT p."consumedSessions",
         (SELECT count(*) FROM "ClinicsAttendance" a
           WHERE a."workspaceId" = ws AND a."currentPackageId" = pacote)
    INTO consumidas, vigentes
    FROM "ClinicsPackage" p
   WHERE p."workspaceId" = ws AND p."id" = pacote;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF consumidas <> vigentes THEN
    RAISE EXCEPTION 'As sessões consumidas do pacote % (%) não batem com os atendimentos que o consomem (%)',
      pacote, consumidas, vigentes
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "clinics_package_counter_on_package"() RETURNS trigger AS $$
BEGIN
  PERFORM "clinics_package_counter_matches"(NEW."workspaceId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- no atendimento, só o que muda a contagem: a inserção, e a alteração que
-- troca o consumo vigente (as duas pontas)
CREATE OR REPLACE FUNCTION "clinics_package_counter_on_attendance"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "clinics_package_counter_matches"(NEW."workspaceId", NEW."currentPackageId");
  ELSIF OLD."currentPackageId" IS DISTINCT FROM NEW."currentPackageId" THEN
    PERFORM "clinics_package_counter_matches"(NEW."workspaceId", NEW."currentPackageId");
    PERFORM "clinics_package_counter_matches"(OLD."workspaceId", OLD."currentPackageId");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ClinicsPackage_counter_matches"
  AFTER INSERT OR UPDATE ON "ClinicsPackage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_counter_on_package"();

CREATE CONSTRAINT TRIGGER "ClinicsAttendance_counter_matches"
  AFTER INSERT OR UPDATE ON "ClinicsAttendance"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_counter_on_attendance"();

COMMIT;

-- Veyra Clinics — pacote de sessões e consumo no registro de atendimento (F3.1,
-- ADR-048 adendo 7). Só ACRESCENTA: um enum, uma tabela nova e vazia, uma
-- coluna anulável em `ClinicsAttendance` e as regras abaixo. Toda FK é COMPOSTA
-- por (workspaceId, id) (ADR-010), com NO ACTION (nada disso é apagado por
-- exclusão; só a do workspace, em cascata, como no resto do vertical).
--
-- TRANSAÇÃO EXPLÍCITA. O `prisma migrate deploy` executa a migration instrução
-- por instrução, sem transação: uma falha no meio deixava o que veio antes
-- (ensaio de 2026-10-21, ADR-048 adendo 7). Aqui, ou tudo, ou nada.
--
-- Os `ADD FOREIGN KEY` pedem SHARE ROW EXCLUSIVE nas tabelas referenciadas
-- (`Workspace` e `Membership` são do Core e muito escritas). Melhor falhar em
-- 5 s do que enfileirar as escritas da aplicação; o `SET LOCAL` vale só até o
-- fim da transação. O `lock_timeout` vale POR lock, e a transação segura os
-- locks obtidos até o COMMIT: o pior caso soma as esperas (até ~20 s, com
-- `ClinicsAttendance` bloqueada desde o `ADD COLUMN`). Por isso ela roda em
-- manutenção, sem acesso externo e com os jobs desligados (DEPLOY_STAGING §4).
--
-- Se falhar: a transação volta inteira, e o Prisma mostra só "current
-- transaction is aborted"; a causa está no log do Postgres. NÃO marque
-- rolled-back às cegas: o inventário do DEPLOY_STAGING §4 precisa dar zero
-- antes do `migrate resolve --rolled-back` e da repetição.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsPackageStatus" AS ENUM ('active', 'completed', 'canceled');

-- AlterTable
ALTER TABLE "ClinicsAttendance" ADD COLUMN     "packageId" UUID;

-- CreateTable
CREATE TABLE "ClinicsPackage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "totalSessions" INTEGER NOT NULL,
    "consumedSessions" INTEGER NOT NULL DEFAULT 0,
    "totalPriceCents" INTEGER,
    "currency" TEXT NOT NULL,
    "status" "ClinicsPackageStatus" NOT NULL DEFAULT 'active',
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ClinicsPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsPackage_workspaceId_patientId_idx" ON "ClinicsPackage"("workspaceId", "patientId");

-- CreateIndex
CREATE INDEX "ClinicsPackage_workspaceId_serviceId_idx" ON "ClinicsPackage"("workspaceId", "serviceId");

-- CreateIndex
CREATE INDEX "ClinicsPackage_workspaceId_createdByMembershipId_idx" ON "ClinicsPackage"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackage_workspaceId_id_key" ON "ClinicsPackage"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsAttendance_workspaceId_packageId_idx" ON "ClinicsAttendance"("workspaceId", "packageId");

-- AddForeignKey
ALTER TABLE "ClinicsAttendance" ADD CONSTRAINT "ClinicsAttendance_workspaceId_packageId_fkey" FOREIGN KEY ("workspaceId", "packageId") REFERENCES "ClinicsPackage"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackage" ADD CONSTRAINT "ClinicsPackage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsPackage" ADD CONSTRAINT "ClinicsPackage_workspaceId_patientId_fkey" FOREIGN KEY ("workspaceId", "patientId") REFERENCES "ClinicsPatient"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackage" ADD CONSTRAINT "ClinicsPackage_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "ClinicsService"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackage" ADD CONSTRAINT "ClinicsPackage_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Intervalos permitidos (o CHECK garante o INTERVALO; a igualdade "consumidas
-- = atendimentos vinculados" vem do caminho único de escrita e dos triggers).
ALTER TABLE "ClinicsPackage"
  ADD CONSTRAINT "ClinicsPackage_totalSessions_check" CHECK ("totalSessions" BETWEEN 1 AND 100),
  ADD CONSTRAINT "ClinicsPackage_consumedSessions_check"
    CHECK ("consumedSessions" >= 0 AND "consumedSessions" <= "totalSessions"),
  ADD CONSTRAINT "ClinicsPackage_totalPriceCents_check"
    CHECK ("totalPriceCents" IS NULL OR "totalPriceCents" >= 0),
  -- ativo só com saldo; concluído exatamente no total
  ADD CONSTRAINT "ClinicsPackage_status_check" CHECK (
    ("status" = 'active' AND "consumedSessions" < "totalSessions" AND "closedAt" IS NULL)
    OR ("status" = 'completed' AND "consumedSessions" = "totalSessions" AND "closedAt" IS NOT NULL)
    OR ("status" = 'canceled' AND "closedAt" IS NOT NULL)
  );

-- O pacote (ADR-048 adendo 7, F3.1):
--  - NASCE ativo, com zero consumidas e sem encerramento;
--  - paciente, serviço, total, preço, moeda, autoria e criação são IMUTÁVEIS;
--  - só dois caminhos mudam a linha, e só com o pacote ATIVO:
--    * o CONSUMO: consumidas + 1, sem mais nada. Na última sessão, a MESMA
--      instrução o passa a `completed`, com o encerramento pelo relógio do banco;
--    * o CANCELAMENTO: só o estado, de `active` para `canceled`, sem incremento;
--  - pacote encerrado não muda mais.
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

  RAISE EXCEPTION 'As sessões consumidas só crescem de uma em uma, pelo registro de atendimento'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackage_guard"
  BEFORE INSERT OR UPDATE ON "ClinicsPackage"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_guard"();

-- O vínculo do atendimento com o pacote é IMUTÁVEL: nasce com o atendimento (ou
-- nunca). Trocar, acrescentar ou tirar quebraria a igualdade com o contador.
CREATE OR REPLACE FUNCTION "clinics_attendance_package_is_final"() RETURNS trigger AS $$
BEGIN
  IF NEW."packageId" IS DISTINCT FROM OLD."packageId" THEN
    RAISE EXCEPTION 'O pacote de um atendimento não muda depois do registro'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAttendance_package_is_final"
  BEFORE UPDATE ON "ClinicsAttendance"
  FOR EACH ROW EXECUTE FUNCTION "clinics_attendance_package_is_final"();

COMMIT;

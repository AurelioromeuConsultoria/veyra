-- F4.3 (ADR-048 adendos 8 e 10; decisões do usuário de 2026-10-28): o
-- instante da confirmação do agendamento e o vínculo do agendamento com um
-- deal do Core.
--
-- O que faz, numa transação só (ADR-051):
--   1. as colunas "confirmedAt" e "confirmationTracked" no agendamento, e a
--      marca dos que JÁ EXISTEM fora de `scheduled`: a confirmação deles é
--      desconhecida, e nenhuma data é inventada (a métrica mostra a
--      cobertura parcial). O que está em `scheduled` não tem confirmação
--      vigente e passa a ser rastreado;
--   2. o gatilho "ClinicsAppointment_confirmation": só ele escreve as duas
--      colunas — na transição para `confirmed`, o `now()` do banco; na volta a
--      `scheduled` (a remarcação), nulo; chegou, atendido e falta não apagam;
--   3. a tabela "ClinicsAppointmentDeal": um deal por agendamento, FKs
--      compostas `NO ACTION` (excluir o deal vinculado dá o 409 genérico do
--      Core; a cascata da exclusão do workspace passa, porque `NO ACTION` é
--      conferida no fim da instrução);
--   4. o gatilho "ClinicsAppointmentDeal_guard": o vínculo não muda depois do
--      atendimento, e o agendamento do vínculo é imutável; a exclusão do
--      workspace o leva.
--
-- Locks: o ADD COLUMN com DEFAULT constante é só de catálogo, mas pega ACCESS
-- EXCLUSIVE em "ClinicsAppointment" até o COMMIT, e o UPDATE da marca percorre
-- a tabela (a agenda de uma clínica, pequena): nesse tempo, a agenda espera. As
-- FKs da tabela nova pegam SHARE ROW EXCLUSIVE em "ClinicsAppointment", "Deal",
-- "Membership" e "Workspace". Espera por lock limitada a 5 s por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ClinicsAppointment" ADD COLUMN     "confirmationTracked" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "confirmedAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "ClinicsAppointmentDeal" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "dealId" UUID NOT NULL,
    "linkedByMembershipId" UUID NOT NULL,
    "linkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ClinicsAppointmentDeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsAppointmentDeal_workspaceId_dealId_idx" ON "ClinicsAppointmentDeal"("workspaceId", "dealId");

-- CreateIndex
CREATE INDEX "ClinicsAppointmentDeal_workspaceId_linkedByMembershipId_idx" ON "ClinicsAppointmentDeal"("workspaceId", "linkedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAppointmentDeal_workspaceId_id_key" ON "ClinicsAppointmentDeal"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsAppointmentDeal_workspaceId_appointmentId_key" ON "ClinicsAppointmentDeal"("workspaceId", "appointmentId");

-- AddForeignKey
ALTER TABLE "ClinicsAppointmentDeal" ADD CONSTRAINT "ClinicsAppointmentDeal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsAppointmentDeal" ADD CONSTRAINT "ClinicsAppointmentDeal_appointment_fkey" FOREIGN KEY ("workspaceId", "appointmentId") REFERENCES "ClinicsAppointment"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointmentDeal" ADD CONSTRAINT "ClinicsAppointmentDeal_deal_fkey" FOREIGN KEY ("workspaceId", "dealId") REFERENCES "Deal"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsAppointmentDeal" ADD CONSTRAINT "ClinicsAppointmentDeal_linkedBy_fkey" FOREIGN KEY ("workspaceId", "linkedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- os agendamentos que já existem fora de `scheduled`: a confirmação é
-- desconhecida (sem data inventada)
UPDATE "ClinicsAppointment" SET "confirmationTracked" = false WHERE "status" <> 'scheduled';

-- O instante da confirmação: só este gatilho escreve as duas colunas.
CREATE OR REPLACE FUNCTION "clinics_appointment_confirmation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."confirmedAt" := CASE WHEN NEW."status" = 'confirmed' THEN now() ELSE NULL END;
    NEW."confirmationTracked" := true;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'scheduled' THEN
    -- a remarcação volta a `scheduled`: a confirmação era do horário antigo
    NEW."confirmedAt" := NULL;
    NEW."confirmationTracked" := true;
  ELSIF NEW."status" = 'confirmed' AND OLD."status" IS DISTINCT FROM 'confirmed' THEN
    NEW."confirmedAt" := now();
    NEW."confirmationTracked" := true;
  ELSE
    -- chegou, atendido, falta e qualquer outra mudança: inalterados
    NEW."confirmedAt" := OLD."confirmedAt";
    NEW."confirmationTracked" := OLD."confirmationTracked";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAppointment_confirmation"
  BEFORE INSERT OR UPDATE ON "ClinicsAppointment"
  FOR EACH ROW EXECUTE FUNCTION "clinics_appointment_confirmation"();

-- O vínculo com o deal: não muda depois do atendimento; o agendamento dele é
-- imutável; o instante é do banco. A exclusão do workspace (LGPD) o leva:
-- quando ela chega aqui, o workspace já saiu.
CREATE OR REPLACE FUNCTION "clinics_appointment_deal_guard"() RETURNS trigger AS $$
DECLARE
  agendamento UUID;
  area UUID;
  situacao "ClinicsAppointmentStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "Workspace" w WHERE w."id" = OLD."workspaceId") THEN
      RETURN OLD;
    END IF;
    agendamento := OLD."appointmentId";
    area := OLD."workspaceId";
  ELSE
    IF TG_OP = 'UPDATE' AND (NEW."workspaceId" <> OLD."workspaceId" OR NEW."appointmentId" <> OLD."appointmentId") THEN
      RAISE EXCEPTION 'O agendamento do vínculo é imutável'
        USING ERRCODE = 'check_violation';
    END IF;
    agendamento := NEW."appointmentId";
    area := NEW."workspaceId";
    NEW."linkedAt" := transaction_timestamp();
  END IF;
  -- a linha do agendamento TRAVADA sem condição, no mesmo modo do UPDATE do
  -- atendimento: um atendimento em curso termina antes, e o atendido é visto
  -- depois. (Com o estado no WHERE, a linha ainda não atendida não seria
  -- travada.) O serviço já segura essa trava, e a cascata saiu antes
  SELECT a."status" INTO situacao FROM "ClinicsAppointment" a
   WHERE a."workspaceId" = area AND a."id" = agendamento
   FOR NO KEY UPDATE;
  IF situacao = 'attended' THEN
    RAISE EXCEPTION 'O vínculo com o deal não muda depois do atendimento'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsAppointmentDeal_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ClinicsAppointmentDeal"
  FOR EACH ROW EXECUTE FUNCTION "clinics_appointment_deal_guard"();

COMMIT;

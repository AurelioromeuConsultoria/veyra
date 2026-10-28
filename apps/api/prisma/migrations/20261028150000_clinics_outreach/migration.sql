-- F4.2, a parte do Clinics (ADR-048 adendos 8 e 9; decisões do usuário de
-- 2026-10-28): o pedido de envio da clínica, origem do envio iniciado pelo
-- negócio no Core (`clinics.outreach:<id>`).
--
-- O que faz, numa transação só (ADR-051), só com objetos NOVOS:
--   1. o enum "ClinicsOutreachKind" e a tabela "ClinicsOutreachRequest", com
--      as FKs compostas para o agendamento, o retorno e quem criou;
--   2. os únicos da marca de ativo: no máximo um pedido que conta por
--      (agendamento, início) e por retorno — a marca nula não colide;
--   3. as restrições: o alvo é o do tipo; a marca nunca é `false`; o texto
--      apagado não convive com texto;
--   4. o gatilho "ClinicsOutreachRequest_guard": o alvo e a criação são
--      imutáveis; a marca só sai e nunca volta; o texto apagado não volta; a
--      criação e o apagamento são do relógio do banco;
--   5. o gatilho "ClinicsOutreachRequest_no_delete": o pedido não é apagado,
--      salvo pela exclusão do workspace, em cascata.
-- Nada que já existe muda.
--
-- Locks: a tabela é nova. Cada FK pega SHARE ROW EXCLUSIVE na tabela
-- referenciada ("ClinicsAppointment", "ClinicsReturn", "Membership",
-- "Workspace") até o COMMIT: as escritas nelas esperam esse instante, e a
-- validação é imediata (a tabela nasce vazia). Espera por lock limitada a 5 s
-- por instrução.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsOutreachKind" AS ENUM ('confirmation', 'reactivation');

-- CreateTable
CREATE TABLE "ClinicsOutreachRequest" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "ClinicsOutreachKind" NOT NULL,
    "appointmentId" UUID,
    "startsAt" TIMESTAMPTZ(3),
    "returnId" UUID,
    "activeMark" BOOLEAN DEFAULT true,
    "renderedText" TEXT,
    "textClearedAt" TIMESTAMPTZ(3),
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ClinicsOutreachRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsOutreachRequest_workspaceId_createdByMembershipId_idx" ON "ClinicsOutreachRequest"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE INDEX "ClinicsOutreachRequest_workspaceId_createdAt_idx" ON "ClinicsOutreachRequest"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsOutreachRequest_workspaceId_id_key" ON "ClinicsOutreachRequest"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsOutreachRequest_workspaceId_appointmentId_startsAt_a_key" ON "ClinicsOutreachRequest"("workspaceId", "appointmentId", "startsAt", "activeMark");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsOutreachRequest_workspaceId_returnId_activeMark_key" ON "ClinicsOutreachRequest"("workspaceId", "returnId", "activeMark");

-- AddForeignKey
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_appointment_fkey" FOREIGN KEY ("workspaceId", "appointmentId") REFERENCES "ClinicsAppointment"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_return_fkey" FOREIGN KEY ("workspaceId", "returnId") REFERENCES "ClinicsReturn"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_createdBy_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- o alvo é o do tipo: a confirmação, o agendamento com o início fixado; a
-- reativação, o retorno
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_target_check" CHECK (
  ("kind" = 'confirmation' AND "appointmentId" IS NOT NULL AND "startsAt" IS NOT NULL AND "returnId" IS NULL)
  OR ("kind" = 'reactivation' AND "returnId" IS NOT NULL AND "appointmentId" IS NULL AND "startsAt" IS NULL)
);

-- a marca é `true` ou nula: `false` colidiria nos únicos como um pedido que conta
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_activeMark_check"
  CHECK ("activeMark" IS NOT FALSE);

-- o texto apagado não convive com texto
ALTER TABLE "ClinicsOutreachRequest" ADD CONSTRAINT "ClinicsOutreachRequest_text_check"
  CHECK ("textClearedAt" IS NULL OR "renderedText" IS NULL);

-- O gatilho do pedido:
--  - nasce contando, sem texto e sem apagamento; a criação é do relógio do banco
--    (a reativação vale 24 horas a partir dela);
--  - o alvo, quem criou e a criação são imutáveis;
--  - a marca só sai (de `true` a nula), nunca volta: um pedido que deixou de
--    contar não volta a bloquear nem a valer na porta;
--  - o texto apagado não volta, e o instante do apagamento é do banco.
CREATE OR REPLACE FUNCTION "clinics_outreach_request_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."activeMark" IS NOT TRUE OR NEW."renderedText" IS NOT NULL OR NEW."textClearedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'O pedido nasce contando, sem texto'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW."createdAt" := transaction_timestamp();
    RETURN NEW;
  END IF;

  IF NEW."id" <> OLD."id"
     OR NEW."workspaceId" <> OLD."workspaceId"
     OR NEW."kind" <> OLD."kind"
     OR NEW."appointmentId" IS DISTINCT FROM OLD."appointmentId"
     OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
     OR NEW."returnId" IS DISTINCT FROM OLD."returnId"
     OR NEW."createdByMembershipId" <> OLD."createdByMembershipId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'O alvo e a criação do pedido são imutáveis'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."activeMark" IS NULL AND NEW."activeMark" IS NOT NULL THEN
    RAISE EXCEPTION 'O pedido que deixou de contar não volta a contar'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."textClearedAt" IS NOT NULL THEN
    IF NEW."renderedText" IS NOT NULL OR NEW."textClearedAt" IS DISTINCT FROM OLD."textClearedAt" THEN
      RAISE EXCEPTION 'O texto apagado do pedido não volta'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."textClearedAt" IS NOT NULL THEN
    NEW."textClearedAt" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsOutreachRequest_guard"
  BEFORE INSERT OR UPDATE ON "ClinicsOutreachRequest"
  FOR EACH ROW EXECUTE FUNCTION "clinics_outreach_request_guard"();

-- O pedido não é apagado: apagar um enviado ou incerto liberaria o alvo e
-- contornaria o "bloqueia para sempre" (C5), porque o pedido novo é outra
-- origem no Core. Só a exclusão do workspace (LGPD) o leva, em cascata: quando
-- ela chega aqui, o workspace já saiu.
CREATE OR REPLACE FUNCTION "clinics_outreach_request_no_delete"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Workspace" w WHERE w."id" = OLD."workspaceId") THEN
    RAISE EXCEPTION 'O pedido de envio não é apagado'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsOutreachRequest_no_delete"
  BEFORE DELETE ON "ClinicsOutreachRequest"
  FOR EACH ROW EXECUTE FUNCTION "clinics_outreach_request_no_delete"();

COMMIT;

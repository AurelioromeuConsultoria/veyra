-- Veyra Clinics — pagamentos de pacotes (F6.1a, ADR-063; fecha a D1 do
-- ADR-048). Só acréscimo, em objetos NOVOS:
--  - os enums da forma do recebimento e do motivo da anulação;
--  - a tabela `ClinicsPackagePayment` (o lançamento, valor em centavos > 0 por
--    CHECK) e a `ClinicsPackagePaymentVoid` (a anulação, no máximo UMA por
--    pagamento, pela única (workspaceId, paymentId)), nascendo vazias;
--  - os gatilhos: a inserção do pagamento TRAVA o pacote (FOR NO KEY UPDATE),
--    recusa o pacote cancelado, confere a moeda e não deixa a soma dos não
--    anulados passar do preço registrado; a inserção da anulação trava o
--    pacote do pagamento; o instante das duas é do banco (ADR-049); e nenhuma
--    das duas muda nem é apagada, salvo a cascata do workspace.
-- Nenhum objeto existente é alterado. Toda FK é COMPOSTA por (workspaceId, …),
-- com NO ACTION; só a do workspace é em cascata.
--
-- TRANSAÇÃO EXPLÍCITA (ADR-051): ou tudo, ou nada.
--
-- Os locks, todos presos até o COMMIT: SHARE ROW EXCLUSIVE nas tabelas
-- referidas pelas FKs novas (`Workspace`, `ClinicsPackage` e `Membership`),
-- que só bloqueia escrita nelas, e ACCESS EXCLUSIVE nas duas tabelas novas,
-- que ninguém usa ainda. O `lock_timeout` de 5 s vale POR lock: o pior caso
-- soma três esperas, cerca de 15 s, mais a execução (curta: as tabelas novas
-- estão vazias e a validação das FKs não percorre nada). É estimativa, não
-- limite.
--
-- Se falhar: a transação volta inteira, e o Prisma mostra só "current
-- transaction is aborted"; a causa está no log do Postgres. NÃO marque
-- rolled-back às cegas: o inventário do DEPLOY_STAGING §4 precisa dar zero
-- antes do `migrate resolve --rolled-back` e da repetição.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ClinicsPaymentMethod" AS ENUM ('cash', 'pix', 'debit_card', 'credit_card', 'bank_transfer', 'other');

-- CreateEnum
CREATE TYPE "ClinicsPaymentVoidReason" AS ENUM ('wrong_entry', 'wrong_amount', 'duplicate');

-- CreateTable
CREATE TABLE "ClinicsPackagePayment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "method" "ClinicsPaymentMethod" NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ClinicsPackagePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicsPackagePaymentVoid" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "reason" "ClinicsPaymentVoidReason" NOT NULL,
    "voidedByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT transaction_timestamp(),

    CONSTRAINT "ClinicsPackagePaymentVoid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicsPackagePayment_workspaceId_packageId_createdAt_idx" ON "ClinicsPackagePayment"("workspaceId", "packageId", "createdAt");

-- CreateIndex
CREATE INDEX "ClinicsPackagePayment_workspaceId_createdByMembershipId_idx" ON "ClinicsPackagePayment"("workspaceId", "createdByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackagePayment_workspaceId_id_key" ON "ClinicsPackagePayment"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ClinicsPackagePaymentVoid_workspaceId_voidedByMembershipId_idx" ON "ClinicsPackagePaymentVoid"("workspaceId", "voidedByMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackagePaymentVoid_workspaceId_id_key" ON "ClinicsPackagePaymentVoid"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicsPackagePaymentVoid_workspaceId_paymentId_key" ON "ClinicsPackagePaymentVoid"("workspaceId", "paymentId");

-- AddForeignKey
ALTER TABLE "ClinicsPackagePayment" ADD CONSTRAINT "ClinicsPackagePayment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsPackagePayment" ADD CONSTRAINT "ClinicsPackagePayment_workspaceId_packageId_fkey" FOREIGN KEY ("workspaceId", "packageId") REFERENCES "ClinicsPackage"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackagePayment" ADD CONSTRAINT "ClinicsPackagePayment_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackagePaymentVoid" ADD CONSTRAINT "ClinicsPackagePaymentVoid_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicsPackagePaymentVoid" ADD CONSTRAINT "ClinicsPackagePaymentVoid_workspaceId_paymentId_fkey" FOREIGN KEY ("workspaceId", "paymentId") REFERENCES "ClinicsPackagePayment"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ClinicsPackagePaymentVoid" ADD CONSTRAINT "ClinicsPackagePaymentVoid_workspaceId_voidedByMembershipId_fkey" FOREIGN KEY ("workspaceId", "voidedByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- o valor é sempre positivo, em centavos inteiros (ADR-063, item 1)
ALTER TABLE "ClinicsPackagePayment"
  ADD CONSTRAINT "ClinicsPackagePayment_amount_check" CHECK ("amountCents" > 0);

-- O REGISTRO do pagamento, quem quer que o insira: trava o pacote (serializa
-- com outro registro, a anulação, o consumo e o cancelamento, que pedem a
-- mesma trava de linha), recusa o pacote cancelado, confere a moeda e não deixa
-- a soma dos NÃO anulados passar do preço registrado. Sem preço, aceita. O
-- concluído aceita (o pagamento não depende das sessões). Depois da espera, a
-- linha travada é a vigente e a soma, lida numa instrução seguinte, vê o que a
-- outra transação confirmou (READ COMMITTED). O instante é do banco.
CREATE OR REPLACE FUNCTION "clinics_package_payment_guard"() RETURNS trigger AS $$
DECLARE
  pacote RECORD;
  recebido BIGINT;
BEGIN
  SELECT p."status", p."totalPriceCents", p."currency" INTO pacote
    FROM "ClinicsPackage" p
   WHERE p."workspaceId" = NEW."workspaceId" AND p."id" = NEW."packageId"
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pacote do pagamento não encontrado'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF pacote."status" = 'canceled' THEN
    RAISE EXCEPTION 'Pacote cancelado não recebe pagamento novo'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."currency" <> pacote."currency" THEN
    RAISE EXCEPTION 'O pagamento é na moeda do pacote'
      USING ERRCODE = 'check_violation';
  END IF;
  IF pacote."totalPriceCents" IS NOT NULL THEN
    SELECT COALESCE(sum(pg."amountCents"), 0) INTO recebido
      FROM "ClinicsPackagePayment" pg
     WHERE pg."workspaceId" = NEW."workspaceId" AND pg."packageId" = NEW."packageId"
       AND NOT EXISTS (SELECT 1 FROM "ClinicsPackagePaymentVoid" v
                        WHERE v."workspaceId" = pg."workspaceId" AND v."paymentId" = pg."id");
    IF recebido + NEW."amountCents" > pacote."totalPriceCents" THEN
      RAISE EXCEPTION 'O pagamento passa do preço registrado do pacote'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW."createdAt" := transaction_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackagePayment_guard"
  BEFORE INSERT ON "ClinicsPackagePayment"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_payment_guard"();

-- A ANULAÇÃO, quem quer que a insira: trava o pacote do pagamento (o mesmo
-- ponto de serialização do registro) e carimba o instante do banco. A segunda
-- anulação do mesmo pagamento é recusada pela única (workspaceId, paymentId).
-- O pacote cancelado aceita a anulação (ADR-063, item 4)
CREATE OR REPLACE FUNCTION "clinics_package_payment_void_guard"() RETURNS trigger AS $$
DECLARE
  pacote UUID;
BEGIN
  SELECT pg."packageId" INTO pacote
    FROM "ClinicsPackagePayment" pg
   WHERE pg."workspaceId" = NEW."workspaceId" AND pg."id" = NEW."paymentId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento da anulação não encontrado'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  PERFORM 1 FROM "ClinicsPackage" p
   WHERE p."workspaceId" = NEW."workspaceId" AND p."id" = pacote
   FOR NO KEY UPDATE;
  NEW."createdAt" := transaction_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackagePaymentVoid_guard"
  BEFORE INSERT ON "ClinicsPackagePaymentVoid"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_payment_void_guard"();

-- O pagamento e a anulação são IMUTÁVEIS: nunca alterados, e só apagados junto
-- do workspace. A única passagem é o DELETE da cascata, que roda depois de a
-- linha do workspace sumir; todo o resto é recusado
CREATE OR REPLACE FUNCTION "clinics_package_payment_is_final"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "Workspace" WHERE "id" = OLD."workspaceId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Um pagamento e a anulação dele não mudam nem são apagados'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ClinicsPackagePayment_is_final"
  BEFORE UPDATE OR DELETE ON "ClinicsPackagePayment"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_payment_is_final"();

CREATE TRIGGER "ClinicsPackagePaymentVoid_is_final"
  BEFORE UPDATE OR DELETE ON "ClinicsPackagePaymentVoid"
  FOR EACH ROW EXECUTE FUNCTION "clinics_package_payment_is_final"();

COMMIT;

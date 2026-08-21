-- ADR-041: `Plan.isDefault` decide o TETO de quem não tem assinatura ativa, e
-- não mais só a preferência de provisionamento. Dois planos marcados como padrão
-- — estado transitório trivial numa troca — davam limites diferentes conforme a
-- ordem que o Postgres devolvesse, e o mais generoso poderia ganhar.
--
-- Padrão TRUE/NULL da casa (Pipeline.defaultMark, Channel.systemMark): NULL não
-- colide em unique, então "no máximo um TRUE" é garantido pelo banco.

-- ORDEM IMPORTA: a coluna precisa aceitar NULL antes de receber NULL
ALTER TABLE "Plan" ALTER COLUMN "isDefault" DROP NOT NULL;
ALTER TABLE "Plan" ALTER COLUMN "isDefault" DROP DEFAULT;

-- FALSE deixa de ser representável: passa a NULL
UPDATE "Plan" SET "isDefault" = NULL WHERE "isDefault" = false;

-- e o valor FALSE fica proibido, senão a marca voltaria a admitir três estados
ALTER TABLE "Plan"
  ADD CONSTRAINT "Plan_isDefault_true_or_null"
  CHECK ("isDefault" IS NULL OR "isDefault" = TRUE);

CREATE UNIQUE INDEX "Plan_isDefault_key" ON "Plan"("isDefault");

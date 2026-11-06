-- Veyra Clinics — a unidade do recebimento no pagamento de pacote (F6.1b,
-- ADR-063 adendo 1). Só acréscimo:
--  - a coluna `ClinicsPackagePayment.unitId`, OPCIONAL: os lançamentos
--    anteriores ficam sem unidade (não registrada; o pagamento é imutável por
--    gatilho e não se preenche). O serviço grava a unidade em todo pagamento
--    novo; não há CHECK, que recusaria os registros do código anterior enquanto
--    ele ainda atende, na troca de versão (ADR-058 adendo 2);
--  - a FK COMPOSTA (workspaceId, unitId) para `ClinicsUnit`, com NO ACTION;
--  - o índice (workspaceId, unitId).
-- O `ADD COLUMN` sem DEFAULT não reescreve a tabela nem dispara os gatilhos
-- (são de INSERT, UPDATE e DELETE de linha).
--
-- TRANSAÇÃO EXPLÍCITA (ADR-051): ou tudo, ou nada.
--
-- Os locks, todos presos até o COMMIT: ACCESS EXCLUSIVE em
-- `ClinicsPackagePayment` (o ADD COLUMN; bloqueia a leitura dos pagamentos
-- pelo tempo da migration) e SHARE ROW EXCLUSIVE em `ClinicsUnit` (a FK nova;
-- só bloqueia escrita nas unidades). O `lock_timeout` de 5 s vale POR lock: o
-- pior caso soma duas esperas, cerca de 10 s, mais a execução (curta: a
-- validação da FK percorre os pagamentos, todos com `unitId` NULL, e o índice
-- é pequeno). É estimativa, não limite.
--
-- Se falhar: a transação volta inteira, e o Prisma mostra só "current
-- transaction is aborted"; a causa está no log do Postgres. NÃO marque
-- rolled-back às cegas: o inventário do DEPLOY_STAGING §4 precisa dar zero
-- antes do `migrate resolve --rolled-back` e da repetição.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "ClinicsPackagePayment" ADD COLUMN     "unitId" UUID;

-- CreateIndex
CREATE INDEX "ClinicsPackagePayment_workspaceId_unitId_idx" ON "ClinicsPackagePayment"("workspaceId", "unitId");

-- AddForeignKey
ALTER TABLE "ClinicsPackagePayment" ADD CONSTRAINT "ClinicsPackagePayment_workspaceId_unitId_fkey" FOREIGN KEY ("workspaceId", "unitId") REFERENCES "ClinicsUnit"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

COMMIT;

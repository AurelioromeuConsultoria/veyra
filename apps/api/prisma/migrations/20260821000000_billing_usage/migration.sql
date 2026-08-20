-- CreateEnum
CREATE TYPE "UsageMetricKind" AS ENUM ('counter', 'gauge');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'canceled');

-- CreateTable
CREATE TABLE "Plan" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PlanLimit" (
    "planKey" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "kind" "UsageMetricKind" NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "PlanLimit_pkey" PRIMARY KEY ("planKey","metric")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "workspaceId" UUID NOT NULL,
    "planKey" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageReservation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Subscription_planKey_idx" ON "Subscription"("planKey");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_workspaceId_metric_period_key" ON "UsageCounter"("workspaceId", "metric", "period");

-- CreateIndex
CREATE INDEX "UsageReservation_workspaceId_metric_period_idx" ON "UsageReservation"("workspaceId", "metric", "period");

-- CreateIndex
CREATE INDEX "UsageReservation_expiresAt_idx" ON "UsageReservation"("expiresAt");

-- AddForeignKey
ALTER TABLE "PlanLimit" ADD CONSTRAINT "PlanLimit_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "Plan"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "Plan"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageReservation" ADD CONSTRAINT "UsageReservation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Catálogo de planos (global, como Permission) ─────────────────────────────
INSERT INTO "Plan" ("key", "name", "priceCents", "isDefault") VALUES
  ('base', 'Base', 0, true),
  ('pro',  'Pro',  9900, false)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "PlanLimit" ("planKey", "metric", "kind", "value") VALUES
  -- nível atual (gauge): sobe ao criar, desce ao arquivar/excluir
  ('base', 'contacts',      'gauge',   2000),
  ('base', 'storage_bytes', 'gauge',   1073741824),   -- 1 GiB
  -- acumulador por período (counter): zera na virada do mês
  ('base', 'ai_runs',       'counter', 200),
  ('base', 'ai_cost_cents', 'counter', 500),          -- USD 5,00/mês
  ('pro',  'contacts',      'gauge',   50000),
  ('pro',  'storage_bytes', 'gauge',   10737418240),  -- 10 GiB
  ('pro',  'ai_runs',       'counter', 5000),
  ('pro',  'ai_cost_cents', 'counter', 20000)         -- USD 200,00/mês
ON CONFLICT ("planKey", "metric") DO NOTHING;

-- ── Backfill: todo workspace existente recebe o plano-base ───────────────────
-- Sem assinatura não há limite aplicável, e o sistema ficaria sem o equivalente
-- ao default-deny que vale no resto. Idempotente por WHERE NOT EXISTS.
INSERT INTO "Subscription" ("workspaceId", "planKey", "status", "currentPeriodStart", "currentPeriodEnd", "updatedAt")
SELECT w."id", 'base', 'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', now()
  FROM "Workspace" w
 WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."workspaceId" = w."id");

-- ── Backfill dos GAUGES com o valor REAL (nunca zero) ────────────────────────
-- Contatos contam apenas em `active` (ADR-032).
INSERT INTO "UsageCounter" ("id", "workspaceId", "metric", "period", "value", "updatedAt")
SELECT gen_random_uuid(), w."id", 'contacts', '',
       (SELECT count(*) FROM "Contact" c WHERE c."workspaceId" = w."id" AND c."status" = 'active'),
       now()
  FROM "Workspace" w
 WHERE NOT EXISTS (
   SELECT 1 FROM "UsageCounter" u
    WHERE u."workspaceId" = w."id" AND u."metric" = 'contacts' AND u."period" = ''
 );

INSERT INTO "UsageCounter" ("id", "workspaceId", "metric", "period", "value", "updatedAt")
SELECT gen_random_uuid(), w."id", 'storage_bytes', '',
       COALESCE((SELECT sum(f."sizeBytes") FROM "FileObject" f WHERE f."workspaceId" = w."id"), 0),
       now()
  FROM "Workspace" w
 WHERE NOT EXISTS (
   SELECT 1 FROM "UsageCounter" u
    WHERE u."workspaceId" = w."id" AND u."metric" = 'storage_bytes' AND u."period" = ''
 );

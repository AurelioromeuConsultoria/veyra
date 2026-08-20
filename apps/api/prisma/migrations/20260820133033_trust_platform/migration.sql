-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('processing', 'completed');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('active', 'paused', 'disabled');

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'processing',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secretCipher" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'active',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "responseStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_workspaceId_key_endpoint_key" ON "IdempotencyKey"("workspaceId", "key", "endpoint");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextRetryAt_idx" ON "OutboxEvent"("status", "nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_workspaceId_dedupeKey_key" ON "OutboxEvent"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_workspaceId_id_key" ON "OutboxEvent"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Webhook_workspaceId_status_idx" ON "Webhook"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_workspaceId_id_key" ON "Webhook"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_webhookId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "webhookId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_workspaceId_webhookId_outboxEventId_attempt_key" ON "WebhookDelivery"("workspaceId", "webhookId", "outboxEventId", "attempt");

-- AddForeignKey
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_webhookId_fkey" FOREIGN KEY ("workspaceId", "webhookId") REFERENCES "Webhook"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_outboxEventId_fkey" FOREIGN KEY ("workspaceId", "outboxEventId") REFERENCES "OutboxEvent"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

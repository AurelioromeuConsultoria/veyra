-- ADR-043: varredura de arquivos com lease/fencing, quarentena terminal e
-- remoção física dos bytes confirmada pelo driver.

ALTER TABLE "FileObject"
  ADD COLUMN "scannedAt"          TIMESTAMP(3),
  ADD COLUMN "scanError"          TEXT,
  ADD COLUMN "scanAttempts"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "scanClaimToken"     UUID,
  ADD COLUMN "scanLeaseExpiresAt" TIMESTAMP(3),
  -- null em `quarantined` = malware AINDA no disco: pendência de limpeza que o
  -- job idempotente retenta. Nunca vira `pending` de novo.
  ADD COLUMN "bytesPurgedAt"      TIMESTAMP(3);

-- a varredura e a limpeza varrem TODOS os workspaces: estes índices não lideram
-- por workspaceId de propósito (mesma razão do índice de dispatch abandonado)
CREATE INDEX "FileObject_scanStatus_scanLeaseExpiresAt_idx"
  ON "FileObject"("scanStatus", "scanLeaseExpiresAt");
CREATE INDEX "FileObject_scanStatus_bytesPurgedAt_idx"
  ON "FileObject"("scanStatus", "bytesPurgedAt");

-- coerência dos estados: só quarentena tem bytes removidos, e veredito exige
-- estado terminal. Impede "pending com bytes apagados", que é a inconsistência
-- inversa que o ADR-043 existe para evitar.
ALTER TABLE "FileObject"
  ADD CONSTRAINT "FileObject_purge_only_quarantined"
  CHECK ("bytesPurgedAt" IS NULL OR "scanStatus" = 'quarantined');
ALTER TABLE "FileObject"
  ADD CONSTRAINT "FileObject_verdict_requires_terminal_status"
  CHECK ("scannedAt" IS NULL OR "scanStatus" <> 'pending');

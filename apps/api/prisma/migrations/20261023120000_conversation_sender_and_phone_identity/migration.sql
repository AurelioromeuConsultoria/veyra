-- F4.1a (ADR-052, itens 1 a 3): identidade sem atribuição silenciosa.
--
-- O que faz, numa transação só (ADR-051):
--   1. o tipo "ConversationSender" (remetente identificado ou a identificar, RAI);
--   2. "Workspace"."phoneRegion" (BR por padrão; CHECK de duas letras);
--   3. "Contact"."phonesNormalized" e "Contact"."phoneMatchKeys". As chaves de
--      coincidência são só dígitos e saem aqui mesmo, em SQL. As formas E.164
--      vêm depois, pela CLI `phones:normalize`, que usa a biblioteca;
--   4. "Conversation": "senderStatus", "senderIdentifiedAt" e as marcas
--      "openMark" e "unidentifiedOpenMark", mantidas por gatilho e amarradas por
--      CHECK;
--   5. os índices: o GIN das chaves de coincidência e os dois únicos (uma
--      conversa aberta por canal, contato e número; uma RAI aberta por canal e
--      número);
--   6. "FileObject"."conversationRestricted": a regra dos anexos de conversa
--      vale mesmo sem vínculo. A mídia recebida nasce com ela; aqui, ela é
--      preenchida para a mídia recebida que já existe (o arquivo ligado a uma
--      "InboundMedia"), e fica falsa no resto.
--
-- Sem CONCURRENTLY, de propósito: o volume é de dados fictícios, e assim uma
-- duplicata faz a migration INTEIRA falhar de forma atômica, sem nada aplicado
-- pela metade. O diagnóstico (`identity:diagnose`) aponta as duplicatas antes;
-- nada é corrigido sozinho. Com volume real, os índices vão para migrations
-- próprias com CONCURRENTLY (ADR-051, a exceção).
--
-- Locks: ACCESS EXCLUSIVE breve em "Workspace", "Contact", "Conversation" e
-- "FileObject" nos ALTER TABLE (as colunas novas têm default constante ou são
-- anuláveis sem default, sem reescrita); depois
-- os UPDATEs de preenchimento (linha a linha) e o SHARE dos CREATE INDEX nas
-- duas tabelas até o COMMIT. Estimativa: espera por lock limitada a 5 s por
-- instrução, e execução de poucos segundos no volume atual.
--
-- Se falhar: docs/DEPLOY_STAGING.md §4, "Falha de migration", nunca
-- `migrate resolve --rolled-back` às cegas. A transação desfaz tudo; o
-- inventário de lá deve dar zero.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "ConversationSender" AS ENUM ('identified', 'unidentified');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "phoneMatchKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "phonesNormalized" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "openMark" BOOLEAN,
ADD COLUMN     "senderIdentifiedAt" TIMESTAMP(3),
ADD COLUMN     "senderStatus" "ConversationSender" NOT NULL DEFAULT 'identified',
ADD COLUMN     "unidentifiedOpenMark" BOOLEAN;

-- AlterTable
ALTER TABLE "FileObject" ADD COLUMN     "conversationRestricted" BOOLEAN NOT NULL DEFAULT false;

-- a mídia recebida que já existe nasce sob a regra, como a nova: o arquivo
-- ligado a uma "InboundMedia" do mesmo workspace
UPDATE "FileObject" f
   SET "conversationRestricted" = true
  FROM "InboundMedia" i
 WHERE i."workspaceId" = f."workspaceId"
   AND i."fileObjectId" = f."id";

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "phoneRegion" TEXT NOT NULL DEFAULT 'BR';

-- A região é um código de país de duas letras maiúsculas (ISO 3166-1)
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_phoneRegion_check"
  CHECK ("phoneRegion" ~ '^[A-Z]{2}$');

-- RAI nunca tem contato: é o que impede a atribuição silenciosa no banco
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sender_check"
  CHECK ("senderStatus" <> 'unidentified' OR "contactId" IS NULL);

-- As marcas dos únicos: o gatilho as calcula, e os CHECKs garantem que nenhuma
-- escrita direta as desalinha do status e do remetente
CREATE FUNCTION "conversation_marks"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."openMark" := CASE WHEN NEW."status" <> 'closed' THEN TRUE END;
  NEW."unidentifiedOpenMark" := CASE
    WHEN NEW."senderStatus" = 'unidentified' AND NEW."status" <> 'closed' THEN TRUE
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "conversation_marks"
  BEFORE INSERT OR UPDATE ON "Conversation"
  FOR EACH ROW EXECUTE FUNCTION "conversation_marks"();

-- as linhas existentes: o UPDATE dispara o gatilho, que calcula as marcas
UPDATE "Conversation" SET "status" = "status";

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_openMark_check"
  CHECK (
    ("status" <> 'closed' AND "openMark" IS TRUE)
    OR ("status" = 'closed' AND "openMark" IS NULL)
  );

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_unidentifiedOpenMark_check"
  CHECK (
    ("senderStatus" = 'unidentified' AND "status" <> 'closed' AND "unidentifiedOpenMark" IS TRUE)
    OR (NOT ("senderStatus" = 'unidentified' AND "status" <> 'closed') AND "unidentifiedOpenMark" IS NULL)
  );

-- As chaves de coincidência dos contatos existentes, pela MESMA regra do
-- serviço (`chavesDeCoincidencia`): os últimos 8 dígitos de cada telefone com
-- 8 ou mais dígitos, sem repetição, em ordem
UPDATE "Contact" SET "phoneMatchKeys" = COALESCE(
  (
    SELECT array_agg(DISTINCT right(d, 8) ORDER BY right(d, 8))
    FROM (SELECT regexp_replace(p, '[^0-9]', '', 'g') AS d FROM unnest("phones") AS p) AS digitos
    WHERE length(d) >= 8
  ),
  ARRAY[]::TEXT[]
);

-- CreateIndex
CREATE INDEX "Contact_phoneMatchKeys_idx" ON "Contact" USING GIN ("phoneMatchKeys");

-- CreateIndex (por último: uma duplicata desfaz a migration inteira)
CREATE UNIQUE INDEX "Conversation_workspaceId_channelId_contactId_externalAddres_key" ON "Conversation"("workspaceId", "channelId", "contactId", "externalAddress", "openMark");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_workspaceId_channelId_externalAddress_unidenti_key" ON "Conversation"("workspaceId", "channelId", "externalAddress", "unidentifiedOpenMark");

COMMIT;

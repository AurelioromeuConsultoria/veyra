-- F5.1a (ADR-054 item 12; decisão do usuário de 2026-10-29): a autoridade de
-- quem convida.
--
-- O que faz, numa transação só (ADR-051):
--   1. as colunas "createdByMembershipId" (a membership de quem emitiu o
--      convite) e "issuedByProvisioning" (o convite da CLI de provisionamento);
--   2. INVALIDA os convites PENDENTES anteriores a esta migration. Não há
--      evidência confiável de quem os criou, e a decisão do usuário é não
--      inventar o criador nem atribuí-los ao Owner. Eles saem como numa
--      revogação (a linha é apagada), cada um com uma entrada
--      `invite.invalidated` na trilha (ator `system`, origem esta migration,
--      só o papel, nunca o e-mail ou o token). Os ACEITOS ficam, sem criador,
--      como histórico;
--   3. a FK composta ("workspaceId", "createdByMembershipId") → Membership,
--      `NO ACTION` (a exclusão do workspace passa: é conferida no fim da
--      instrução);
--   4. o CHECK "Invite_autoridade_conhecida": convite pendente tem exatamente
--      UMA origem — a membership de quem emitiu OU o provisionamento;
--   5. o índice ("workspaceId", "createdByMembershipId"), para a remoção e o
--      rebaixamento revogarem os convites pendentes de quem os criou.
--
-- Impacto: todo link de convite PENDENTE emitido antes desta migration deixa
-- de funcionar e precisa ser emitido de novo pela tela de equipe. O convite de
-- Owner do provisionamento NÃO tem caminho de reemissão num workspace que já
-- existe: antes de aplicar, a janela confere se há workspace com convite de
-- Owner pendente e sem Owner ativo, e para se houver (DEPLOY_STAGING §4).
-- A contagem sai num NOTICE.
--
-- Locks: ACCESS EXCLUSIVE em "Invite" (ADD COLUMN, CHECK, FK, índice) e SHARE
-- ROW EXCLUSIVE em "Membership" (FK); "AuditLog" recebe só INSERTs. São tabelas
-- pequenas e pouco escritas. Cada espera por lock é limitada a 5 s; a soma das
-- esperas, na estimativa, fica abaixo de 15 s no pior caso.
--
-- Se falhar: DEPLOY_STAGING §4 ("Falha de migration"), nunca `rolled-back` às
-- cegas. A transação desfaz tudo: o inventário volta a zero e nenhum convite é
-- apagado.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. as colunas
ALTER TABLE "Invite" ADD COLUMN     "createdByMembershipId" UUID,
ADD COLUMN     "issuedByProvisioning" BOOLEAN NOT NULL DEFAULT false;

-- 2. os pendentes legados: invalidados, com a trilha
DO $$
DECLARE
  n integer;
BEGIN
  WITH invalidados AS (
    DELETE FROM "Invite" WHERE "acceptedAt" IS NULL
    RETURNING "id", "workspaceId", "roleId"
  ), trilha AS (
    INSERT INTO "AuditLog" ("id", "workspaceId", "actorType", "actorId", "action", "entityType", "entityId", "before")
    SELECT gen_random_uuid(), "workspaceId", 'system', 'migration:20261029220000_invite_authority',
           'invite.invalidated', 'invite', "id", jsonb_build_object('roleId', "roleId")
      FROM invalidados
    RETURNING 1
  )
  SELECT count(*) INTO n FROM trilha;
  RAISE NOTICE 'convites pendentes anteriores invalidados: %', n;
END $$;

-- 3. a FK composta
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_workspaceId_createdByMembershipId_fkey" FOREIGN KEY ("workspaceId", "createdByMembershipId") REFERENCES "Membership"("workspaceId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 4. a origem conhecida de todo convite pendente
ALTER TABLE "Invite" ADD CONSTRAINT "Invite_autoridade_conhecida" CHECK (
  "acceptedAt" IS NOT NULL
  OR (("createdByMembershipId" IS NOT NULL) <> "issuedByProvisioning")
);

-- 5. o índice da revogação por quem criou
CREATE INDEX "Invite_workspaceId_createdByMembershipId_idx" ON "Invite"("workspaceId", "createdByMembershipId");

COMMIT;

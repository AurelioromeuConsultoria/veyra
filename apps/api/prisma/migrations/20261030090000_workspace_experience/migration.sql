-- E-1 da experiência por produto (ADR-055 adendo 1, item 1; decisão do
-- usuário de 2026-10-29): a experiência do workspace.
--
-- O que faz, numa transação só (ADR-051):
--   1. a coluna "experience" em "Workspace", texto, NOT NULL DEFAULT 'crm':
--      todo workspace existente fica em `crm`, e nada muda para quem usa o CRM;
--   2. o CHECK "Workspace_experience_formato": só o FORMATO da chave
--      (o das chaves de extensão). As chaves válidas são as da composição, que
--      o banco não conhece — como as permissões.
--
-- Nenhuma experiência além de `crm` é posta aqui: a `clinics` só é selecionável
-- depois do frontend dela (E-3), pela CLI de operação, auditada.
--
-- Locks: ACCESS EXCLUSIVE em "Workspace", por instantes. O ADD COLUMN com
-- DEFAULT constante só muda metadados; o CHECK lê a tabela, que é pequena.
-- Cada espera por lock é limitada a 5 s; a soma das esperas, na estimativa,
-- fica abaixo de 10 s no pior caso.
--
-- Se falhar: DEPLOY_STAGING §4 ("Falha de migration"), nunca `rolled-back` às
-- cegas. A transação desfaz tudo: o inventário volta a zero.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 1. a coluna
ALTER TABLE "Workspace" ADD COLUMN     "experience" TEXT NOT NULL DEFAULT 'crm';

-- 2. o formato da chave
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_experience_formato" CHECK (
  "experience" ~ '^[a-z][a-z0-9]{1,30}$'
);

COMMIT;

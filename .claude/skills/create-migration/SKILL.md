---
name: create-migration
description: Change the database schema safely — catch destructive statements before they run, keep migrations paired with code, and never edit an applied migration.
---

# create-migration

Referências: `docs/DOMAIN_MODEL.md §1`, `docs/SECURITY.md §2`, hook `block-destructive-migration.sh`.

## Passos

1. **Altere o `schema.prisma`** seguindo as convenções (workspaceId, índices compostos, FKs compostas). Revise o diff do schema antes de gerar.
2. **Gere**: `prisma migrate dev --name <snake_case_descritivo>` contra o Postgres de dev local.
3. **Leia o SQL gerado inteiro** antes de aceitar. Procure destrutividade:
   - `DROP TABLE` / `TRUNCATE` → não passa (hook nega); exige plano aprovado com backup e migração de dados.
   - `DROP COLUMN` → só com plano: código que lia a coluna já removido em release anterior? Dados migrados?
   - `NOT NULL` sem `DEFAULT` em tabela com linhas → duas etapas (adicionar nullable + backfill + constraint) ou DEFAULT.
   - Estreitamento de tipo / mudança de unique → verifique dados existentes primeiro.
4. **FKs compostas**: se a migration cria relação entre entidades de workspace, confirme que a FK é `(workspaceId, xId)`. Rode `check:fk` depois de aplicar.
5. **Nunca edite migration já aplicada** (em qualquer ambiente compartilhado). Errou? Nova migration corretiva.
6. **Commite a migration junto do código** que a usa — nunca separado.
7. **Teste**: suite de integração passa contra banco migrado do zero (`migrate deploy` em DB limpo).
8. Migration tocando tabelas de identidade/acesso (Workspace, User, Membership, Role, Permission) → revisão `security` + `reviewer` obrigatória.

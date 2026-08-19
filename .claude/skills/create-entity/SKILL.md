---
name: create-entity
description: Create a new domain entity end to end — Prisma model, migration, WORKSPACE_MODELS entry, composite FKs, contracts, service, controller, permissions, audit allowlist, and tests.
---

# create-entity

Referências: `docs/DOMAIN_MODEL.md §1` (convenções), `docs/SECURITY.md §2`, ADR-002/010/011.

## Passos

1. **Modelo Prisma** (com o agente `database`):
   - `id String @id @default(uuid()) @db.Uuid`, `createdAt`/`updatedAt`;
   - `workspaceId String @db.Uuid` + relação com `Workspace` `onDelete: Cascade`;
   - `@@unique([workspaceId, id])` se a entidade for referenciável por outra;
   - índices compostos liderados por `workspaceId`; uniques tenant-scoped;
   - dinheiro em `Int` centavos + `currency`.
2. **FKs compostas**: toda relação com outra entidade de workspace usa `(workspaceId, xId) → X(workspaceId, id)`. FK simples só para catálogo global (Permission, Plan) com justificativa.
3. **WORKSPACE_MODELS**: adicione o modelo ao set no `prisma.service.ts` — sem isso a entidade fica FORA do isolamento automático. Este passo dispara revisão de `security` (arquivo sensível).
4. **Migration**: via `create-migration` (nunca destrutiva sem plano).
5. **Contratos** em `packages/contracts`: `create<X>Schema`/`update<X>Schema`/`list<X>Schema` (Zod) + `XDto` (interface). Nada de campo sensível no DTO.
6. **Permissões**: keys `<area>:read`/`<area>:write` cobrindo a entidade; endpoints com `@RequirePermissions`.
7. **Service + controller**: controller fino com `ZodPipe`; service usa `prisma.db` (nunca unsafe ops); mutação relevante grava `AuditLog` com **allowlist de campos** definida agora, não depois.
8. **Testes**: integração cobrindo a fronteira de tenant (A não vê B) e o vínculo por FK composta; `check:fk` limpo.
9. **Docs**: `docs/DOMAIN_MODEL.md` atualizado com a entidade e suas notas.

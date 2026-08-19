---
name: review-tenant-isolation
description: Audit workspace isolation — WORKSPACE_MODELS coverage, raw usage, unsafe operations, composite FKs, jobs/AI context. Any leak is P0. Run before merging anything touching data access.
---

# review-tenant-isolation

Referências: `docs/SECURITY.md §1/§2`, ADR-002/003/010. Executar com o agente `security` (read-only).

## Passos

1. **Cobertura do WORKSPACE_MODELS**: todo modelo de domínio do `schema.prisma` com `workspaceId` está no set? Modelo fora do set = fora do isolamento automático = Bloqueante. Exceções legítimas (User, RefreshToken, Workspace, catálogos globais Permission/Plan/PromptVersion) estão comentadas.
2. **Usos de `raw`**: grep por `prisma.raw` / `.raw.`. Cada uso está nas exceções documentadas (identidade global, auth, provisionamento, jobs cross-workspace, rotina administrativa) **e** tem comentário justificando? Uso fora disso é Bloqueante.
3. **Operações unsafe**: grep por `findUnique`, `upsert`, `\.update\(`, `\.delete\(` sobre modelos protegidos — devem ser `findFirst`/`updateMany`/`deleteMany` via `db`. Qualquer hit é Bloqueante.
4. **FKs compostas**: relações novas entre entidades de workspace usam `(workspaceId, xId)`? Rode `check:fk` contra banco populado. FK simples cruzável é Bloqueante (vaza via include).
5. **Jobs**: todo worker cross-workspace usa `runForAllWorkspaces` com `cls.run()` por workspace e try/catch por workspace? Job que consulta sem contexto deve falhar (fail-closed), não retornar tudo.
6. **IA**: tools do `intelligence` só chamam services (nunca Prisma); contexto por allowlist; run de job usa membership de serviço com permissões mínimas.
7. **Testes**: o P0 (`prisma.multitenant.integration-spec`) cobre os caminhos novos (create carimba, A não lê B, updateMany não cruza, sem contexto = erro, unsafe = bloqueado)? Se não cobre, escreva antes de aprovar.
8. **Relatório**: qualquer vazamento confirmado = **P0** — bloqueia commit, prioridade máxima, correção + reteste antes de qualquer outro trabalho.

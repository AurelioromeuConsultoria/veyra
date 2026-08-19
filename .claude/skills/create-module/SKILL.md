---
name: create-module
description: Create a new NestJS domain module in the Core with explicit boundaries registered in the dependency graph. Use when adding a whole new domain area (not just an entity or endpoint).
---

# create-module

Referências: `docs/ARCHITECTURE.md §3/§5`, `CLAUDE.md §3`.

## Passos

1. **Justifique**: o módulo é universal (consultoria, imobiliária e clínica usariam igual)? Se não, é vertical → use `create-vertical`. Se é decisão estrutural, ADR primeiro (`architect`).
2. **Registre a fronteira**: adicione o módulo ao grafo de dependências em `docs/ARCHITECTURE.md §5` — de quem ele pode depender e quem pode depender dele. Aresta lateral nova entre módulos de domínio exige ADR.
3. **Crie a forma padrão**: `apps/api/src/<modulo>/` com `<modulo>.module.ts`, `<modulo>.controller.ts` (fino), `<modulo>.service.ts` (regra de negócio). Sem camada Repository (ADR-005).
4. **Contratos**: arquivo do módulo em `packages/contracts` (schemas Zod de entrada + interfaces DTO de saída) antes de qualquer endpoint.
5. **Permissões**: defina as permission keys do módulo (`<modulo>:read`, `<modulo>:write`, ...) no catálogo e no seed dos roles de sistema.
6. **Entidades**: para cada uma, siga a skill `create-entity` (workspaceId, WORKSPACE_MODELS, FKs compostas).
7. **Auditoria/outbox**: mutações relevantes auditam (allowlist definida); efeitos externos via outbox.
8. **Testes**: unit para lógica, integração para acesso a dados (incluindo fronteira de tenant), e2e se houver fluxo de usuário.
9. **Revisão**: `reviewer` sempre; + `security` se o módulo toca auth/tenancy/RBAC/arquivos/segredos.
10. **Docs**: atualize `docs/DOMAIN_MODEL.md` e, se preciso, `docs/ROADMAP.md`, no mesmo trabalho.

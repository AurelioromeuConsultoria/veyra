---
name: review-rbac
description: Audit RBAC correctness — every endpoint has a permission, no role-name branching, system roles protected, tokenVersion revocation respected. Run before merging any access-control change.
---

# review-rbac

Referências: `docs/SECURITY.md §3/§4`, ADR-004/009. Executar com os agentes `security` (read-only) e `reviewer`.

## Passos

1. **Cobertura de endpoints (default-deny, ADR-016)**: grep por controllers; todo handler tem `@RequirePermissions(...)`, ou `@AuthenticatedOnly()` explícito (raro, justificado), ou `@Public()` justificado. Endpoint privado **sem decorator** é achado **P1** — **P0** se expõe dado ou mutação sensível (o guard nega em runtime, mas a omissão é bug de intenção e deve ser corrigida, nunca "deixada porque o guard segura"). Rota pública nova sem justificativa é P0.
2. **Nenhuma decisão por nome de role**: grep por `role.name`, `=== 'admin'`, `'Owner'` etc. no código de produto. Qualquer ramificação por nome é Bloqueante (ADR-004) — converta para permission key.
3. **Catálogo estável**: permission keys novas seguem `<area>:<acao>`, estão no seed, e nenhuma key foi renomeada/removida sem migração dos `RolePermission` existentes.
4. **Roles de sistema**: Owner/Admin/Member/Guest semeados por workspace com `isSystem=true`; endpoints de edição/exclusão de role rejeitam `isSystem`. Não existe Role global.
5. **Revogação**: mudança de role/permissão e remoção/desativação de membership incrementam `tokenVersion`; guard compara versão; operações sensíveis revalidam membership viva. Teste cobrindo "removido não acessa na request seguinte" existe e passa.
6. **API pública**: escopos de `ApiKey` são subconjunto de permission keys e passam pelo mesmo guard.
7. **Escalação**: quem pode conceder o quê? Endpoint de atribuição de role exige permissão administrativa e não permite auto-elevação acima do próprio conjunto.
8. **Relatório**: achados por severidade (P0/P1/P2) com arquivo:linha; veredito final.

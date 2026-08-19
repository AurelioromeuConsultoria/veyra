---
name: create-api
description: Create an API endpoint (CRUD or action) — contract in packages/contracts, thin controller with ZodPipe, permission, audit, idempotency/outbox where relevant, and OpenAPI if public.
---

# create-api

Referências: `docs/ARCHITECTURE.md §3/§7`, `docs/SECURITY.md §4/§6`, ADR-006.

## Passos

1. **Contrato primeiro** (`packages/contracts`): schema Zod de entrada + interface DTO de saída. Ordem contracts → api → web, sempre.
2. **Rota e verbo**: REST previsível; ação não-CRUD como `POST /<recurso>/<id>/<acao>`. Erros com status correto e mensagem pt-BR útil (sem vazar interno).
3. **Permissão**: `@RequirePermissions('<area>:<acao>')` em todo endpoint. `@Public()` só com justificativa revisável (health, callbacks assinados).
4. **Controller fino**: rota + `ZodPipe` + delegação ao service. Zero lógica de negócio.
5. **Service**: `prisma.db`; sem operações unsafe; mutação relevante audita (allowlist); **efeito externo via outbox**, nunca inline na transação.
6. **Idempotência**: endpoint público de mutação aceita `Idempotency-Key`; efeitos com `dedupeKey` onde reexecução for possível.
7. **API pública?** Então: versionada em `/api/v1`, documentada no OpenAPI gerado, autenticada por `ApiKey` com escopos = permission keys.
8. **DTO de saída limpo**: nenhum hash, token, credencial ou campo interno.
9. **Testes**: unit da regra; integração do acesso (incluindo tenant A vs B e permissão negada → 403); e2e se fluxo de usuário.
10. **Revisão**: `reviewer`; + `security` se toca auth/tenancy/RBAC/arquivos.

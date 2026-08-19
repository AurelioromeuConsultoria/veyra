---
name: security-review
description: Full security review of pending changes — tenant isolation, RBAC, auth/session, secrets, audit, files, AI governance. Mandatory before merging anything touching auth, tenancy, RBAC, secrets, or migrations.
---

# security-review

Referências: `docs/SECURITY.md` (checklist §10 é a base), `CLAUDE.md §4`. Executar com o agente `security` (read-only); correções voltam ao agente da camada e retornam para reteste.

## Passos

1. **Escopo**: `git diff` completo das mudanças pendentes. Liste os arquivos sensíveis tocados (prisma.service, guards, decorators, auth, migrations, hooks).
2. **Isolamento**: rode a skill `review-tenant-isolation` sobre o diff (passos 1–7 dela). Vazamento = P0.
3. **RBAC**: rode a skill `review-rbac` sobre o diff (passos 1–7 dela).
4. **Auth/sessão**: refresh continua hasheado e rotativo? Cookies httpOnly/Secure/SameSite? CSRF nas mutações? `@Public()` novo justificado? `tokenVersion` respeitado?
5. **Segredos**: nenhum segredo/hash/token em DTO, log, mensagem de erro, fixture ou commit. Env nova validada no `env.ts`; chave de cripto separada do JWT.
6. **Auditoria**: mutações relevantes auditam; `before/after` respeitam allowlist + redaction; nada de conteúdo de conversa/anexo/segredo no log.
7. **Efeitos externos**: outbox + dedupeKey; rate limit nos endpoints expostos; `Idempotency-Key` onde aplicável; webhook out assinado (HMAC).
8. **Arquivos** (se tocados): magic bytes, limite de tamanho, prefixo por workspace derivado do CLS, download autorizado, `scanStatus` respeitado.
9. **IA** (se tocada): tools sobre services, ToolSet condicional, `AiProposal` para ação externa, `AiRun` persistido, contexto por allowlist.
10. **Relatório e veredito**: achados **[P0|P1|P2] arquivo:linha — problema — correção — responsável**; veredito `aprovado` / `aprovado com ressalvas` / `bloqueado`. P0 bloqueia commit até correção + reteste.

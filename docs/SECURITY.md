# SECURITY — Veyra

Segurança e SaaS são inegociáveis. Este documento define o modelo de ameaça e os mecanismos. Mudança aqui exige ADR + revisão dos agentes `security` e `reviewer`.

## 1. Modelo de ameaça multi-tenant

Ameaça número um: **vazamento entre workspaces** — um tenant ler/escrever dados de outro por query sem filtro, FK cruzada, `include` transitivo, job sem contexto ou tool de IA mal escopada. Todo o design parte de: _o desenvolvedor vai esquecer o filtro um dia; o sistema não pode depender de ele lembrar._

## 2. Isolamento de tenant (fail-closed, em camadas)

**Camada 1 — Client extension do Prisma** (`prisma.service.ts`):

- `prisma.db` (uso padrão): intercepta `$allOperations` nos modelos de `WORKSPACE_MODELS` e
  - injeta `workspaceId` do CLS em `create`/`createMany`;
  - injeta `where: { AND: [{ workspaceId }, whereOriginal] }` em leituras e escritas;
  - **bloqueia** `findUnique`, `findUniqueOrThrow`, `update`, `delete`, `upsert` (operações por chave única não aceitam filtro extra — seriam bypass silencioso); use `findFirst`/`updateMany`/`deleteMany`;
  - **lança erro** se não houver `workspaceId` no CLS — sem contexto, nenhuma linha sai.
- `prisma.raw` (excepcional, sempre com comentário justificando): identidade global (`User`, `RefreshToken`), autenticação (lookup por e-mail), provisionamento controlado de workspace, jobs cross-workspace (`runForAllWorkspaces` + `cls.run()`), rotinas administrativas explicitamente justificadas. **Membership, Role, Team, Invite e todo dado de acesso por workspace são tenant-scoped e usam `db`.**

**Camada 2 — Integridade no banco (FKs compostas):** entidades referenciáveis declaram `@@unique([workspaceId, id])`; relações entre entidades de workspace usam `FOREIGN KEY (workspaceId, xId) REFERENCES X(workspaceId, id)`. Obrigatório em: Membership→Role, Team→Membership, Deal→Contact/Pipeline/Stage, Message→Conversation, Notification→Membership, extensões verticais→Contact — e default para toda relação futura entre entidades de workspace.

**Camada 3 — Verificação contínua:**

- Teste de integração de segurança **P0** contra Postgres real (`prisma.multitenant.integration-spec.ts` na Fase 2): create carimba o workspace do CLS; A não lê B; `updateMany` de A não alcança linha de B; query sem contexto é bloqueada; operação unsafe é bloqueada. Se falhar, é vazamento — trate como incidente.
- Script `check:fk` que varre o banco procurando FKs que cruzam fronteira de workspace (exit 1 se sujo; imprime só IDs).

**Camada 4 (futura, ADR com gatilho):** RLS no Postgres como defesa em profundidade contra uso indevido de `raw` — gatilho: primeiro cliente enterprise ou incidente de quase-vazamento.

## 3. Autenticação e sessões

- **Access token**: JWT curto (15 min), claims `sub`, `membershipId`, `workspaceId`, `tokenVersion`, `email`.
- **Refresh token**: aleatório (48 bytes), armazenado **só como SHA-256**, TTL 30 dias, **rotação real** (refresh usado é revogado; reuso de token revogado invalida a família).
- **Transporte**: cookies `httpOnly` + `Secure` + `SameSite=Lax` (nunca localStorage). Mutações protegidas por token CSRF (double-submit).
- **Senhas**: hash com custo adequado (argon2id preferido; bcrypt aceitável), política mínima de tamanho, sem regra de composição arbitrária.
- **Guard global**: endpoints privados por padrão; `@Public()` é opt-out explícito e revisável.
- **Revogação imediata**: `Membership.tokenVersion` viaja no JWT. Remover/desativar membership ou alterar role/permissões incrementa a versão → access tokens antigos falham na próxima validação. Operações sensíveis (billing, exclusão, export) revalidam a membership viva no banco.
- **Sem registro público no MVP**: workspaces são provisionados de forma controlada; usuários entram por convite. Onboarding self-service só após billing, quotas, rate limit e antiabuso (ADR).

## 4. Autorização — RBAC por permissões

- `Permission` = catálogo global de chaves estáveis (`contacts:read`, `deals:write`, `settings:billing`, `intelligence:approve`…). Código só conhece chaves.
- `Role` sempre pertence a um workspace. Padrões (Owner/Admin/Member/Guest) semeados no provisionamento com `isSystem=true` — não editáveis nem deletáveis. Roles customizados pertencem ao workspace.
- `PermissionsGuard` global (segundo APP_GUARD, depois do JwtAuthGuard) com **default-deny**: endpoint privado **sem** `@RequirePermissions(...)` é **negado** — estar autenticado não basta. Rota que legitimamente precise apenas de autenticação usa `@AuthenticatedOnly()` explícito, raro e revisável (ex.: `GET /me`, troca de workspace). `@Public()` continua sendo a única exceção para endpoint não autenticado. Endpoint privado sem nenhum decorator é achado de revisão P1 — P0 se expõe dado ou mutação sensível (ADR-016).
- **Proibido** ramificar por nome de role. Auditoria de RBAC via skill `review-rbac`.
- API pública: `ApiKey` com `scopes` = subconjunto de permission keys; mesmo guard.

## 5. Auditoria (com minimização)

- `AuditLog(workspaceId, actorType[user|ai|system|api], actorId, action, entityType, entityId, before, after, requestId)` — append-only, gravado nos services de mutação relevante.
- **Minimização obrigatória**: `before/after` seguem **allowlist de campos auditáveis por entidade** (ex.: Deal: stage, amount, owner, status). Nunca entram: conteúdo de mensagens/conversas, corpo de anexos, segredos/hashes/tokens, dados clínicos de verticais futuros. Campos fora da allowlist aparecem como `"[changed]"`.
- Ações de IA sempre auditadas (`actorType: 'ai'` + link para `AiRun`).
- **Retenção**: 12 meses online por padrão (configurável por plano); depois, expurgo ou arquivamento frio. Export LGPD não inclui audit log de outros atores.

## 6. Rate limit, quotas e idempotência

- Rate limit por workspace e por IP nos endpoints públicos e de auth (login/refresh/convite) desde o MVP.
- Quotas por plano (`UsageLimit`/`UsageCounter`): contatos, mensagens, storage, runs de IA. Exceder = 429/402 com mensagem clara, nunca degradação silenciosa.
- `Idempotency-Key` nas mutações da API pública; efeitos externos idempotentes via `dedupeKey` + unique tenant-scoped.
- Outbox transacional para todo efeito externo (webhooks out, e-mail, mensagens) — retry com backoff, sem efeito dentro da transação de domínio.

## 7. Arquivos

Política obrigatória para `FileObject`:

1. **Validação de tipo real** por magic bytes — nunca confiar no mimetype declarado; extensão×conteúdo divergentes = rejeição.
2. **Limite de tamanho** por arquivo e quota de storage por workspace (plano).
3. **Storage prefixado por workspace** (`{workspaceId}/...`) — o prefixo é derivado do CLS, nunca de input do cliente.
4. **Autorização no download**: URL nunca é pública; download passa por endpoint autenticado (ou URL assinada de curtíssima duração) que checa permissão + workspace.
5. **Antivírus/quarentena**: `scanStatus` (pending/clean/quarantined) no modelo desde o início; arquivo só é servível a terceiros/canais externos quando `clean`. Integração de scanning pode ser adiada, o estado não.
6. Cifra na borda para conteúdo sensível (cifrar bytes antes do `put`).

## 8. Segredos e criptografia

- Segredos **jamais** em DTOs, logs, front, commits ou mensagens de erro. Hook `guard-secrets.sh` **nega** commit de `.env`, chaves privadas e tokens reais (só `.env.example` com placeholders).
- Credenciais de integração cifradas com AES-256-GCM; `TOKEN_ENCRYPTION_KEY` obrigatória e **independente** do `JWT_SECRET` (rotacionar JWT não pode tornar dado indecifrável).
- Env validada com Zod no boot (fail-fast, mensagens claras, valida formato de chaves).
- DTOs de saída revisados: nunca expor `passwordHash`, `tokenHash`, credenciais ou material de sessão.

## 9. LGPD

- **Minimização por padrão**: coletar apenas o necessário; campos sensíveis exigem justificativa no ADR/PR.
- **Exportação**: endpoint de export completo por workspace (e por titular, quando aplicável), decifrando o que for do titular, **excluindo** hashes, tokens e segredos.
- **Exclusão**: exclusão de workspace via cascade a partir de `Workspace`; exclusão de titular (contato) com propagação definida por entidade; prazos documentados.
- Verticais com dado sensível (ex.: Clinics/saúde) herdarão esta base e adicionarão requisitos próprios — o Core já minimiza e audita.

## 10. Checklist de segurança por PR

- [ ] Tabela nova tem `workspaceId`, entrou em `WORKSPACE_MODELS` e tem FK composta onde referencia entidade de workspace?
- [ ] Nenhum uso novo de `raw` sem comentário de justificativa nas exceções do §2?
- [ ] Nenhuma operação unsafe (`findUnique`/`update`/`delete`/`upsert`) em modelo protegido?
- [ ] Endpoint novo tem `@RequirePermissions` (ou `@AuthenticatedOnly()`/`@Public()` explícitos e justificados)? Sem decorator = negado pelo guard e achado P1/P0.
- [ ] DTO de saída não expõe segredo/hash/token?
- [ ] Mutação relevante grava `AuditLog` com allowlist?
- [ ] Efeito externo passa por outbox?
- [ ] Mudança em auth/tenancy/RBAC passou por `security` + `reviewer`?

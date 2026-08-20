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
- `prisma.raw` (excepcional, sempre com comentário justificando): identidade global (`User`, `RefreshToken`), autenticação (lookup por e-mail), resolução de convite por `tokenHash` (o aceite acontece antes de existir workspace no contexto — resolve `tokenHash → workspaceId` via raw e abre `cls.run({ workspaceId })` para o restante), provisionamento controlado de workspace, jobs cross-workspace (`runForAllWorkspaces` + `cls.run()`), rotinas administrativas explicitamente justificadas. **Membership, Role, Team, Invite e todo dado de acesso por workspace são tenant-scoped e usam `db`.**
- O `db` é fail-closed nos DOIS sentidos: modelo fora de `WORKSPACE_MODELS` (User, Workspace, Permission…) é **proibido** no `db` (erro apontando para `raw`), SQL cru é proibido no `db`, e travessias `include`/`select`/`where`/`orderBy` que saem do perímetro protegido (ex.: `membership → user → memberships`) são bloqueadas — o hook do Prisma não intercepta relações aninhadas, então o client valida a árvore inteira. Escrita aninhada por relação também é rejeitada (use FKs escalares) e `data.workspaceId` divergente do contexto é rejeitado.

**Camada 2 — Integridade no banco (FKs compostas):** entidades referenciáveis declaram `@@unique([workspaceId, id])`; relações entre entidades de workspace usam `FOREIGN KEY (workspaceId, xId) REFERENCES X(workspaceId, id)`. Obrigatório em: Membership→Role, Team→Membership, Deal→Contact/Pipeline/Stage, Message→Conversation, Notification→Membership, extensões verticais→Contact — e default para toda relação futura entre entidades de workspace.

**Camada 3 — Verificação contínua:**

- Teste de integração de segurança **P0** contra Postgres real (`prisma.multitenant.integration-spec.ts` na Fase 2): create carimba o workspace do CLS; A não lê B; `updateMany` de A não alcança linha de B; query sem contexto é bloqueada; operação unsafe é bloqueada. Se falhar, é vazamento — trate como incidente.
- Script `check:fk` que varre o banco procurando FKs que cruzam fronteira de workspace (exit 1 se sujo; imprime só IDs).

**Camada 4 (futura, ADR com gatilho):** RLS no Postgres como defesa em profundidade contra uso indevido de `raw` — gatilho: primeiro cliente enterprise ou incidente de quase-vazamento.

## 3. Autenticação e sessões

- **Access token**: JWT curto (15 min), claims `sub`, `membershipId`, `workspaceId`, `tokenVersion`, `email`.
- **Refresh token**: aleatório (48 bytes), armazenado **só como SHA-256**, TTL 30 dias, **rotação real**. **Reuso de token revogado = sessão comprometida**: revoga todos os refresh tokens do usuário **e incrementa `tokenVersion` de todas as memberships ativas** — access tokens já emitidos caem na request seguinte.
- **Workspace ativo da sessão**: `RefreshToken.activeMembershipId` com **FK composta `(userId, activeMembershipId) → Membership(userId, id)`** (nativa no schema, rastreada pelo Prisma) — o banco garante que a membership pertence ao dono do token; validação de serviço não basta.
- **Origin + CSRF**: além do double-submit (`x-csrf-token` = cookie), toda mutação sem `Authorization: Bearer` valida `Origin` (ou `Referer`) contra `WEB_ORIGIN` — inclusive as `@Public` que usam/emitem cookies (login/refresh/aceite); CORS sozinho não impede formulário cross-site. `POST /auth/logout` é `@AuthenticatedOnly()`.
- **Revalidação por request**: o `JwtAuthGuard` não confia nos claims do JWT — a cada request revalida no banco (via `raw`) que a **sessão** (`RefreshToken` do `sessionId`) está viva, o **User** está ativo e, havendo workspace, a **membership** está ativa com `tokenVersion` casando e o **workspace** ativo. Logout, reuso, suspensão de user/workspace e revogação valem na request seguinte. JWT com `issuer`/`audience` fixos e algoritmo pinado (`HS256`) — token assinado com o mesmo segredo para outro fim não é aceito como access token.
- **Convites**: aceite transacional e à prova de corrida (marcação condicional `acceptedAt: null` + advisory lock; P2002 de convites concorrentes vira 400, nunca 500). **Prova de identidade obrigatória** (não há takeover pelo token): e-mail com conta existente exige a **senha da conta** — o token, que o criador do convite conhece, não autentica sozinho nem permite pivô entre workspaces; e-mail novo exige nome + senha (cria a conta — única porta de entrada, ADR-014). Mensagem de erro **única** para token inválido/expirado/reutilizado/já-membro/senha-errada. Provisionamento com owner sem conta cria **Invite Owner** (nunca User incompleto); o token aparece uma única vez no CLI e só o hash persiste.
- **Invariante conhecida (aceite pré-registro)**: aceitar convite de e-mail **sem** conta cria a conta com a senha informada no aceite; um convidante mal-intencionado poderia pré-criar uma conta para um e-mail alheio, mas o acesso resultante fica **restrito ao workspace do convite** (sem registro público, sem pivô cross-tenant). Fecha totalmente quando houver verificação de e-mail (pós-MVP).
- **Transporte**: cookies `httpOnly` + `Secure` + `SameSite=Lax` (nunca localStorage). Mutações protegidas por token CSRF (double-submit).
- **Senhas**: hash com custo adequado (argon2id preferido; bcrypt aceitável), política mínima de tamanho, sem regra de composição arbitrária.
- **Guard global**: endpoints privados por padrão; `@Public()` é opt-out explícito e revisável.
- **Revogação imediata**: `Membership.tokenVersion` viaja no JWT. Remover/desativar membership ou alterar role/permissões incrementa a versão → access tokens antigos falham na próxima validação. Operações sensíveis (billing, exclusão, export) revalidam a membership viva no banco.
- **Sem registro público no MVP**: workspaces são provisionados de forma controlada; usuários entram por convite. Onboarding self-service só após billing, quotas, rate limit e antiabuso (ADR).

## 4. Autorização — RBAC por permissões

- `Permission` = catálogo global de chaves estáveis (`contacts:read`, `deals:write`, `billing:manage`, `intelligence:approve`…). Código só conhece chaves.
- `Role` sempre pertence a um workspace. Padrões (Owner/Admin/Member/Guest) semeados no provisionamento com `isSystem=true` — não editáveis nem deletáveis. Roles customizados pertencem ao workspace.
- `PermissionsGuard` global (segundo APP_GUARD, depois do JwtAuthGuard) com **default-deny**: endpoint privado **sem** `@RequirePermissions(...)` é **negado** — estar autenticado não basta. Rota que legitimamente precise apenas de autenticação usa `@AuthenticatedOnly()` explícito, raro e revisável (ex.: `GET /me`, troca de workspace). `@Public()` continua sendo a única exceção para endpoint não autenticado. Endpoint privado sem nenhum decorator é achado de revisão P1 — P0 se expõe dado ou mutação sensível (ADR-016).
- **Proibido** ramificar por nome de role. Invariantes de ciclo de vida usam `Role.systemKey` (`'owner'|'admin'|'member'|'guest'`, ADR-017), nunca o nome. Auditoria de RBAC via skill `review-rbac`.
- **Invariantes de gestão de acesso** (Entrega 2): ninguém altera/remove a própria membership; papel atribuído (troca de role ou convite) deve ser **subconjunto** das permissões do ator — ninguém concede o que não tem; o **último Owner ativo** não pode ser rebaixado nem removido; toda mudança de role/status incrementa `tokenVersion` (revogação imediata).
- API pública: `ApiKey` com `scopes` = subconjunto de permission keys; mesmo guard.

## 5. Auditoria (com minimização)

- `AuditLog(workspaceId, actorType[user|ai|system|api], actorId, action, entityType, entityId, before, after, requestId)` — append-only, gravado nos services de mutação relevante.
- **Minimização obrigatória**: `before/after` seguem **allowlist de campos auditáveis por entidade** (ex.: Deal: stage, amount, owner, status). Nunca entram: conteúdo de mensagens/conversas, corpo de anexos, segredos/hashes/tokens, dados clínicos de verticais futuros. Campos fora da allowlist aparecem como `"[changed]"`.
- Ações de IA sempre auditadas (`actorType: 'ai'` + link para `AiRun`).
- **Retenção**: 365 dias online por padrão (`AUDIT_RETENTION_DAYS`, faixa 30–3650), com job diário de expurgo (`audit-retention`, 04:00). Arquivamento frio fica para depois.
- **Append-only imposto tecnicamente** (ADR-019): `Activity` e `AuditLog` estão em `APPEND_ONLY_MODELS` e o client protegido rejeita `update*/delete*/upsert`. Exclusão só por cascade do dono (LGPD) ou pelo job de retenção via `raw`.
- **Ator**: `actorMembershipId` (FK composta) para usuário do workspace; `actorId` para origem não-usuária (API key, job, AiRun) — nunca token, sempre identificador.
- **Fidelidade**: `before`/`after` registram apenas as chaves que a mutação enviou; campo não enviado não aparece. Trilha com falso positivo é pior que trilha ausente. Export LGPD não inclui audit log de outros atores.

## 6. Rate limit, quotas e idempotência

- Rate limit por IP (throttler global) **e por workspace** (`WorkspaceThrottleGuard`, janela deslizante em memória, 429 com `Retry-After`) — um tenant abusivo não derruba os outros. Multi-instância exige Redis (dívida com gatilho).
- Quotas por plano (`UsageLimit`/`UsageCounter`): contatos, mensagens, storage, runs de IA. Exceder = 429/402 com mensagem clara, nunca degradação silenciosa.
- `Idempotency-Key` nas mutações marcadas com `@Idempotent()` (ADR-020): reserva atômica antes de executar, replay só com hash idêntico (método + rota + params + query + body), 409 para chave reutilizada com request diferente. Rota que devolve segredo NUNCA é idempotente.
- **Quotas por workspace** (ADR-032/033): o incremento acontece dentro da transação de domínio e o limite é conferido sobre o valor já somado — estourou, o rollback desfaz tudo. Custo de IA é **reservado antes** da chamada ao provedor e liquidado pelo custo real. Estouro devolve **402** com `{ code: 'quota_exceeded', metric, limit, current, resetsAt }`. Rate limit (por instância, em memória) e quota (regra comercial, no banco) são mecanismos SEPARADOS de propósito.
- Efeitos externos idempotentes via `dedupeKey` + unique tenant-scoped, entregues pelo outbox (ADR-021).
- Outbox transacional para todo efeito externo (webhooks out, e-mail, mensagens) — retry com backoff, sem efeito dentro da transação de domínio.
- Notificação é caixa **pessoal**: `/api/notifications` usa `@AuthenticatedOnly()` (ADR-016) porque não existe acesso à caixa alheia para conceder — o destinatário é sempre a membership da sessão, imposto no service, e id de outra pessoa devolve 404. Payload por allowlist Zod `.strict()` por tipo, como no outbox e na timeline.
- Claim do outbox com **lease + fencing token**: só o dono do `claimToken` corrente conclui o evento; worker lento que perdeu o lease é recusado, entrega longa renova por heartbeat e perde-o abortando o fan-out. Teto de 20 webhooks por workspace mantém a entrega sequencial dentro do lease.

## 7. Arquivos

Política obrigatória para `FileObject`:

1. **Validação de tipo real** por magic bytes — nunca confiar no mimetype declarado; extensão×conteúdo divergentes = rejeição.
2. **Limite de tamanho** por arquivo e quota de storage por workspace (plano).
3. **Storage prefixado por workspace** (`{workspaceId}/...`) — o prefixo é derivado do CLS, nunca de input do cliente.
4. **Autorização no download**: URL nunca é pública; download passa por endpoint autenticado (ou URL assinada de curtíssima duração) que checa permissão + workspace.
5. **Antivírus/quarentena**: `scanStatus` (pending/clean/quarantined) no modelo desde o início; arquivo só é servível a terceiros/canais externos quando `clean`. Integração de scanning pode ser adiada, o estado não.
6. Cifra na borda para conteúdo sensível (cifrar bytes antes do `put`). **Ainda não implementado** — dívida com gatilho em `docs/MEMORY/technical-debt.md`.

**Como está implementado (Entrega 6.3):** allowlist fechada de sete tipos com sniffer próprio (ADR-025) — PNG, JPEG, GIF, WebP, PDF, ZIP/OOXML e texto; **SVG fora**, por ser XML executável. Texto só passa se for UTF-8 válido **sem bytes de controle** (só NUL não basta: um binário pequeno pode não ter nenhum). Extensão que diverge do conteúdo é rejeitada. Chave `{workspaceId}/{uuid}{ext}` derivada do CLS e validada contra travessia. `FileObject` **nunca nasce `clean`**; `quarantined` não é servido nem internamente; `pending` baixa internamente mas **não sai para canal externo** (`assertSendableExternally`, no caminho por onde o primeiro provider vai passar). Download é sempre autenticado + `files:read`, com `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, CSP `sandbox` e o **MIME detectado**. Limites: 10 MB por arquivo, 1 arquivo por requisição. Exclusão física sai da transação e vai pelo evento **interno** `file.purge` do outbox, que nunca é entregue a webhook de cliente (a chave de storage não vaza).

## 7-B. Webhooks de saída (ADR-021)

1. Só `https`, sem credenciais na URL, sem redirects, timeout de 5s, corpo descartado com teto.
2. **Anti-SSRF com pinning**: todos os IPs resolvidos são classificados por `ipaddr.js` (loopback, privado, link-local, CGNAT, ULA, IPv4-mapeado e metadata de nuvem são recusados) e a conexão usa exatamente o IP validado — `fetch`/undici ignoraria o `agent`, então a entrega usa `https.request`.
3. Assinatura `x-veyra-signature: t=<ts>,v1=HMAC_SHA256(secret, "<ts>.<body>")`; o timestamp na assinatura impede replay.
4. Segredo cifrado (AES-256-GCM, chave independente do JWT) e exibido **uma única vez** na criação — nunca em DTO, log ou auditoria.
5. Payload por allowlist do evento; 3 entregas mortas consecutivas pausam **apenas** o webhook que falhou.

## 7-C. IA (Entrega 7)

1. **Sem acesso a banco**: `src/intelligence` não importa Prisma — portas no módulo, adaptadores fora (ADR-027), verificado por lint e por teste de fronteira. Leitura de domínio só por serviços de domínio, que já carregam tenant + RBAC + auditoria.
2. **Consentimento default-deny** (ADR-028): sem `AiConsent.conversationContent`, corpo de mensagem não entra em prompt algum e **nenhuma chamada ao provedor acontece**. Alternar exige `workspace:manage` e é auditado.
3. **Prompt injection**: conteúdo escrito por terceiros entra sempre delimitado e **rotulado como não confiável**; o modelo não tem ferramenta de escrita (ADR-029); a saída é validada por Zod `.strict()`; e ação externa só existe como `AiProposal` aprovada por humano. O resumo ainda sinaliza `injectionAttempt` para quem lê.
4. **Aprovar não amplia poder**: aprovar uma proposta exige `intelligence:approve` **e** a permissão do domínio afetado (`tasks:write`). O payload é revalidado no aceite — a linha pode ter sido adulterada entre a proposta e a aprovação.
5. **Registro sem vazamento**: `AiRun` guarda descrição do contexto, tokens, custo e um `reasonCode` curto. Nunca corpo de mensagem, prompt bruto, segredo ou stack trace — vale também para runs recusados e com erro.
6. **Custo**: `model` e contagens cruas ficam gravados junto do `costCents`, para que erro de tabela de preço seja recalculável.
7. **Execução atômica e autoria** (ADR-030): reivindicar → criar → registrar → concluir numa transação só; a mutação é registrada com `actorType='ai'` e `actorId=AiRun.id`, com o aprovador preservado como contexto.
8. **Resultado persistido** (ADR-031): `AiRun.result` guarda a saída validada, servida apenas pelo endpoint do alvo com a permissão do domínio. A visão de custo (`workspace:manage`) não devolve resultado. A fila de propostas exige `intelligence:approve` + `contacts:read`: uma role só com `intelligence:use` não infere pelo feed de IA o que não pode ler no CRM.

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

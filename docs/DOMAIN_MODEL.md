# DOMAIN_MODEL — Veyra Core

Modelo inicial. Nomes de entidades em inglês (código), descrições em pt-BR. Nada aqui é migration ainda — o schema Prisma só nasce na Fase 2.

## 1. Convenções

- IDs: `String @id @default(uuid()) @db.Uuid`.
- `createdAt @default(now())` + `updatedAt @updatedAt` em tudo.
- Toda entidade de domínio: `workspaceId String @db.Uuid` obrigatório, relação com `Workspace` com `onDelete: Cascade`, índices compostos liderados por `workspaceId` (`@@index([workspaceId, ...])`), uniques tenant-scoped (`@@unique([workspaceId, ...])`).
- Toda entidade referenciável por outra entidade de workspace declara `@@unique([workspaceId, id])` para permitir **FKs compostas** (`FOREIGN KEY (workspaceId, xId) REFERENCES X(workspaceId, id)`) — impedindo relações cross-tenant no próprio banco.
- Dinheiro: `Int` em centavos + `currency` (ISO 4217).
- Sem soft delete genérico; `archivedAt`/`status` onde fizer sentido; exclusão LGPD via cascade a partir de `Workspace` (e de `User` para dados globais).

## 2. Identidade e acesso

```mermaid
erDiagram
    User ||--o{ Membership : "participa"
    User ||--o{ RefreshToken : "sessões"
    Workspace ||--o{ Membership : "tem"
    Workspace ||--o{ Role : "define"
    Workspace ||--o{ Team : "organiza"
    Workspace ||--o{ Invite : "convida"
    Role ||--o{ Membership : "atribui"
    Role }o--o{ Permission : "concede"
    Team ||--o{ TeamMember : ""
    Membership ||--o{ TeamMember : ""
```

| Entidade         | Escopo                | Campos-chave                                                                     | Notas                                                                                                                                                          |
| ---------------- | --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`           | **Global**            | email único, name, passwordHash, status                                          | Sem `workspaceId`. Acesso via `raw` justificado                                                                                                                |
| `RefreshToken`   | Global                | userId, tokenHash (SHA-256) único, expiresAt, revokedAt                          | Rotação real: refresh usado é revogado                                                                                                                         |
| `Workspace`      | —                     | name, slug único, status, settings                                               | Raiz do tenant; cascade para tudo                                                                                                                              |
| `Membership`     | Workspace             | userId, workspaceId, roleId, status (active/suspended/removed), **tokenVersion** | Tenant-scoped. `@@unique([workspaceId, userId])`. `tokenVersion` invalida sessões em revogação/mudança de permissão                                            |
| `Role`           | Workspace             | name, isSystem, description                                                      | **Sempre do workspace**. Padrões (Owner/Admin/Member/Guest) semeados no provisionamento com `isSystem=true` (não editáveis/deletáveis). Não existe Role global |
| `Permission`     | **Global (catálogo)** | key estável (`contacts:read`, `deals:write`, `settings:billing`…)                | Exceção documentada à regra do workspaceId: é catálogo do sistema, não dado do tenant                                                                          |
| `RolePermission` | Workspace             | roleId (FK composta), permissionKey                                              | Junção role↔permissão                                                                                                                                          |
| `Team`           | Workspace             | name                                                                             | `TeamMember` liga a `Membership` com FK composta                                                                                                               |
| `Invite`         | Workspace             | email, roleId (FK composta), tokenHash, expiresAt, acceptedAt                    | Sem registro público: convite é a porta de entrada                                                                                                             |

JWT: `sub` (userId), `membershipId`, `workspaceId` ativo, `tokenVersion`. Troca de workspace reemite token.

## 3. Relacionamento (CRM)

```mermaid
erDiagram
    Company ||--o{ Contact : "emprega"
    Contact }o--o{ Tag : ""
    Company }o--o{ Tag : ""
    Contact ||--o{ CustomFieldValue : ""
    Pipeline ||--o{ Stage : "ordena"
    Stage ||--o{ Deal : "contém"
    Contact ||--o{ Deal : "protagoniza"
    Deal ||--o{ Activity : ""
    Contact ||--o{ Activity : ""
```

| Entidade                | Campos-chave                                                                                                                  | Notas                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Contact`               | name, emails[], phones[], companyId?, ownerId? (membership, FK composta), source, status                                      | A entidade que verticais estendem (ex.: paciente)                                                 |
| `Company`               | name, domain, size, ownerId?                                                                                                  |                                                                                                   |
| `Tag`                   | name, color, `@@unique([workspaceId, name])`                                                                                  | Junções `ContactTag`/`CompanyTag` com FKs compostas                                               |
| `CustomFieldDefinition` | entityType (contact/company/deal), key, label, type (text/number/date/select/multiselect/boolean), options, required          | Definição por workspace                                                                           |
| `CustomFieldValue`      | definitionId (FK composta), entityId + entityType, value (JSONB validado pelo type)                                           | Único mecanismo "genérico" permitido — e mesmo assim tenant-scoped e tipado pela definição        |
| `Pipeline`              | name, isDefault                                                                                                               |                                                                                                   |
| `Stage`                 | pipelineId (FK composta), name, order, probability?, type (open/won/lost)                                                     |                                                                                                   |
| `Deal`                  | title, pipelineId, stageId, contactId?, companyId?, ownerId?, amountCents, currency, expectedCloseDate, status, stalledSince? | FKs compostas para Pipeline/Stage/Contact/Company. Base do lead scoring e da previsão de pipeline |

## 4. Trabalho e timeline

| Entidade   | Campos-chave                                                                                                                                                                                                                                      | Notas                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Task`     | title, description, dueAt, assigneeId? (membership), status, priority, contactId?, dealId?                                                                                                                                                        | FKs compostas nas referências                                                                                                                                                                                                             |
| `Note`     | body, authorId (membership), contactId?, companyId?, dealId?                                                                                                                                                                                      |                                                                                                                                                                                                                                           |
| `Activity` | type (enum: task_completed, deal_moved, note_added, message_sent, meeting_held, file_attached, ai_action, …), actorType (user/ai/system/api), actorId?, occurredAt, payload mínimo, **contactId?, companyId?, dealId?, conversationId?, taskId?** | **Sem relação polimórfica sem integridade**: referências são colunas FK opcionais tipadas, todas com FK composta (workspaceId, x). Associações mais genéricas só futuramente, e apenas se preservarem FKs e isolamento (registrar em ADR) |

A timeline de um contato/deal é a consulta de `Activity` pelos FKs explícitos — auditável e tenant-safe.

## 5. Comunicação

Implementado na Entrega 6.1 (ADR-023). A API aceita **somente** canal `internal`; `email`/`whatsapp` estão reservados no enum, sem provider.

| Entidade       | Campos-chave                                                                                                                                                                                                                                                                                                                                                             | Notas                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Channel`      | type (internal/email/whatsapp), name, **systemMark** (TRUE/NULL)                                                                                                                                                                                                                                                                                                         | Exatamente **um** canal interno por workspace: `@@unique([workspaceId, systemMark])` + CHECK (`systemMark` só TRUE, e só em `internal`)                                                |
| `Conversation` | channelId (FK composta), contactId? (FK composta), subject?, status (open/pending/closed), assigneeMembershipId? (FK composta), **lastMessageAt NOT NULL**                                                                                                                                                                                                               | `lastMessageAt` já nasce preenchido — o keyset do inbox `(lastMessageAt, id)` não tem caso especial de null. Mensagem em conversa fechada a reabre                                     |
| `Message`      | conversationId + channelId em **FK TRIPLA** `(workspaceId, channelId, conversationId) → Conversation(workspaceId, channelId, id)` — o canal da mensagem é obrigatoriamente o da conversa; `channelId` é derivado da conversa no servidor, direction (inbound/outbound), authorType, authorMembershipId?/authorContactId? (FKs compostas), body, deliveredAt, externalId? | **Append-only** (`APPEND_ONLY_MODELS`). `@@unique([workspaceId, channelId, externalId])` para dedup de ingestão; `externalId` é id de OUTRO sistema, exceção documentada no `check:fk` |

O autor é **derivado da direção**, nunca informado pelo cliente: `outbound` → membership da sessão; `inbound` → contato da conversa (conversa sem contato recusa entrada). O envio manual é `@Idempotent()`: duplo clique não duplica mensagem nem `Activity`.

Timeline: `Activity` ganhou `conversationId` (FK composta) e os tipos `message_sent`/`message_received`, com **payload vazio** — o corpo da mensagem nunca entra na timeline.

## 6. Organização

Agenda e notificações implementadas na Entrega 6.2; arquivos entram na 6.3.

| Entidade        | Campos-chave                                                                                                                                                        | Notas                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CalendarEvent` | title, description?, startAt, endAt, location?, status (scheduled/done/canceled), organizerMembershipId, contactId?, dealId? — **todas as relações em FK composta** | **CHECK `endAt > startAt` no banco**, além do Zod. Consultado sempre por JANELA (eventos que intersectam `[from, to)`), nunca "tudo". Verticais especializam sem tocar nele |
| `Notification`  | recipientMembershipId (FK composta), type, payload (allowlist Zod `.strict()` por tipo), **dedupeKey**, readAt                                                      | `@@unique([workspaceId, dedupeKey])` — emissão idempotente. Caixa **pessoal**: o destinatário é sempre a membership da sessão, imposto no service                           |
| `FileObject`    | key (storage prefixado por workspace), fileName, mimeType detectado por magic bytes, sizeBytes, uploadedById, scanStatus (pending/clean/quarantined)                | Entrega 6.3. Política completa em SECURITY.md §7                                                                                                                            |

Emissão de notificação acontece **dentro da transação do fato que a origina** — notificação de evento que não existe é impossível. Hoje há dois produtores: evento agendado para outra pessoa e conversa atribuída a outra pessoa. Em ambos, quem age **não** se autonotifica (regra formalizada no ADR-026), e o `dedupeKey` é o par (fato, destinatário).

## 7. Plataforma

| Entidade                                 | Campos-chave                                                                                                                       | Notas                                                                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Automation`                             | name, trigger (evento de domínio), conditions, actions, enabled                                                                    | v1: triggers/ações de catálogo fechado                                                                                                  |
| `Webhook`                                | url, events[], secret cifrado, status                                                                                              | Entrega via outbox, assinatura HMAC                                                                                                     |
| `Integration` / `IntegrationCredential`  | provider, status / credenciais cifradas AES-256-GCM                                                                                | Sem SDK pesado por padrão                                                                                                               |
| `ApiKey`                                 | name, keyHash, scopes (permission keys), lastUsedAt, revokedAt                                                                     | API pública                                                                                                                             |
| `AuditLog`                               | actorType (user/ai/system/api), actorId?, action, entityType, entityId, before/after (allowlist + redaction), requestId, createdAt | Append-only; retenção em SECURITY.md                                                                                                    |
| `OutboxEvent`                            | eventType, payload, dedupeKey, status (pending/delivered/failed), attempts, nextRetryAt                                            | Gravado na transação de domínio                                                                                                         |
| `IdempotencyKey`                         | key, requestHash, responseSnapshot, expiresAt                                                                                      | `@@unique([workspaceId, key])`                                                                                                          |
| `Plan` / `PlanLimit` (globais, catálogo) | key, name, priceCents (**centavos de USD**) / metric, **kind** (counter\|gauge), value (BigInt)                                    | Catálogo global como `Permission`. Limites em LINHAS consultáveis, nunca JSON. `BigInt` porque bytes de storage estouram int32 em 2 GiB |
| `Subscription`                           | planKey, status, currentPeriodStart/End                                                                                            | Um por workspace; atribuída por **CLI administrativa** (ADR-034). Todo workspace tem uma — backfill garantiu os existentes              |
| `UsageCounter`                           | metric, period, value (BigInt)                                                                                                     | `@@unique([workspaceId, metric, period])` — alvo do incremento atômico. `period` é `YYYY-MM` para counters e vazio para gauges          |
| `UsageReservation`                       | metric, period, amount, expiresAt                                                                                                  | Reserva de custo de IA (ADR-033): o valor JÁ está no contador; esta linha existe para devolvê-lo se o processo morrer                   |

## 8. Inteligência

| Entidade        | Campos-chave                                                                                                                                                                                                       | Notas                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `AiRun`         | capability, promptVersion, model, contextSummary (mínimo, sem payload bruto), inputTokens, outputTokens, costCents, latencyMs, result (ok/error/refused), actionTaken (none/proposed/executed), triggeredByType/Id | Todo run persiste isto — base de custo por workspace e de evals |
| `AiProposal`    | runId, type (send_message/update_deal/create_task/…), payload, status (pending/approved/rejected/expired), reviewedById, reviewedAt                                                                                | MVP: toda ação externa passa por aqui                           |
| `PromptVersion` | (catálogo global) capability, version, hash, changelog                                                                                                                                                             | Prompt versionado fora do código de negócio                     |
| `AiConsent`     | flags de consentimento por workspace (ex.: usar conteúdo de conversas)                                                                                                                                             | Padrão opt-in: capacidade ausente ≠ check no execute            |

## 9. O que NÃO é modelado (deliberadamente)

- Qualquer conceito vertical: paciente, prontuário, imóvel, visitante, matrícula, apólice.
- Role global ou "super-admin de produto" no modelo de tenant (operação administrativa é rotina `raw` justificada, fora do RBAC de workspace).
- Relações polimórficas sem FK (`entityType + entityId` soltos) — exceto `CustomFieldValue` e `AuditLog`, que são tenant-scoped, não navegáveis e existem exatamente para isso.
- Event sourcing, CQRS, filas distribuídas.
- Registro público de usuário.

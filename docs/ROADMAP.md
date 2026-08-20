# ROADMAP — MVP do Veyra em entregas pequenas

Cada entrega é pequena, verificável e termina com testes passando. Nenhuma entrega começa sem a anterior estar "done" pelo checklist do CLAUDE.md §6. Status: 🔜 planejado · 🚧 em andamento · ✅ concluído.

## Entrega 0 — Scaffold e esteira ✅

Monorepo pnpm (`apps/api`, `apps/web`, `packages/contracts`, `packages/config`), TypeScript strict, ESLint + Prettier, docker-compose (Postgres), CI com jobs paralelos (typecheck/build com Postgres efêmero, testes, e2e, docker build), guardas de banco de teste (`assertIsTestDb`/`assertIsE2eDb`).
**Pronto quando:** CI verde num repo que não faz nada.

## Entrega 1 — Fundação de tenancy ✅

Prisma + primeira migration: `Workspace`, `User`, `Membership`, `Role`, `Permission`, `RolePermission`, `Invite`, `RefreshToken`. `PrismaService` com `db`/`raw`, `WORKSPACE_MODELS`, CLS. FKs compostas (Membership→Role). Seed do catálogo de permissões e roles de sistema.
**Pronto quando:** teste de segurança P0 de isolamento cross-workspace passa (create carimba; A não lê B; updateMany não cruza; sem contexto = erro; unsafe op = bloqueada) + `check:fk` limpo.

## Entrega 2 — Auth e RBAC ✅

Provisionamento controlado de workspace (CLI, sem registro público — ADR-014), login, refresh rotativo em cookie httpOnly + CSRF + validação de Origin, convites transacionais (emissão/aceite/revogação), troca de workspace, revogação por `tokenVersion` (ADR-009), `PermissionsGuard` default-deny (ADR-016), invariantes de último Owner e anti-autoelevação (ADR-017).
**Pronto quando:** ✅ fluxo de login/convite/revogação coberto por testes de integração HTTP (**supertest** — decisão aprovada: Playwright entra na Entrega 3 junto com as telas); remover/suspender membership derruba a sessão na request seguinte (testado).

## Entrega 3 — Contatos, empresas, tags e custom fields ✅

CRUD completo (contracts → api → web), tabela densa (TanStack Table) com busca/filtro/ordenação, custom fields tipados. Primeira tela real seguindo DESIGN_DIRECTION (tokens, densidade operacional).
**Pronto quando:** dois workspaces de teste não veem contatos um do outro (e2e); import básico por CSV.

## Entrega 4 — Pipelines, oportunidades e trabalho ✅

Pipelines/estágios configuráveis, deals com kanban, tarefas, notas, `Activity` com timeline por contato/deal (ADR-011).
**Pronto quando:** mover deal gera Activity; timeline consulta só por FKs explícitas; kanban denso e usável por teclado.

## Entrega 5 — Plataforma de confiança ✅

`AuditLog` com allowlist/redaction, rate limit (auth + API), `Idempotency-Key`, `OutboxEvent` + worker pg-boss, webhooks out com HMAC e retry.
**Pronto quando:** toda mutação relevante audita; webhook entrega com retry e dedupe; replay de Idempotency-Key devolve a mesma resposta.

## Entrega 6 — Comunicação e organização 🚧

- **6.1 — Conversas ✅** canal interno único por workspace (ADR-023), inbox denso com keyset, mensagem manual nos dois sentidos com autor derivado da direção, `@Idempotent()` no envio, `Message` append-only e timeline integrada sem corpo de mensagem.
- **6.2 — Agenda e notificações ✅** `CalendarEvent` com CHECK `endAt > startAt` no banco, FKs compostas e consulta por janela; `Notification` com `dedupeKey` idempotente e caixa pessoal (`@AuthenticatedOnly`); visão semanal e sino com polling de 60s.
- **6.3 — Arquivos 🔜** política do SECURITY.md §7 (magic bytes, prefixo por workspace, download autorizado, `scanStatus`), anexos em conversa, exclusão física pelo outbox.

**Pronto quando:** conversa manual ponta a ponta com timeline integrada (✅ 6.1); upload rejeita tipo divergente.

## Entrega 7 — `intelligence` v1 🔜

Infra do módulo (IntelligenceService, ToolRegistry condicional, PromptRegistry, `AiRun` com custo, `AiProposal` com aprovação). Três capacidades: **resumo de conversa**, **próxima ação**, **lead scoring explicável** (sinais determinísticos + LLM por cima). Evals com fixtures. IA na UI como sinais/insights (token `--ai`).
**Pronto quando:** cada run registra prompt/tokens/custo; nenhuma ação externa sem aprovação; evals das 3 capacidades verdes.

## Entrega 8 — Billing, limites e automações v1 🔜

Planos/assinaturas/quotas (`UsageLimit`/`UsageCounter` — contatos, mensagens, storage, runs de IA), automações de catálogo fechado (trigger → condição → ação), demais capacidades de IA (intenção, sugestão de resposta, oportunidade parada, limpeza de dados, previsão de pipeline) com evals.
**Pronto quando:** quota estourada degrada com mensagem clara; automação de confirmação funciona ponta a ponta.

## Fora do MVP (backlog consciente)

Registro público/self-service (gatilho: ADR-014), RLS (ADR-013), canais externos reais (e-mail/WhatsApp providers), app do vertical Clinics (só após Core estável até a Entrega 6), relatórios avançados, mobile, i18n além de pt-BR, exportação LGPD self-service (endpoint administrativo primeiro).

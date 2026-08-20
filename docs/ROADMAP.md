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

## Entrega 6 — Comunicação e organização ✅

- **6.1 — Conversas ✅** canal interno único por workspace (ADR-023), inbox denso com keyset, mensagem manual nos dois sentidos com autor derivado da direção, `@Idempotent()` no envio, `Message` append-only e timeline integrada sem corpo de mensagem.
- **6.2 — Agenda e notificações ✅** `CalendarEvent` com CHECK `endAt > startAt` no banco, FKs compostas e consulta por janela; `Notification` com `dedupeKey` idempotente e caixa pessoal (`@AuthenticatedOnly`); visão semanal e sino com polling de 60s. **Notifica apenas quando atribuído a OUTRA pessoa** — quem age não se autonotifica (ADR-026); quando há notificação, ela é única inclusive em retry.
- **6.3 — Arquivos ✅** allowlist com sniffer próprio (ADR-025), chave prefixada por workspace (ADR-024), download autenticado com `attachment`+`nosniff`, `scanStatus` com portão de saída externa, anexos em conversa e expurgo físico por evento interno do outbox.

**Pronto quando:** conversa manual ponta a ponta com timeline integrada (✅ 6.1); upload rejeita tipo divergente (✅ 6.3).

## Entrega 7 — `intelligence` v1 ✅

Módulo com **portas e adaptadores** (ADR-027): `src/intelligence` não importa Prisma, e a regra é verificada por ESLint **e** por teste de fronteira. SDK Anthropic direto atrás de `LLM_CLIENT`, **sem loop agêntico** na v1 (ADR-029): contexto permitido → chamada estruturada → validação Zod estrita → registro. Consentimento por workspace desligado por padrão (ADR-028) — sem ele não há sequer chamada ao provedor. Três capacidades: **resumo de conversa**, **próxima ação** (vira `AiProposal`, executada só após aprovação) e **lead scoring determinístico** com o LLM apenas explicando. Execução de proposta é atômica e registrada como ação da IA (ADR-030); `AiRun` persiste o resultado estruturado para a interface reaproveitar (ADR-031). Evals com fixtures gravadas, sem rede. UI: resumo no inbox e página de Sinais com propostas, consentimento e custo.
**Pronto quando:** cada run registra prompt/tokens/custo (✅); nenhuma ação externa sem aprovação (✅); evals das 3 capacidades verdes (✅).

## Entrega 8 — Billing, limites e automações ✅

- **8.1 — Uso e quotas ✅** `Plan`/`PlanLimit` globais com `kind` declarado (counter/gauge), `Subscription` por CLI administrativa e backfill do plano-base, incremento atômico dentro da transação de domínio, reserva-antes-de-chamar no custo de IA, 402 estruturado, tela de uso e plano. Métricas cobradas: contatos (gauge), storage (gauge), runs de IA e custo de IA (counters). `messages_sent` fica no catálogo **sem** enforcement enquanto o canal for interno/manual.
- **8.2 — Automações ✅** catálogo fechado trigger → condição → ação, `AutomationExecution` único por `(automationId, outboxEventId)`, causalidade em colunas do `OutboxEvent`, automações **antes** dos webhooks, teto de profundidade 3 com auditoria do corte, e `task.created` no catálogo público de eventos.

**Pronto quando:** quota estourada degrada com mensagem clara (✅ 8.1); "contato criado → tarefa de follow-up" funciona ponta a ponta (✅ 8.2).

As cinco capacidades de IA restantes deixaram de ser uma entrega própria (**ADR-036**): passam a ser priorizadas por dependência de canal e evidência de uso do piloto.

## Entrega 9 — Comunicação externa e privacidade operacional 🔜

Primeiro canal externo REAL, com as restrições da plataforma tratadas como requisito — não como detalhe de integração.

- **9.1 — WhatsApp oficial**: ingestão de mensagens, envio **sob aprovação humana**, status de entrega, **opt-in** registrado e janela de atendimento de 24h respeitada. Templates aprovados são pré-requisito do envio fora da janela. `messages_sent` ganha enforcement (a métrica já está no catálogo desde a 8.1).
- **9.2 — Privacidade operacional**: retenção e expurgo de `AiRun.result` (dívida registrada na Entrega 7) e **scanner de antivírus** antes de qualquer arquivo sair para canal externo — hoje `scanStatus` nunca deixa `pending`, e o portão de saída externa já existe esperando por isso.
- **9.3 — Sugestão de resposta**: a capacidade de IA entra AQUI, junto do canal, porque agora existe para onde enviar. Ação externa continua sendo `AiProposal` aprovada por humano.

**Pronto quando:** conversa real de WhatsApp entra e sai do Veyra com opt-in verificado; arquivo sem scan não sai para canal externo; `AiRun.result` expira por idade.

## Entrega 10 — Veyra Clinics (piloto vertical) 🔜

Vertical como **extensão** do Core (ADR-036 e §3.8 do CLAUDE.md): o Core continua sem conhecer o vocabulário clínico.

- Paciente (extension table 1:1 sobre `Contact`), profissional, agenda de consulta, procedimento, retorno e funil clínico.
- **Sem prontuário médico completo** no piloto — dado clínico sensível exige decisão própria de retenção, cifra e acesso.
- Fluxo comercial ponta a ponta: `lead → WhatsApp → agendamento → confirmação → consulta → retorno/reativação`.
- Métricas do piloto: **faltas, conversão e pacientes recuperados**.

**Pronto quando:** uma clínica opera o ciclo completo no Veyra e as três métricas são apuráveis.

## IA além disso — por demanda, não por pacote

`oportunidade parada` entra quando houver consultas e retornos reais para observar. `intenção`, `limpeza de dados` e `previsão de pipeline` nascem de sinais do piloto. Capacidade sem demanda observada não é roadmap (ADR-036).

## Fora do MVP (backlog consciente)

Registro público/self-service (gatilho: ADR-014), RLS (ADR-013), **canal de e-mail** (o WhatsApp vem primeiro — Entrega 9), prontuário médico completo no Clinics, relatórios avançados, mobile, i18n além de pt-BR, exportação LGPD self-service (endpoint administrativo primeiro).

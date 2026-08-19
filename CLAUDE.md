# CLAUDE.md — memória operacional do Veyra

Este arquivo é a memória operacional do projeto. Será mantido por múltiplos agentes ao longo de meses, não por uma única sessão. Um agente futuro sem memória de conversa deve conseguir entender o "porquê" de qualquer escolha só lendo `docs/`.

## 0. Antes de fazer qualquer coisa

Leia nesta ordem:

1. `docs/PRODUCT_BRIEF.md` — o que o produto é e o que o Core **nunca** modela.
2. `docs/ARCHITECTURE.md` + `docs/DOMAIN_MODEL.md` — como o sistema é organizado.
3. `docs/SECURITY.md` — o modelo de isolamento multi-tenant (a decisão mais importante do projeto).
4. `docs/DECISIONS.md` — ADRs. Toda decisão estrutural nova vira ADR **antes** do código.

## 1. Visão em uma frase

CRM Core SaaS multi-tenant com IA nativa (`intelligence`), contendo apenas capacidades universais; verticais (ex.: Veyra Clinics) estendem o Core sem duplicá-lo e o Core não conhece nenhum vertical.

## 2. Stack (não é negociável sem novo ADR)

pnpm monorepo · TypeScript strict ponta a ponta · NestJS (monólito modular) · React + Vite · PostgreSQL + Prisma · Zod em `packages/contracts` · OpenAPI para API pública · TanStack Query/Table + React Hook Form + Tailwind · Radix/shadcn apenas como primitivos acessíveis · pg-boss · Docker · Jest/Vitest/Playwright.

## 3. Princípios obrigatórios

1. **Multi-tenant por padrão.** Toda entidade de domínio nova tem `workspaceId` obrigatório, entra em `WORKSPACE_MODELS` e ganha índices compostos liderados por `workspaceId`. Nunca crie tabela de domínio sem workspace "porque por enquanto é só um cliente".
2. **Isolamento fail-closed na camada de dados.** O client Prisma filtrado (`prisma.db`) é a regra. Query sem workspace no contexto **lança erro**, não retorna tudo. Operações por chave única (`findUnique`/`update`/`delete`/`upsert`) são bloqueadas em modelos tenant-protegidos — use `findFirst`/`updateMany`/`deleteMany`.
3. **`prisma.raw` é exceção documentada.** Restrito a: identidade global (User/RefreshToken), autenticação, provisionamento controlado de workspace, jobs cross-workspace e rotinas administrativas justificadas. Cada uso leva comentário explicando o porquê.
4. **User global + Membership.** `User` não tem `workspaceId`. `Membership(userId, workspaceId, roleId, status, tokenVersion)` é a ponte e É tenant-scoped — assim como Role, Team e Invite. O JWT carrega `sub`, `membershipId` e o workspace ativo.
5. **RBAC por permissões, default-deny, nunca por nome de papel.** `Permission` é catálogo global e estável do sistema (ex.: `contacts:read`, `deals:write`) — exceção documentada à regra do `workspaceId`. `Role` sempre pertence a um workspace (padrões semeados com `isSystem=true`). O código checa permissões via `@RequirePermissions()`; jamais `if (role.name === 'admin')`. A `PermissionsGuard` é **default-deny**: endpoint privado sem `@RequirePermissions(...)` é negado — estar autenticado não basta. Rota que só precise de autenticação usa `@AuthenticatedOnly()` explícito (raro, revisável); `@Public()` é a única exceção não autenticada (ADR-016).
6. **Revogação de acesso é imediata.** Remover/desativar membership ou alterar permissões incrementa `tokenVersion` e invalida sessões. Operações sensíveis revalidam a membership viva.
7. **Integridade cross-workspace no banco.** Relações entre entidades de workspace usam FKs compostas (`FOREIGN KEY (workspaceId, xId) REFERENCES X(workspaceId, id)`) onde aplicável — Membership→Role, Deal→Contact/Pipeline/Stage, Team→Membership, extensões verticais→Contact.
8. **O Core não conhece verticais.** Nenhum módulo do Core importa, referencia ou "prevê" paciente, prontuário, imóvel, visitante ou qualquer conceito vertical. Verticais estendem por extension tables 1:1, custom fields e composição no bootstrap (`docs/ARCHITECTURE.md`).
9. **Contratos em `packages/contracts`, nunca duplicados.** Schemas Zod = entrada; interfaces TS = saída (DTO). Ordem de implementação: `packages/contracts` → `apps/api` → `apps/web`.
10. **IA só via ferramentas.** O módulo `intelligence` nunca toca o Prisma. Tools chamam serviços de domínio e herdam tenant + RBAC + auditoria. Ação externa no MVP = proposta pendente de aprovação humana. Todo run registra versão de prompt, contexto mínimo, tokens, custo, resultado e ação.
11. **Dinheiro sempre `Int` em centavos.** Nunca float.
12. **Segredos nunca em DTOs, logs ou front.** Tokens externos cifrados (AES-256-GCM, chave separada do JWT). DTOs de saída jamais expõem hash, token ou segredo.
13. **Auditoria com minimização.** Mutações relevantes geram `AuditLog`; `before/after` seguem allowlist de campos por entidade, com redaction e retenção definidas em `docs/SECURITY.md`.
14. **LGPD é preocupação permanente.** Minimização de dados por padrão; exportação e exclusão planejadas desde o modelo.
15. **Antes de construir, avalie integrar.** No planejamento de toda feature, pergunte "existe ferramenta madura/estável para isso?". Registre a escolha.

## 4. Padrões proibidos

| Proibido                                                           | Por quê                                                                                                        |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Tabela de domínio sem `workspaceId`                                | Quebra o modelo shared-database; retrofit é caríssimo                                                          |
| `findUnique`/`update`/`delete`/`upsert` em modelo tenant-protegido | Bypass silencioso do filtro de tenant                                                                          |
| `prisma.raw` fora das exceções do §3.3                             | Única superfície de erro humano do modelo de isolamento                                                        |
| Ramificar por nome de role                                         | RBAC é por permissão; nomes de papéis são dado do workspace                                                    |
| Endpoint privado sem decorator de autorização                      | Guard é default-deny; autenticado ≠ autorizado — use `@RequirePermissions` ou `@AuthenticatedOnly()` explícito |
| Camada Repository sobre o Prisma                                   | Service faz demais? Divida em dois services, não empilhe camada                                                |
| Microsserviço ou "camada genérica" sem ADR                         | Monólito modular é decisão (ADR-001)                                                                           |
| Conceito vertical no Core                                          | O Core origina verticais; não os conhece                                                                       |
| Segredo em DTO, log, front ou commit                               | Hook bloqueia commit; revisão de security é obrigatória                                                        |
| Float para dinheiro                                                | Erro de arredondamento em produção                                                                             |
| Migration destrutiva sem plano                                     | Hook exige confirmação; produção não tem undo                                                                  |
| Registro público de usuário                                        | Adiado até billing + quotas + rate limit + antiabuso (ADR)                                                     |
| Estado de servidor duplicado em store de UI                        | TanStack Query é a fonte; store só para UI/sessão                                                              |

## 5. Fluxo de desenvolvimento

1. Feature nova? Cheque `docs/ROADMAP.md` e avalie integrar vs. construir.
2. Decisão estrutural? ADR em `docs/DECISIONS.md` primeiro.
3. Implemente na ordem `packages/contracts` → `apps/api` → `apps/web`.
4. Mudança que toca auth, tenancy, RBAC, segredo ou migration → agentes `reviewer` + `security` **antes** do commit.
5. Atualize `docs/` no mesmo PR — drift de documentação é bug.

## 6. Definition of Done (checklist antes de qualquer commit)

- [ ] Build da API e do web passam (quando existirem).
- [ ] Toda tabela nova tem `workspaceId`, entrou em `WORKSPACE_MODELS` e tem índice composto.
- [ ] Nenhum segredo em texto plano; nenhum `.env` staged (só `.env.example`).
- [ ] Migration comitada junto do código que a usa.
- [ ] Testes relevantes passam; mudança em tenancy/RBAC tem teste de isolamento.
- [ ] `docs/` atualizado se comportamento ou decisão mudou.
- [ ] Push somente se pedido explicitamente.

## 7. Camada operacional `.claude/` vs documentação `docs/`

`docs/` é a referência completa; `.claude/` é a camada executável (agentes, skills, hooks) que **linka de volta** para `docs/` — nunca duplique o raciocínio inteiro nos dois lugares. Ao mudar um, atualize o outro.

| Executável        | Papel                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude/agents/` | architect, backend, frontend, database, security (read-only), qa, reviewer (read-only), intelligence                                                                           |
| `.claude/skills/` | create-module, create-entity, create-migration, create-api, create-vertical, review-rbac, review-tenant-isolation, implement-ai-capability, security-review, release-checklist |
| `.claude/hooks/`  | bloqueiam migration destrutiva, segredos em commit, mudança sensível em tenancy/RBAC sem revisão, push sem validação                                                           |

**Roteie proativamente**: mudanças em auth, tenancy, RBAC, segredos ou migrations exigem `reviewer` + `security` antes do commit — sem esperar ser pedido.

## 8. Regra de ouro para agentes de IA

Toda decisão arquitetural nova — mesmo pequena — vira ADR em `docs/DECISIONS.md` com contexto, alternativas e consequências. Se você sentiu necessidade de decidir algo que os docs não cobrem, o ADR é parte da entrega.

# NORTEIE_REFERENCE — o que o Veyra aproveita (e o que não) do Norteie

O Norteie (`/Users/aurelioromeu/repos/Malach/norteie`) é um sistema de gestão pessoal com IA: monorepo pnpm com `@norteie/api` (NestJS 11 + Prisma 7 + PG 17 + pg-boss + nestjs-cls), `@norteie/web` (React 19 + Vite + Tailwind v4) e `@norteie/shared` (Zod 4). É referência de **qualidade de engenharia e de processo** — não de domínio nem de identidade. Análise feita em modo somente leitura em 2026-08-19.

## 1. O que reaproveitar diretamente (padrões portados quase como estão, reescritos para `workspaceId`)

| Padrão | Origem no Norteie | Uso no Veyra |
|---|---|---|
| **Isolamento fail-closed por client extension** — `db`/`raw`, `TENANT_MODELS`, bloqueio de `findUnique`/`update`/`delete`/`upsert`, erro sem tenant no CLS | `apps/api/src/prisma/prisma.service.ts` | Base do ADR-002; `WORKSPACE_MODELS` |
| **Teste de segurança P0 de isolamento** | `prisma.multitenant.integration-spec.ts` | Obrigatório na Entrega 1 |
| **Script de varredura de FK cross-tenant** | `apps/api/scripts/check-cross-tenant-fk.ts` | `check:fk` no CI |
| **Env validada com Zod no boot** (fail-fast, valida formato de chaves) | `apps/api/src/common/env.ts` | Igual |
| **CryptoService AES-256-GCM** com chave separada do JWT (comentário explica o porquê) | `apps/api/src/common/crypto.service.ts` | Igual, para credenciais de integração |
| **ZodPipe** (safeParse → 400 com issues) + convenção "Zod = entrada, interface = saída" | `common/zod.pipe.ts` + `packages/shared` | `packages/contracts` |
| **Guard global + `@Public()`** (seguro por default) | `jwt-auth.guard.ts` + `common/decorators.ts` | Igual, mais PermissionsGuard |
| **Refresh token rotativo hasheado** (SHA-256, revokedAt) | `auth.service.ts` | Igual — mas em cookie, não localStorage (ver §3) |
| **`runForAllTenants` com `cls.run()`** por tenant + try/catch por tenant | `jobs/jobs.service.ts` | `runForAllWorkspaces` |
| **Idempotência por `dedupeKey`** + unique tenant-scoped capturando P2002 | `notifications.service.ts` | Notificações, outbox, webhooks |
| **Convenções de schema**: uuid `@db.Uuid`, dinheiro `Int` centavos, `@@index([tenantId, ...])`, uniques tenant-scoped, cascade da raiz | `prisma/schema.prisma` | Idênticas, com `workspaceId` |
| **Guardas de banco de teste**: `assertIsTestDb`/`assertIsE2eDb` (nome do DB deve conter "test"/"e2e"), TRUNCATE restrito a `public` | `test/integration/*`, `e2e/env.ts` | Idênticas |
| **CI com 4 jobs paralelos** (build+migrate em PG efêmero, unit+integration, e2e Playwright com DB próprio e portas próprias, docker build push:false) | `.github/workflows/ci.yml` | Mesma topologia + job de lint (lacuna do Norteie) |
| **Magic bytes para upload** (tipo real, não mimetype) | `storage/magic-bytes.ts` | Política de arquivos SECURITY.md §7 |
| **Filtro global de exceções só-5xx** enriquecido com CLS e rota registrada (sem query string) | `common/observability/` | Igual, sobre pino |
| **Test seam `E2E_FAKE_PROVIDERS`** ignorado em produção com warning | ADR-011 do Norteie | Igual para provedores externos |

## 2. O que reimplementar inspirado (a ideia vem do Norteie; a implementação é nova)

| Ideia | No Norteie | No Veyra |
|---|---|---|
| **Tools de IA delegando a services de domínio** (herdam isolamento) + **ToolSet condicional por consentimento** (capacidade ausente, não check no execute) + fallback determinístico + `stopWhen` | `assistant/` (assistant.tools.ts, insights.service.ts) | Módulo `intelligence` com governança maior: `AiRun` com custo/promptVersion (o Norteie **não** registra custo), `AiProposal` com aprovação humana, evals — docs/AI_ARCHITECTURE.md |
| **Modelo de identidade** | `User.tenantId` direto (single-user por tenant) | User global + Membership tenant-scoped + tokenVersion (ADR-003/009) — reimplementação completa |
| **Autorização** | `role` string sem enforcement (esboço no ADR-032 deles) | RBAC real por permissões, Permission global + Role de workspace (ADR-004) |
| **Pareamento `docs/` (referência) ↔ `.claude/` (executável)** com regra "atualize os dois lados, nunca duplique o raciocínio" | CLAUDE.md §9 deles | Mesmo princípio, árvore enxuta: começamos só com `.claude/` fino + docs de topo; a árvore `docs/AGENTS|SKILLS|WORKFLOWS|TEMPLATES` completa cresce sob demanda |
| **Disciplina de ADRs numerados referenciados no código** | 35 ADRs em `docs/DECISIONS.md` | Mesmo formato (Contexto/Alternativas/Decisão/Consequências); conteúdo 100% novo |
| **Método de design** (não a identidade): 3 fontes com papéis, tokens CSS-first Tailwind v4 sem config file, "uma única cor de marca gasta com parcimônia", shadcn à la carte com Radix só onde acessibilidade exige, `tabular-nums` em números, `prefers-reduced-motion` | `DESIGN.md` + `apps/web/src/index.css` | docs/DESIGN_DIRECTION.md — direção "Mineral" própria, claro-padrão (o Norteie é dark-padrão) |
| **Hooks defensivos** (stdin JSON + jq, filtro dentro do script porque o matcher não é confiável, `permissionDecision`) | `.claude/hooks/*.sh` | Mesma mecânica; escopo novo (migrations destrutivas, tenancy/RBAC, push sem validação) e **`deny`** para segredos — o Norteie só usa `ask` |
| **Estrutura de agentes** (Missão → Como pensa → Limites → Checklist; gradação de tools: reviewer read-only) | `.claude/agents/*` | 8 agentes do Veyra; `security` também read-only (mais restrito que no Norteie, onde security tem Edit) |
| **`docs/MEMORY/`** (sprint / decisões recentes / known-issues / dívida com "gatilho para resolver" / ideias) | `docs/MEMORY/*` | Adotar a partir da Entrega 0, quando houver estado vivo a registrar |

## 3. O que NÃO reaproveitar

- **Domínio e schema**: finanças, bíblia, saúde, hábitos, veículos, cofre — nada disso informa o CRM. Nenhum modelo Prisma é copiado.
- **Telas, módulos e conteúdo dos 35 ADRs**: são produto do Norteie.
- **Identidade visual "Carta Noturna"**: paleta latão/azul-grafite, dark-padrão, "Rumo do dia", logo estrela polar, voz "de bordo" — identidade deles; o Veyra tem direção própria (Mineral, claro-padrão).
- **Auth em localStorage** (Zustand persist): inaceitável para SaaS — o Veyra usa cookies httpOnly + CSRF (ADR-008).
- **`User.tenantId` direto**: substituído por User global + Membership.
- **Ausências que não são exemplo**: sem lint (Veyra terá ESLint+Prettier), sem RBAC, sem audit trail, sem rate limit, sem outbox, sem OpenAPI, sem logging estruturado, sem custo de LLM por tenant — tudo isso o Veyra constrói do zero (ver SECURITY.md e AI_ARCHITECTURE.md).
- **Premissas de deploy** (Coolify/VPS única, migrations no boot do container, sem staging): decisão de deploy do Veyra fica para a Entrega 0 — não herdada.
- **Armadilhas de tooling específicas** (Zod 4 obrigatório por AI SDK 7, `ToolSet` explícito para não estourar o `tsc`, cast do `$extends`): não são "padrões", são notas — ficam registradas e serão revalidadas nas versões que o Veyra adotar.

## 4. Como adaptar agents, skills, commands e hooks

**Formato adotado (igual ao Norteie):** arquivos finos em `.claude/` (30–60 linhas), frontmatter `name`/`description`/`tools`, corpo pt-BR, linkando para os docs de referência do Veyra em vez de duplicar raciocínio.

**Agentes — mapeamento:**

| Norteie (13) | Veyra (8) | Adaptação |
|---|---|---|
| architect | `architect` | Foco em boundaries de módulo, ADRs e estratégia de verticais |
| backend | `backend` | Módulos NestJS do Core; ordem contracts→api→web |
| frontend + ux | `frontend` | Fundidos: telas densas + DESIGN_DIRECTION |
| database | `database` | Schema, FKs compostas, migrations seguras |
| security (tinha Edit) | `security` **(read-only)** | Mais restrito: recomenda/revisa; correção é do agente da camada |
| qa | `qa` | Testes das 4 camadas + teste P0 de isolamento |
| reviewer (read-only) | `reviewer` (read-only) | Igual; obrigatório com security em auth/tenancy/RBAC/migration |
| — (assistant era domínio) | `intelligence` | Novo: capacidades de IA, tools, prompts, evals, custo |
| devops, documentation, integration, performance, refactoring | — | Não portados agora; responsabilidades absorvidas pelos 8 ou adiadas |

**Skills — mapeamento:**

| Norteie | Veyra | Adaptação |
|---|---|---|
| create-entity | `create-entity` | + entrada em WORKSPACE_MODELS, FK composta, permissões, allowlist de auditoria |
| create-api / create-controller / create-service | `create-api` | Unificadas; contrato Zod + permissão + OpenAPI se público |
| create-migration | `create-migration` | + checagem de destrutividade (par do hook) |
| — | `create-module` | Novo: módulo NestJS com boundary registrado no grafo |
| — | `create-vertical` | Novo: extension table 1:1 + composição (ADR-015) |
| review-checklist | `security-review` + `review-tenant-isolation` + `review-rbac` | Desmembrado em três revisões especializadas |
| — | `implement-ai-capability` | Novo: capacidade de IA ponta a ponta (tool → prompt versionado → AiRun → eval) |
| bug-fix, refactor, performance, create-integration, create-repository (anti-skill), documentation | — | Não portadas agora; a anti-skill do Repository virou o ADR-005 |
| /release (command) | `release-checklist` | Checklist de release como skill |

**Hooks — mecânica idêntica, escopo novo:**

| Veyra | Comportamento | Diferença vs Norteie |
|---|---|---|
| `block-destructive-migration.sh` | DROP TABLE/COLUMN, TRUNCATE, NOT NULL sem default em migrations → ask (deny para TRUNCATE/DROP TABLE em arquivo de migration) | Norteie só cobre git destrutivo |
| `guard-secrets.sh` | `.env` staged (exceto `.env.example`), private keys, tokens reais → **deny** | Norteie usa `ask`; Veyra nega |
| `guard-tenant-rbac.sh` | Edição de prisma.service/guards/decorators de permissão → contexto adicional; commit tocando esses arquivos → ask exigindo revisão security+reviewer | Novo |
| `block-unvalidated-push.sh` | `git push` → ask com checklist DoD (build/testes) | Evolução do dod-reminder (que só informava) |

Aprendizado operacional mantido: os hooks filtram **dentro do script** (o matcher do settings.json não é confiável), leem stdin JSON com `jq` e devolvem `{}` quando não se aplicam.

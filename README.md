# Veyra

> Nome provisório. CRM Core SaaS, multi-tenant, com IA nativa — projetado para originar produtos verticais sem que o Core conheça qualquer domínio vertical.

## O que é

O Veyra é um **CRM Core**: um conjunto de capacidades universais de relacionamento comercial (contatos, pipelines, conversas, tarefas, agenda, automações, IA) construído como SaaS multi-tenant desde a primeira linha. Produtos verticais — o primeiro provável é o **Veyra Clinics** — estendem o Core sem duplicá-lo. O Core **nunca** modela paciente, prontuário, imóvel ou visitante; verticais fazem isso por extensão (ex.: paciente = extensão de contato).

A IA não é um chat decorativo: é o módulo estrutural `intelligence`, que opera exclusivamente por ferramentas que chamam serviços de domínio — herdando isolamento de tenant, RBAC e auditoria — com aprovação humana para ações externas no MVP.

## Stack

| Camada                | Tecnologia                                                |
| --------------------- | --------------------------------------------------------- |
| Monorepo              | pnpm workspaces                                           |
| Linguagem             | TypeScript ponta a ponta (strict)                         |
| API                   | NestJS — monólito modular                                 |
| Web                   | React + Vite + TypeScript                                 |
| Banco                 | PostgreSQL + Prisma                                       |
| Contratos internos    | Zod em `packages/contracts`                               |
| API pública           | OpenAPI                                                   |
| Front (dados/UI)      | TanStack Query, TanStack Table, React Hook Form, Tailwind |
| Primitivos acessíveis | Radix/shadcn à la carte                                   |
| Jobs                  | pg-boss (mesmo Postgres)                                  |
| Testes                | Jest (API), Vitest (web), Playwright (e2e)                |
| Infra dev             | Docker (Postgres)                                         |

Monólito modular por decisão (ADR-001). Nada de microsserviços ou camadas genéricas sem necessidade demonstrada.

## Estado atual

**Fase 1 — fundação e documentação.** Este repositório contém apenas git, documentação e a camada operacional `.claude/`. O scaffold do monorepo, o schema Prisma e as telas só entram após aprovação explícita da Fase 2.

Estrutura proposta do monorepo (a scaffoldar após aprovação):

```
veyra/
├── apps/
│   ├── api/        # NestJS — módulos: auth, workspaces, contacts, companies,
│   │               #   pipelines, tasks, conversations, calendar, notifications,
│   │               #   files, automations, webhooks, integrations, audit,
│   │               #   billing, intelligence, prisma, common
│   └── web/        # React + Vite SPA
├── packages/
│   ├── contracts/  # Zod (inputs) + interfaces DTO (outputs) — fonte única
│   └── config/     # tsconfig/eslint compartilhados
├── docs/           # referência (já existe)
└── .claude/        # camada operacional para agentes (já existe)
```

## Como ler este repositório

Ordem de leitura para qualquer pessoa (ou agente) nova no projeto:

1. [CLAUDE.md](CLAUDE.md) — memória operacional: princípios inegociáveis, padrões proibidos, Definition of Done.
2. [docs/PRODUCT_BRIEF.md](docs/PRODUCT_BRIEF.md) — o que o produto é (e o que o Core nunca modela).
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — monólito modular, camadas, estratégia de verticais.
4. [docs/DOMAIN_MODEL.md](docs/DOMAIN_MODEL.md) — entidades e convenções.
5. [docs/SECURITY.md](docs/SECURITY.md) — isolamento de tenant, RBAC, auth, LGPD.
6. [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) — módulo `intelligence`.
7. [docs/DESIGN_DIRECTION.md](docs/DESIGN_DIRECTION.md) — direção visual.
8. [docs/DECISIONS.md](docs/DECISIONS.md) — ADRs numerados.
9. [docs/ROADMAP.md](docs/ROADMAP.md) — MVP em entregas pequenas.
10. [docs/NORTEIE_REFERENCE.md](docs/NORTEIE_REFERENCE.md) — o que veio (e o que deliberadamente não veio) do Norteie.

## Regras que não se negociam

- Toda entidade de domínio tem `workspaceId`; isolamento de tenant é **automático e fail-closed** na camada de dados.
- User é global; acesso a workspace é via `Membership` (tenant-scoped) com RBAC real por permissões.
- Testes provam que dois workspaces não acessam dados um do outro (P0).
- IA nunca acessa o banco diretamente; só ferramentas → serviços de domínio, com auditoria e aprovação humana no MVP.
- Segredos jamais em DTOs, logs ou front.

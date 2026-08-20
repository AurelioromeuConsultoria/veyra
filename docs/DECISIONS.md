# DECISIONS — ADRs do Veyra

Toda decisão arquitetural vira ADR **antes** do código. Formato abaixo. ADRs são imutáveis: mudou de ideia, escreva um novo que supersede o antigo.

## Template

```markdown
## ADR-NNN — Título

**Status:** aceito | supersedido por ADR-XXX | adiado (gatilho: ...)
**Data:** AAAA-MM-DD

### Contexto

### Alternativas consideradas

### Decisão

### Consequências
```

---

## ADR-001 — Monólito modular NestJS em monorepo pnpm

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** um desenvolvedor + agentes; SaaS multi-tenant que precisa nascer coeso e evoluir para verticais.
**Alternativas:** microsserviços (custo operacional injustificável agora); Next.js fullstack (API pública, jobs e workers pedem backend dedicado); serverless (pg-boss, outbox e conexões persistentes pedem processo longo).
**Decisão:** um app NestJS (monólito modular com boundaries de import explícitos), um SPA React+Vite, `packages/contracts` e `packages/config`, orquestrados por pnpm workspaces sem Turborepo.
**Consequências:** deploy simples, refactor barato entre módulos, disciplina de boundaries mantida por revisão + grafo documentado em ARCHITECTURE.md. Extração de serviço só com necessidade demonstrada em novo ADR.

## ADR-002 — Isolamento de tenant por Prisma Client Extension fail-closed

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** shared database multi-tenant; a ameaça nº 1 é vazamento entre workspaces; o filtro não pode depender de disciplina.
**Alternativas:** RLS no Postgres (mais robusto, porém complica Prisma/migrations/testes agora); schema-per-tenant (custo de migração e conexões); filtro manual por convenção (inaceitável).
**Decisão:** `PrismaService` com `db` (extension que injeta `workspaceId` do CLS, bloqueia `findUnique`/`update`/`delete`/`upsert` em modelos protegidos e lança erro sem contexto) e `raw` (excepcional, documentado). Padrão validado em produção no Norteie. Teste de segurança P0 + script `check:fk` obrigatórios.
**Consequências:** isolamento na camada de dados; `raw` é a única superfície de erro humano — restrita e revisada. RLS fica como defesa em profundidade futura (ADR-013).

## ADR-003 — User global + Membership tenant-scoped

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** um mesmo humano participa de vários workspaces; o Norteie usa `User.tenantId` direto, que não serve para SaaS.
**Alternativas:** user por workspace (duplicação de identidade, logins múltiplos); organizações aninhadas (complexidade sem demanda).
**Decisão:** `User` global (fora do filtro automático); `Membership(userId, workspaceId, roleId, status, tokenVersion)` é a ponte e é **tenant-scoped** — assim como Role, Team e Invite. JWT carrega `sub`, `membershipId`, `workspaceId` ativo e `tokenVersion`; troca de workspace reemite token.
**Consequências:** identidade única, revogação por workspace (ADR-009), dados de acesso isolados pelo mesmo mecanismo do domínio. `raw` para User/RefreshToken continua excepcional e justificado.

## ADR-004 — RBAC por permissões; Permission global, Role do workspace

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** CRM SaaS exige papéis customizáveis por cliente sem que o código conheça nomes de papéis.
**Alternativas:** roles fixos hardcoded (inflexível); ABAC/policy engine (overkill no MVP).
**Decisão:** `Permission` = catálogo **global** de chaves estáveis (`contacts:read`…) — exceção documentada à regra do `workspaceId`. `Role` **sempre** pertence a um workspace; padrões semeados no provisionamento com `isSystem=true` (não editáveis/deletáveis); customizados são do workspace. `PermissionsGuard` global + `@RequirePermissions()`. Proibido ramificar por nome de role.
**Consequências:** flexibilidade por tenant com catálogo estável; auditoria de RBAC viável (skill `review-rbac`); nenhum "role global" existe.

## ADR-005 — Sem camada Repository sobre o Prisma

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** tentação recorrente de "abstrair o ORM".
**Decisão:** services usam `prisma.db` diretamente. Se um service cresce demais, divide-se em dois services.
**Consequências:** menos indireção; o isolamento vive na extension (ADR-002), não numa camada; trocar de ORM (improvável) custaria refactor — aceito.

## ADR-006 — Contratos duais: Zod interno + OpenAPI público

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** back e front compartilham tipos; integrações externas precisam de contrato padrão.
**Alternativas:** só Zod compartilhado (sem contrato público); tRPC (acopla front, não serve API pública); só OpenAPI + codegen (perde inferência interna).
**Decisão:** `packages/contracts` com schemas Zod (entrada) + interfaces DTO (saída) para uso interno; OpenAPI gerado para a API pública versionada (`/api/v1`) desde o primeiro endpoint público — não retrofit.
**Consequências:** fonte única interna com custo zero de rede; superfície pública documentada e estável; duplicação controlada apenas na fronteira pública.

## ADR-007 — pg-boss para jobs; outbox transacional para efeitos externos

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** jobs recorrentes e entrega confiável de webhooks/e-mails sem infra extra.
**Alternativas:** BullMQ/Redis (mais uma peça de infra); cron do SO (sem retry/observabilidade); efeitos inline na transação (perde atomicidade).
**Decisão:** pg-boss no mesmo Postgres. Todo efeito externo grava `OutboxEvent` na transação de domínio; worker entrega com retry/backoff e `dedupeKey` idempotente. Jobs cross-workspace via `runForAllWorkspaces` + `cls.run()` por workspace.
**Consequências:** uma infra só; entrega ao-menos-uma-vez com dedupe; throughput do Postgres é o limite — aceitável por muito tempo.

## ADR-008 — Auth: JWT curto + refresh rotativo em cookie httpOnly

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** o Norteie guarda tokens em localStorage — inaceitável para SaaS (XSS exfiltra refresh).
**Decisão:** access JWT de 15min; refresh aleatório hasheado (SHA-256) com rotação real e revogação; transporte por cookies `httpOnly`/`Secure`/`SameSite=Lax`; CSRF double-submit nas mutações; guard global com `@Public()` como exceção.
**Consequências:** XSS não rouba sessão; exige CORS/CSRF bem configurados e cuidado com subdomínios de verticais no futuro.

## ADR-009 — Revogação de acesso por tokenVersion na Membership

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** remover alguém de um workspace precisa valer imediatamente, não em 15 minutos.
**Alternativas:** blacklist de JWT (estado por token); sessão em banco a cada request (custo).
**Decisão:** `Membership.tokenVersion` viaja no JWT; remoção/desativação/mudança de permissões incrementa a versão; o guard compara versão do token com a da membership (cacheada com invalidação); operações sensíveis revalidam a membership viva no banco.
**Consequências:** revogação imediata com um inteiro; custo de uma leitura cacheável por request.

## ADR-010 — Integridade cross-workspace por FKs compostas

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** a extension protege queries, mas uma FK simples permitiria `Deal.contactId` apontar para contato de outro workspace (vazaria via include).
**Decisão:** entidades referenciáveis declaram `@@unique([workspaceId, id])`; relações entre entidades de workspace usam `FOREIGN KEY (workspaceId, xId) REFERENCES X(workspaceId, id)` — obrigatório em Membership→Role, Team→Membership, Deal→Contact/Pipeline/Stage, extensões verticais→Contact, e default para relações futuras. Script `check:fk` verifica o estoque.
**Consequências:** o banco impede relação cross-tenant mesmo com bug de aplicação; migrations um pouco mais verbosas — preço correto.

## ADR-011 — Timeline com relações explícitas, sem polimorfismo sem integridade

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** timelines costumam usar `entityType + entityId` sem FK — sem integridade, sem isolamento verificável.
**Decisão:** `Activity` referencia por colunas FK opcionais tipadas (`contactId?`, `companyId?`, `dealId?`, `conversationId?`, `taskId?`), todas com FK composta. Associações mais genéricas só futuramente, e apenas se preservarem FKs e isolamento (novo ADR).
**Consequências:** timeline auditável e tenant-safe; adicionar um novo tipo referenciável = nova coluna + migration — custo aceito.

## ADR-012 — Módulo `intelligence`: tools sobre services, aprovação humana, custo registrado

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** IA nativa sem virar chat decorativo nem risco de vazamento/ação indevida.
**Decisão:** IA nunca acessa o banco; tools chamam services (herdam tenant+RBAC+audit); ToolSet montado condicionalmente por permissão/consentimento; ação externa vira `AiProposal` com aprovação humana no MVP; todo run persiste `AiRun` (promptVersion, tokens, custo, resultado, ação); prompts versionados; evals por capacidade.
**Consequências:** IA governada e faturável por workspace; latência extra da aprovação humana — desejada no MVP.

## ADR-013 — RLS no Postgres adiado

**Status:** adiado (gatilho: primeiro cliente enterprise, requisito de compliance, ou incidente de quase-vazamento) · **Data:** 2026-08-19

**Contexto:** RLS daria defesa em profundidade contra mau uso de `raw`, mas complica Prisma, migrations e testes agora.
**Decisão:** adiar, com as camadas 1–3 do SECURITY.md §2 como proteção. Reavaliar no gatilho.

## ADR-014 — Sem registro público no MVP

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** signup aberto sem billing, quotas, rate limit e antiabuso é passivo de segurança e de custo (especialmente com IA).
**Decisão:** provisionamento controlado de workspace + entrada por convite. Onboarding self-service só após billing, quotas, rate limit e política antiabuso implementados — novo ADR decidirá o formato.
**Consequências:** GTM inicial assistido; a fundação (auth, convites, provisioning) já suporta a virada de chave.

## ADR-015 — Verticais por extension tables + composição no bootstrap

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** verticais precisam estender o Core sem fork, e o Core não pode conhecê-los.
**Alternativas:** fork por vertical (duplicação letal); plugin registry no Core (Core "consciente" de domínios); tudo em custom fields (sem estrutura).
**Decisão:** extension tables 1:1 com FK composta para a entidade base (ex.: `ClinicsPatient.contactId → Contact`), custom fields para atributos simples, entidades próprias do vertical com as mesmas convenções, e composição de módulos no bootstrap do produto final. Dependência sempre vertical → Core.
**Consequências:** Core permanece universal; verticais evoluem sem tocar o Core; joins extras nas leituras estendidas — aceitável.

## ADR-016 — Autorização default-deny na PermissionsGuard

**Status:** aceito · **Data:** 2026-08-19

**Contexto:** o desenho original deixava a `PermissionsGuard` em pass-through quando o handler não tinha `@RequirePermissions` (rota já autenticada passava). Isso torna o esquecimento de decorator um furo silencioso de autorização: autenticado vira autorizado por omissão.
**Alternativas:** pass-through com lint rule (detecção, não prevenção); permissão default por convenção de rota (mágica implícita).
**Decisão:** a `PermissionsGuard` é **default-deny**: endpoint privado sem `@RequirePermissions(...)` é **negado** em runtime. Rota que legitimamente exija apenas autenticação usa `@AuthenticatedOnly()` explícito — raro e revisável. `@Public()` permanece a única exceção para endpoint não autenticado. Em revisão, endpoint privado sem decorator é achado **P1** — **P0** se expõe dado ou mutação sensível.
**Consequências:** esquecer decorator quebra o endpoint em dev/teste (falha visível) em vez de abrir acesso (falha silenciosa). Todo handler declara sua intenção de autorização explicitamente; o guard continua seguro de registrar globalmente.

## ADR-017 — Role.systemKey para invariantes de ciclo de vida

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** a regra "o último Owner ativo não pode ser rebaixado/removido" precisa identificar o papel Owner, mas o ADR-004 proíbe ramificar por nome de role (nome é dado do workspace).
**Alternativas:** ramificar por `name` (viola ADR-004; renomear quebraria a invariante); marcar por permissão-sentinela (acopla catálogo a ciclo de vida).
**Decisão:** `Role.systemKey String?` com valores estáveis (`'owner'|'admin'|'member'|'guest'`), `@@unique([workspaceId, systemKey])`, preenchido apenas nos papéis de sistema semeados no provisionamento. Invariantes ramificam por `systemKey`; autorização continua exclusivamente por permission keys.
**Consequências:** invariantes robustas a renomeação; papéis customizados (`systemKey = null`) nunca participam de invariantes de sistema.

## ADR-018 — Endurecimentos de sessão da Entrega 2

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** ajustes aprovados na revisão do plano da Entrega 2 (itens 1, 2 e 7).
**Decisão:** (a) `RefreshToken.activeMembershipId` com FK composta `(userId, activeMembershipId) → Membership(userId, id)` em SQL manual — o banco impede sessão apontar para membership de outro usuário (Prisma não modela relação de nulidade mista; a migration avisa para não regenerar o DROP); (b) reuso de refresh rotacionado revoga todos os refresh tokens do usuário **e** incrementa `tokenVersion` de todas as memberships ativas — access tokens já emitidos caem imediatamente; (c) mutações sem Bearer validam `Origin`/`Referer` contra `WEB_ORIGIN` além do CSRF double-submit — inclusive rotas `@Public` que usam cookies.
**Consequências:** roubo de refresh tem raio de dano de uma request; sessão nunca cruza usuários nem no nível do banco; formulário cross-site não alcança nem o login.

## ADR-019 — Append-only imposto no client, não por convenção

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** ADR-011 declarou a timeline append-only, mas nada impedia `updateMany`/`deleteMany` em `Activity` pelo client protegido. Com o `AuditLog` (uso probatório/LGPD), "combinado" deixa de bastar.
**Alternativas:** revisão de código (não escala, falha silenciosa); trigger no Postgres (bloquearia cascade e retenção legítimos); RLS (adiado, ADR-013).
**Decisão:** `APPEND_ONLY_MODELS` no `PrismaService` bloqueia `update/updateMany/updateManyAndReturn/delete/deleteMany/upsert` em `Activity` e `AuditLog`. Exclusão legítima só por **cascade do dono** (LGPD) ou pelo **job de retenção** via `raw` justificado.
**Consequências:** reescrever histórico exige `raw` — visível em revisão. Nota: a transação `raw` do `DealsService.move` (advisory lock) não passa pelo guard; ali só há escrita append, e o teste P0 cobre.

## ADR-020 — Idempotência HTTP com reserva atômica e opt-in

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** retry de cliente/integração não pode duplicar mutação, e "grava a resposta depois de executar" não impede duas execuções concorrentes.
**Decisão:** `IdempotencyKey` com estado `processing|completed`. A chave é **reservada antes** de executar (INSERT no unique `(workspaceId, key, endpoint)`): mesmo hash concluído → replay; hash diferente → 409; em processamento → 409 (com lease de 60s para reserva abandonada); erro → reserva liberada. O hash cobre método + rota canônica + **path params** + query ordenada + body normalizado. **Opt-in por `@Idempotent()`**: rota cuja resposta contém segredo (ex.: criação de webhook) nunca entra no cache — caso contrário o segredo ficaria em claro por 24h numa coluna JSONB.
**Consequências:** integração ganha retry seguro; rotas idempotentes são uma lista explícita e revisável.
**Adendo (revisão do push):** a gravação do replay é **aguardada antes de concluir a resposta**. Com fire-and-forget o cliente podia receber 2xx e um retry imediato encontrar a chave ainda em `processing` (409). Falha ao gravar é best-effort: a operação já aconteceu, então libera-se a reserva e registra-se o incidente, sem esconder a resposta do cliente.

## ADR-021 — Outbox transacional + webhooks assinados com defesa SSRF por pinning

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** efeito externo disparado dentro da transação escapa quando ela aborta; e webhook com URL fornecida pelo cliente é vetor de SSRF.
**Decisão:** (a) `OutboxEvent` gravado na MESMA transação do domínio, entregue por worker pg-boss com `FOR UPDATE SKIP LOCKED`, backoff exponencial e `dead` no limite; payload por **allowlist `EventType → Zod .strict()`** — nunca a entidade Prisma inteira. (b) Entrega assinada com HMAC-SHA256 sobre `timestamp.body` (resiste a replay), segredo cifrado AES-256-GCM e exibido uma única vez. (c) SSRF: classificação de IP por `ipaddr.js` (não regex) cobrindo IPv4-mapeado, metadata de nuvem, CGNAT e ULA, **com pinning** — a conexão usa `https.request` com `Agent.lookup` fixo no IP já validado, porque o `fetch` do Node (undici) **ignora** `agent` e o pinning seria descartado em silêncio. Sem redirects, timeout de 5s, corpo descartado com teto. (d) `failureCount` conta **entrega morta**, não tentativa; 3 mortas consecutivas pausam apenas o webhook que falhou.
**Consequências:** entrega ao-menos-uma-vez com dedupe; um tenant não consegue usar o Veyra para alcançar rede interna; instabilidade curta não pausa integração.
**Adendo (revisão do push):** o claim ganhou **lease** — o mesmo UPDATE atômico move o evento para `processing` e grava `claimedAt`/`leaseExpiresAt`. Sem isso o `SKIP LOCKED` protegia apenas durante o statement e outra instância entregaria em paralelo (seis workers levariam o evento a `dead` artificialmente). Elegíveis ao claim: `pending` no ponto ou `processing` com lease expirado (worker morto). Em retry parcial, quem já recebeu aquele `outboxEventId` com sucesso **não** é reentregue. O transporte é injetável (`WEBHOOK_TRANSPORT`) para que a suíte não dependa de DNS real — a defesa SSRF é coberta por testes unitários.

**Adendo 2 (hotfix de confiabilidade, pré-primeiro webhook externo):** o lease ganhou **fencing token**. Lease sozinho garante exclusão _enquanto vale_, não posse _na hora de concluir_: um worker lento além dos 5 min perdia o evento para outro e, ao acordar, ainda conseguiria marcá-lo `delivered` — sobrescrevendo o trabalho de quem o assumiu. Cada claim gera um `claimToken` novo (`gen_random_uuid()` no mesmo UPDATE), devolvido no lote; `markDelivered`/`markFailed` exigem `id + claimToken + status='processing'` e devolvem `false`/`'lost'` quando a posse já não é nossa, sem tocar na linha. Entregas longas renovam o lease por heartbeat antes de cada destino (`renewLease`); perder a renovação **aborta o fan-out** em vez de duplicar entregas. E o fan-out é limitado a 20 webhooks por workspace, mantendo a pior entrega sequencial (20 × 5 s) bem abaixo do lease.

## ADR-022 — Política de exclusão de contato (LGPD)

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** o titular pede exclusão, mas deals e tarefas são registro comercial do workspace.
**Decisão:** deals e tasks são **preservados e desvinculados** (`contactId = null`); notes e custom fields do contato são **removidos**; activities caem por cascade; a exclusão é registrada em `AuditLog` (que sobrevive ao expurgo, com o nome do titular, como prova da operação, até a retenção). Sem 409: o contato sempre pode ser excluído.
**Consequências:** direito ao esquecimento atendido sem destruir histórico comercial. Aberto: pseudonimizar o nome no evento de deleção quando houver verificação de identidade do titular.

## ADR-023 — Canal interno primeiro, com a costura de ingestão externa pronta

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** conversas são a porta de entrada de e-mail e WhatsApp, mas nenhum provider externo existe ainda. Modelar só o que existe hoje custaria uma migração de dados quando o primeiro canal real entrar; modelar o provider inteiro agora seria construir sobre suposição.
**Decisão:** (a) `Channel` nasce com `type` reservando `email`/`whatsapp` no enum, mas **a API desta entrega aceita apenas `internal`** — o cliente nem informa o canal: o service usa o canal de sistema do workspace. (b) Exatamente um canal interno por workspace, garantido por **unique parcial estrutural** (`systemMark Boolean?` TRUE/NULL + `@@unique([workspaceId, systemMark])`), o mesmo padrão do `Pipeline.defaultMark` — invariante no banco, não no service. Semeado no provisionamento, com backfill idempotente para os workspaces existentes. (c) `Message.externalId` e `@@unique([workspaceId, channelId, externalId])` já existem para dedup de ingestão; `channelId` é **derivado da conversa no servidor**, nunca do cliente. (d) A regra que fica fixada agora: mensagem de saída em canal **externo** passará pelo outbox (efeito externo nunca dentro da transação de domínio); canal interno grava direto, porque não há efeito externo. (e) `Message` é **append-only** — mensagem enviada não se reescreve. (f) **FK tripla** `Message(workspaceId, channelId, conversationId) → Conversation(workspaceId, channelId, id)`: sem ela, as duas FKs compostas separadas (para conversa e para canal) permitiriam, dentro do MESMO workspace, uma mensagem ligada à conversa A carregando o canal B — a mesma incoerência que a tripla `Deal→Stage` já elimina (ADR-010).
**Consequências:** o inbox fecha ponta a ponta sem provider; ligar um canal real vira um adaptador de ingestão + emissão via outbox, sem migração de dados. Preço do append-only: quando houver canal externo, o estado de entrega (`delivered`/`read`, recibos que chegam depois) **não** poderá ser um UPDATE na mensagem — vai em tabela própria de entregas, como já é `WebhookDelivery` para webhooks. Isso é intencional: recibo é fato novo, não correção do passado.

## ADR-024 — Armazenamento por `StorageDriver`, disco local no MVP

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** arquivos precisam de storage, mas não existe bucket provisionado e acoplar o SDK da AWS agora seria construir sobre suposição (§3.15: avaliar integrar antes de construir).
**Decisão:** interface estreita `StorageDriver` (`put`/`get`/`delete`), com `LocalDiskDriver` no MVP. A **chave é derivada no servidor** — `{workspaceId}/{uuid}{ext}`, com o workspaceId vindo do CLS, nunca de input do cliente — e é validada contra travessia de caminho antes de tocar o disco. Trocar por S3/MinIO é um driver novo, sem tocar em service.
**Consequências:** o prefixo por workspace (SECURITY.md §7.3) vale para qualquer driver futuro. Exclusão física **não** acontece na transação de banco: a linha sai do Postgres e um evento `file.purge` no outbox apaga os bytes depois — se o disco falhasse dentro da transação, banco e storage divergiriam. `file.purge` é **evento interno**: carrega a chave de storage e por isso NUNCA é entregue a webhook de cliente.

## ADR-025 — Sniffer de magic bytes próprio em vez de `file-type`

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** a política de arquivos exige validar o tipo REAL por magic bytes (SECURITY.md §7.1). A biblioteca madura da categoria, `file-type`, é ESM puro desde a v17 — e já pagamos esse preço com o pg-boss (stub no Jest, worker fora dos testes).
**Decisão:** contrariar conscientemente o §3.15 e manter um sniffer interno para uma **allowlist fechada** de sete tipos (PNG, JPEG, GIF, WebP, PDF, ZIP/OOXML, texto). São ~40 linhas determinísticas e testáveis, sem custo de interoperabilidade CJS. Texto não tem assinatura: é aceito só quando o conteúdo é UTF-8 válido sem bytes NUL. **SVG fica fora da allowlist** — é vetor de XSS no download. Todo download sai com `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff`, e o `Content-Type` é o **detectado**, nunca o declarado pelo cliente.
**Consequências:** extensão que diverge do conteúdo é rejeitada no upload. Gatilho para trocar por `file-type`: allowlist aberta a formatos arbitrários (aí a tabela própria vira dívida, não economia).

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
**Adendo 3 (revisão adversarial):** o `enqueue` capturava `P2002` **dentro** da transação de domínio. No Postgres, violação de unique aborta o bloco inteiro (`25P02`): todo statement seguinte, e o próprio COMMIT, falhavam. O caso concreto era ganhar um deal, reabri-lo e ganhá-lo de novo — o `dedupeKey` fixo por deal repetia, a transação envenenava, e aquele deal **nunca mais** podia ser marcado como ganho. Agora há pré-checagem na própria transação, e o `dedupeKey` de `deal.won`/`deal.lost` identifica a **transição** (instante), não o deal; o endpoint de movimentação ganhou `@Idempotent()` como par necessário, para que retry HTTP não conte como transição nova.
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

## ADR-026 — Quando uma notificação é emitida

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** o critério da Entrega 6.2 dizia "evento criado notifica o organizador uma única vez, inclusive em retry". Na implementação, notificar quem acabou de criar o próprio evento é ruído: a pessoa está olhando para o resultado da ação que acabou de fazer. O critério precisava de decisão explícita, não de exceção silenciosa no código.
**Decisão:** notificação é emitida **apenas quando o destinatário não é quem agiu**. Vale para os dois produtores atuais: evento agendado com organizador diferente do criador, e conversa atribuída a outra pessoa. Quem age nunca se autonotifica. A garantia de "uma única vez, inclusive em retry" continua valendo integralmente para o caso em que há notificação, sustentada pelo `dedupeKey` com unique tenant-scoped (testado com e sem `Idempotency-Key`). O `dedupeKey` é o par **(fato, destinatário)** — reatribuir uma conversa a quem já foi avisado não repete o aviso, o que evita tempestade de notificação ao alternar responsável.
**Consequências:** a caixa só contém o que veio de outra pessoa, o que a mantém legível. Preço: se alguém agendar um evento para si e quiser um lembrete, isso terá de vir de um mecanismo de **lembrete por proximidade de horário** — que é outra coisa, e não existe ainda. Ambos os ramos (com e sem autonotificação) têm teste.

## ADR-027 — `intelligence` sem Prisma: portas no módulo, adaptadores fora

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** "a IA não acessa o banco" era convenção escrita. Uma barreira com exceção interna (uma pasta `store/` autorizada dentro do módulo) enfraquece a regra: passa a exigir julgamento sobre o que é "escrituração própria" e o que é domínio, exatamente o tipo de decisão que erra em silêncio meses depois.
**Decisão:** **inversão de dependência**. O módulo define as portas — `AiRunRepository`, `AiProposalRepository`, `AiConsentRepository` — como interfaces com tokens de DI, e os adaptadores Prisma vivem **fora**, em `src/intelligence-persistence/`. Com isso o banimento de import de Prisma dentro de `src/intelligence/**` é **absoluto**: sem exceção, sem allowlist de pasta. É verificado em duas camadas — `no-restricted-imports` do ESLint e um **teste de fronteira** que varre os arquivos do módulo, porque configuração de lint pode ser afrouxada sem ninguém notar e teste vermelho não. Leitura de domínio continua sendo por serviços de domínio injetados, que já carregam tenant + RBAC + auditoria.
**Consequências:** trocar a persistência dos runs (outro banco, outro formato) não toca o módulo. Preço: uma camada de interfaces a mais e DTOs de fronteira em vez de tipos do Prisma — aceito, porque é o que torna a regra verificável em vez de aspiracional.

## ADR-028 — Consentimento de conteúdo de conversa, default-deny

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** corpo de mensagem é o dado mais sensível do Core — a §5 da segurança existe para mantê-lo fora de auditoria e log. Colocá-lo num prompt é enviá-lo a um terceiro.
**Decisão:** `AiConsent` tem **uma** flag por workspace, `conversationContent`, **desligada por padrão**. Sem ela: a capacidade de resumo não é oferecida e **nenhuma chamada ao provedor acontece** — a checagem é anterior ao provedor, não um filtro depois. Alternar exige `workspace:manage` e gera `AuditLog`.
**Consequências:** um workspace novo não manda conversa para fora sem alguém decidir isso explicitamente. Uma flag só, e não flags por tipo de dado, porque hoje há um único tipo de conteúdo em jogo; granularidade entra quando houver segundo consumidor, não antes.

## ADR-029 — SDK Anthropic direto, sem loop agêntico na v1

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** o `AI_ARCHITECTURE` previa AI SDK com ToolSet e `stopWhen` (herança do Norteie). Para três capacidades de saída estruturada, isso traz complexidade de loop e de tipagem sem ganho — e o próprio documento registra que a inferência de generics do AI SDK com Zod estoura a memória do `tsc`.
**Decisão:** `@anthropic-ai/sdk` direto, atrás da porta `LLM_CLIENT` (mesmo padrão de `WEBHOOK_TRANSPORT` e `STORAGE_DRIVER`), com o cliente falso nos testes — a suíte nunca fala com provedor real. E **a v1 não tem loop agêntico**: o fluxo é `contexto permitido → chamada estruturada → validação Zod estrita → registro`. O contexto é montado pelo servidor a partir de serviços de domínio; o modelo **não escolhe o que ler** e **não tem ferramenta de escrita**. Nenhuma saída do modelo alcança um service de domínio: ação externa vira `AiProposal` de tipo permitido, executada só depois de aprovação humana.
**Consequências:** o modelo deixa de ser um agente e passa a ser um transformador de texto validado — o que reduz a superfície de prompt injection a "conteúdo malicioso influencia um texto que um humano vai ler ou aprovar". Ferramentas e teto de passos ficam reservados para capacidades futuras, com ADR próprio. `ToolRegistryService` do `AI_ARCHITECTURE` §2 fica adiado — a seção foi anotada.

## ADR-030 — Execução de proposta é atômica, e a autoria é da IA

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** a primeira versão aprovava a proposta e **depois** criava a tarefa. Falha na criação deixava a proposta `approved` sem tarefa nenhuma; e a `Activity` creditava o aprovador humano por uma mutação que ele apenas autorizou.
**Decisão:** (a) **uma transação só**: reivindicar (`pending → executing`, com `status` no WHERE serializando aprovações simultâneas) → criar a tarefa → registrar `Activity` e `AuditLog` → concluir (`executing → approved`). Falha em qualquer etapa faz rollback e a proposta volta a `pending` — não existe estado em que a proposta esteja aprovada sem a tarefa. A criação usa `TasksService.createWithin(tx, …)`, para que a lógica de domínio continue no serviço de domínio e só o controle transacional viva no adaptador. (b) **A autoria é da IA**: `Activity.actorType = 'ai'` e `AuditLog.actorType = 'ai'` com `actorId = AiRun.id`, ligando a mutação ao run que a propôs; o aprovador é preservado em `actorMembershipId` como **contexto de aprovação**, não como autor.
**Consequências:** a fila de propostas nunca mente sobre o que foi executado, e a trilha responde "quem fez" (a IA, por este run) e "quem autorizou" (a pessoa) sem confundir as duas coisas. O estado `executing` só existe dentro da transação; vê-lo persistido indica processo morto no meio — hoje impossível pelo rollback, e um sinal a monitorar se a execução virar assíncrona.

## ADR-031 — `AiRun` persiste o resultado estruturado

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** a v1 registrava só metadados: o resumo, a explicação e a recomendação sumiam depois da resposta HTTP. Reabrir a conversa exigiria pagar outro run para ver o mesmo texto.
**Decisão:** `AiRun.result` guarda a saída **já validada** pelo Zod da capacidade — nunca o prompt, o corpo bruto da mensagem ou segredo. O run também grava o **alvo** (`conversationId`/`contactId`) em colunas FK compostas, e a interface relê o último resultado por alvo. O resultado é **conteúdo derivado** e por isso é servido só pelo endpoint do alvo, com a permissão do domínio (`conversations:read`); a visão de administração da IA (`workspace:manage`; valores em dólar exigem `billing:manage` desde a revisão da 9.1.c) devolve metadados **sem** o resultado — quem administra custo não é necessariamente quem pode ler conversas.
**Consequências:** o insight vira parte do produto em vez de um efeito passageiro, e a conta de IA não é paga duas vezes pela mesma pergunta. Preço: texto derivado de conversa passa a existir em mais uma tabela — coberto pelo consentimento (ADR-028), pelo isolamento de workspace e pela retenção, que deve incluir `AiRun` quando o expurgo de auditoria for revisado.

## ADR-032 — Uso: duas naturezas de métrica e incremento dentro da transação

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** quota lida com dois fatos diferentes. "Runs de IA no mês" é acumulador que zera na virada; "contatos ativos" e "bytes em storage" são **nível atual**, que sobe e desce e não tem período. Tratar os dois como a mesma coisa produz contador que nunca zera ou nível que se perde no mês seguinte. E o teto de webhooks já mostrou o segundo erro clássico: `count()` antes do `create` não é atômico (dívida P2 registrada).
**Decisão:** (a) o catálogo declara a **natureza** de cada métrica — `counter` (acumulador, com período) ou `gauge` (nível, sem período, com decremento). (b) O incremento é `INSERT … ON CONFLICT DO UPDATE SET value = value + $n RETURNING value` **dentro da transação de domínio**, e o limite é conferido sobre o valor retornado: estourou, a exceção derruba a transação e o contador volta pelo rollback — sem compensação manual e sem janela de corrida. (c) Gauges nascem por **backfill** com o valor real dos workspaces existentes, nunca em zero. (d) `Contact` conta apenas em `active`: arquivar decrementa, reativar reserva de novo. Importação em lote reserva o lote **inteiro** na mesma transação — não existe importação parcial por quota.
**Adendo 2 (revisão adversarial):** resolver o teto do plano **dentro** da transação pedia uma segunda conexão do pool — o mesmo defeito já corrigido em `ensureCounterRow`. Com N transações concorrentes e pool de N, ninguém progride até o timeout e todas falham em bloco. `prepareConsume` resolve linha e teto **antes** da transação, e `consume` recebe o limite pronto.
**Consequências:** um limite é sempre verdade no instante do commit. Preço: toda escrita de entidade contada passa a abrir transação, e todo caminho de exclusão/arquivamento precisa lembrar do decremento — coberto por teste de simetria (criar+arquivar+reativar volta ao mesmo valor).

## ADR-033 — Quota de custo de IA é RESERVADA antes da chamada

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** incrementar o custo depois da resposta do provedor não protege nada sob concorrência: N requisições simultâneas passam todas na checagem e o teto é ultrapassado por N vezes o custo de um run. Pior: o dinheiro já foi gasto quando a conta chega.
**Decisão:** **reserva durável e atômica** do teto máximo do run (`maxOutputTokens` no preço do modelo, mais o custo estimado da entrada) **antes** de chamar o LLM; depois **liquidação** pelo custo real, liberando a diferença. Reserva e liquidação usam o mesmo incremento atômico do ADR-032. Se a chamada falhar, a reserva é liberada integralmente. Uma reserva órfã (processo morto entre reservar e liquidar) expira por idade e é varrida — no pior caso o workspace fica temporariamente com menos orçamento do que gastou, nunca com mais.
**Adendo (revisão da 8.1):** o resultado do provedor distingue três casos, porque eles têm consequências diferentes para a quota. `no_provider` (sem API key) é o **único** em que se pode afirmar que nenhuma chamada saiu — aí a reserva é liberada por inteiro. Timeout, conexão caída ou erro do provedor viram `unknown_after_dispatch`: a requisição já havia sido despachada, pode ter havido consumo de tokens do outro lado, e liberar a reserva devolveria dinheiro possivelmente já gasto. Nesse caso a reserva é **liquidada pelo teto** como custo conservador, o `AiRun` registra `provider_unknown_cost` e a capacidade aparece como indisponível. O prejuízo da incerteza fica com a operação, não com a conta do cliente.
**Consequências:** o teto de custo é real, não uma estimativa retroativa. Preço: a reserva é pessimista, então rajadas de runs baratos podem bater no teto antes do gasto real chegar lá — liberar a diferença logo após cada run mantém a distorção curta. Quota estourada devolve **402** com `{ code: 'quota_exceeded', metric, limit, current, resetsAt }`; para a IA, a capacidade degrada pelo caminho de indisponibilidade que já existe, com `reasonCode` próprio no `AiRun`.

## ADR-034 — Billing v1 sem provedor de pagamento

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** limites que valem e uso visível são o que trava abuso hoje. Integrar cobrança traz webhooks de entrada, idempotência de eventos financeiros e um modelo de falha inteiro.
**Decisão:** `Plan` e `PlanLimit` são **catálogo global** (como `Permission`), com limites em linhas consultáveis, não JSON. `Subscription` pertence ao workspace e é atribuída/alterada por **CLI administrativa**, o mesmo caminho justificado do provisionamento. Todo workspace existente recebe o **plano-base por backfill** — sem assinatura, não haveria limite aplicável e o default-deny do restante do sistema não teria equivalente aqui. **`costCents` é centavo de dólar (USD)**, como o código já calcula; conversão para moeda de cobrança é assunto de quando houver cobrança.
**Consequências:** dá para operar, limitar e mostrar consumo sem tocar em dinheiro de verdade. Integração de pagamento entra com ADR próprio, e a fronteira já está no lugar certo: `Subscription` é o ponto de encaixe.

## ADR-035 — Automações: catálogo fechado, execução idempotente e causalidade no evento

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** automação é o primeiro ator do sistema que não é uma pessoa clicando. Isso traz dois riscos que nenhuma entrega anterior tinha: **laço** (automação cria fato que dispara automação) e **duplicação** (o outbox é ao-menos-uma-vez, então reentrega reexecutaria a ação).
**Decisão:** (a) **catálogo fechado**: `trigger` são eventos de domínio já existentes no outbox, `action` é uma lista pequena, e as condições são predicados declarados — não há expressão arbitrária para avaliar. (b) **`AutomationExecution` com `@@unique([workspaceId, automationId, outboxEventId])`**: reentrega do outbox nunca cria duas tarefas, porque a segunda execução colide no unique. A execução é registrada na MESMA transação da ação. (c) **Causalidade em COLUNAS do `OutboxEvent`** — `chainId`, `depth`, `originAutomationId` — e não no payload: payload é o que sai para webhook de cliente, e a topologia interna de automação não é assunto dele. (d) **Automações rodam ANTES dos webhooks** no mesmo tick do dispatcher: uma ação de automação pode gerar dados que o webhook deveria ver. (e) **Duas defesas contra laço**: evento originado por uma automação **não reativa a mesma automação**, e a cadeia para em `depth >= 3`, com `AuditLog` registrando o corte. As duas são necessárias — a primeira sozinha não impede duas automações em ping-pong.
**Adendo (revisão da 8.2):** três pontos que a primeira versão errou. (1) A ação é registrada com `actorType: 'system'` na timeline e gera `AuditLog` `task.created_by_automation` com `actorId` = id da automação: `user` com membership nula fazia a timeline mentir sobre quem agiu, e sem o log não havia como saber QUAL regra criou a tarefa. (2) Falha na ação **propaga** para o dispatcher, que devolve o evento ao outbox para nova tentativa com backoff — engolir a falha significava zero tarefa e nenhuma retentativa, transformando erro transitório em perda silenciosa. E a linha de execução **não** é gravada em falha antes da última tentativa: ela ocuparia o unique e impediria o retry de agir; no esgotamento, o `failed` é gravado para o fracasso ficar visível. (3) O campo da condição é **allowlistado pelo gatilho**, derivado da allowlist de payload do próprio evento — operador fechado com campo livre ainda permitia condição que nunca casa, ou seja, automação silenciosamente inválida.
**Consequências:** automação é previsível e auditável, e reentrega é inofensiva. Preço: o catálogo fechado recusa casos que um motor de regras genérico aceitaria; abrir isso exige ADR próprio, porque expressão arbitrária avaliada no servidor é superfície de execução remota. O teto de 3 é baixo de propósito: cadeia legítima mais longa que isso é sinal de modelagem errada, não de necessidade.

## ADR-036 — Core suficiente para piloto vertical; IA priorizada por canal e evidência

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** o roadmap original previa, depois da Entrega 8, um pacote com as cinco capacidades de IA restantes, e o vertical só "após o Core estável". Duas coisas mudaram essa leitura. Primeira: o Core já exercitou em entregas reais tudo que um vertical precisa — extension tables, custom fields, FKs compostas, isolamento, RBAC, propostas com aprovação humana. A premissa de estabilidade está cumprida. Segunda: duas das cinco capacidades (**sugestão de resposta** e **oportunidade parada**) dependem de coisas que não existem — canal externo real e volume de consultas/retornos. Entregá-las agora produziria aparência de produto: um rascunho de resposta que não tem para onde ser enviado.

Continuar acumulando infraestrutura e IA sem canal de distribuição também é um risco de produto, não só de escopo: o Veyra ficaria excelente em capacidades universais sem nunca ter provado que alguém compra o resultado.

**Decisão:** inverter a ordem. (a) **Entrega 9 — comunicação externa e privacidade operacional**: canal WhatsApp oficial primeiro (e-mail depois), com ingestão, envio sob aprovação humana, status de entrega e opt-in; retenção/expurgo de `AiRun.result`; scanner de antivírus antes de qualquer documento sair para canal externo ou entrar como dado clínico. (b) **Entrega 10 — Veyra Clinics** como extensão do Core, sem prontuário médico completo: paciente, profissional, agenda de consulta, procedimento, retorno e funil clínico, com foco no fluxo comercial `lead → WhatsApp → agendamento → confirmação → consulta → retorno/reativação` e métricas de falta, conversão e pacientes recuperados. (c) **IA por necessidade concreta**: sugestão de resposta entra junto do WhatsApp, com aprovação humana; oportunidade parada entra quando houver consultas e retornos reais; as demais nascem de sinais do piloto, não como pacote.

O Core continua **não conhecendo o vertical** (§3.8): Clinics estende por extension tables, custom fields e composição no bootstrap. A inversão muda a ordem das entregas, não a arquitetura.

**Consequências:** o próximo marco passa a ser um piloto que compra resultado — mais consultas realizadas, menos faltas, mais retornos — em vez de mais superfície genérica. Preço: o canal WhatsApp traz restrições de plataforma que não são nossas (janela de atendimento de 24h, templates aprovados, opt-in obrigatório) e que vão moldar o modelo de conversa; a Entrega 9 precisa tratá-las como requisito, não como detalhe de integração. E capacidade de IA sem demanda observada deixa de ser roadmap: se nenhum sinal do piloto pedir previsão de pipeline, ela não é construída.

## ADR-037 — Ingestão de webhook público: assinatura sobre o corpo bruto

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** o WhatsApp inverte a direção de todo dado que entrou no Veyra até aqui — a Meta faz `POST` num endpoint nosso, sem sessão, e o corpo diz de qual número é. É o primeiro caminho de **escrita público e não autenticado** do sistema. Nada no payload pode ser tratado como confiável, porque payload é justamente o que o atacante controla.
**Decisão:** (a) A assinatura `X-Hub-Signature-256` é verificada sobre o **corpo bruto**, com `timingSafeEqual`, **antes de qualquer parse de domínio** — reserializar o JSON para conferir mudaria bytes e invalidaria a comparação. (b) O `phone_number_id` só serve para **roteamento de leitura depois** da assinatura conferir: é ele que localiza o canal e, por consequência, o workspace. Tenant nunca vem do cliente. (c) O endpoint tem teto de corpo próprio, throttle próprio e responde `200` também para eventos que ignora — a Meta reentrega o que não recebe `2xx`, e reentrega de evento desconhecido não deve virar fila de erro. (d) O `GET` de verificação usa `verify_token`, comparado em tempo constante. (e) O **app secret vive no ambiente/keystore do servidor**, não por canal: hoje há um Meta App. Se houver vários, isso vira entidade própria — não uma abstração genérica de integrações.
**Consequências:** o endpoint é a superfície mais exposta do produto e passa a exigir revisão de segurança em qualquer mudança. Preço: precisamos guardar o corpo bruto na requisição (parser configurado com `verify`), o que é uma exceção deliberada ao parse padrão.

## ADR-038 — Janela de atendimento e consentimento são coisas SEPARADAS

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** é tentador tratar "o paciente me mandou mensagem" como consentimento. A política do WhatsApp trata os dois casos separadamente, e a LGPD também: uma mensagem recebida abre uma **janela de atendimento**; consentimento é **evidência**, com origem, data e possibilidade de revogação.
**Decisão:** dois conceitos distintos, nenhum derivado do outro. (a) `Conversation.lastInboundAt` é alimentado pela ingestão e define a janela de 24h — **resposta livre dentro dela é permitida**. (b) `ContactChannelConsent` registra opt-in com `source`, `grantedAt` e `revokedAt`, e **nunca é criado automaticamente** por mensagem recebida. (c) Mensagem **iniciada pelo negócio** ou **fora da janela** exige template aprovado **e** consentimento válido. A checagem mora no service de domínio, não no adaptador do canal: no adaptador, todo caminho de envio novo esqueceria a regra.
**Consequências:** o produto não pode "conquistar" consentimento por acidente, e a diferença aparece na interface — dentro da janela o compositor é livre, fora dela é seleção de template. Preço: registrar opt-in passa a ser um ato explícito do negócio, com tela e trilha próprias.

**Adendo (9.1.c — a UI mostra, não decide):** a política de envio é exposta por `GET /api/conversations/:id/send-policy`, que usa a MESMA função pura do worker e devolve modo (`free_form`/`template`/`blocked`), motivo em pt-BR, fim da janela, estado do opt-in e os templates aprovados do canal. A tela não recalcula nada: ela não vê consentimento revogado nem recibo atrasado, e uma segunda implementação da regra divergiria justamente da que o worker aplica — com o front sempre na versão errada. A janela viaja como **instante de expiração**, não como duração restante, porque duração já chega velha no JSON. Existe teste provando que o que o endpoint nega, o envio nega, nos dois sentidos.

**Autorização (decisão, não detalhe):** a política exige **`conversations:write`**, não `read`. O que distingue esse payload não é o veredito, é o **catálogo de templates aprovados** — configuração do canal, sem outra superfície de API — e o estado de opt-in do contato. Quem não pode enviar não consome nenhum dos dois, então `read` ampliava a audiência sem consumidor. GET com permissão de escrita é coerente aqui porque o recurso é "o que posso escrever agora", não conteúdo de conversa. Pela mesma regra, o estado de consentimento **não** viaja no `ConversationDto`: a listagem é lida por qualquer portador de `conversations:read`, a triagem usa a janela, e evidência de consentimento sem finalidade declarada é o oposto de minimização. Quem "corrigir" a aparente inconsistência (GET pedindo `write`) reabre a exposição.

## ADR-039 — Envio: reserva de dispatch e o caso incerto

**Status:** aceito · **Data:** 2026-08-20

**Contexto:** a Meta não oferece chave de idempotência no envio. Com o outbox sendo ao-menos-uma-vez, uma resposta perdida no meio do caminho ("o provedor recebeu, nossa resposta caiu") faria a mesma mensagem ser enviada duas vezes — e mensagem duplicada para um paciente é dano visível, não ruído interno.
**Decisão:** o mesmo raciocínio que já usamos para custo de IA (ADR-033), aplicado a entrega. (a) O dispatch é **reservado antes da chamada** (`MessageDispatch` com unique por mensagem). (b) Retentativa automática **só** para falhas comprovadamente **anteriores ao envio** — recusa de validação, credencial inválida, erro de conexão antes do despacho. (c) Timeout ou queda **após possível despacho** marca `unknown_after_dispatch`: **não reenvia**, e fica visível para resolução humana com trilha. (d) `Message` é append-only (ADR-023), então recibo não é `UPDATE`: `MessageStatusEvent` guarda cada fato com o **timestamp do provedor**, deduplicado, e o estado atual é **derivado** — recibos chegam repetidos e fora de ordem, e a interface nunca deve "voltar" de `read` para `delivered`.
**Adendo (implementação da 9.1.b):** (a) **Nem toda falha pré-envio é retentável.** `429` volta com backoff (rate limit: o provedor recusou antes de processar); template inválido, parâmetros que não casam e credencial recusada são **permanentes** — liberam a quota, marcam `failed_permanent` e **encerram**, porque seis retentativas repetiriam o mesmo erro. A classificação vive numa tabela isolada (`meta-errors.ts`), testada por unidade, para que corrigi-la contra a API real seja mudar uma linha. Queda de rede é **ambígua**, não retentável: sem resposta, não há como afirmar que nada chegou. (b) **A reserva também existe no retry**: `MessageDispatch.reservationId` guarda a reserva viva; falha transitória a libera, e a nova tentativa **reserva de novo antes de chamar** — senão o teto não valeria para retentativa. O dispatch tem **claim próprio com lease e fencing** (`sending`): sem ele, dois workers com o lease do outbox expirado leriam o mesmo registro como enviável e ambos chamariam a Meta. Perder a posse **depois** de um envio bem-sucedido marca `unknown_after_dispatch` em vez de reenviar. E `failed_before_send` é estado **elegível ao claim**, senão a retentativa nunca aconteceria de verdade — só em teste que mexesse no banco à mão. (c) **A política é revalidada no worker**, imediatamente antes do envio: entre criar a mensagem e o outbox entregá-la, a janela fecha e o consentimento pode ser revogado. O template pedido fica no dispatch justamente para essa revalidação. (d) **O destinatário é o endereço exato** que falou com a gente (`Conversation.externalAddress`), nunca um telefone escolhido de `Contact.phones`. (e) A coleta de mídia usa **claim com lease e fencing** (o mesmo desenho do outbox), passa pelo sniffer de magic bytes e pelo caminho de quota do upload humano, e só busca em host allowlistado, sem seguir redirect. A posse é **reverificada antes de gravar** — o download pode ter levado mais que o lease — e, se for perdida depois da gravação, há **limpeza compensatória**: remove o `FileObject`, devolve a quota e apaga os bytes, porque quem assumiu vai baixar de novo. (f) Quota estourada devolve **402 estruturado**, o mesmo contrato do resto do sistema.
**Adendo 2 (revisão adversarial de concorrência):** a primeira versão do claim reassumia qualquer `sending` com lease expirado, e isso **reintroduzia o dano que este ADR existe para impedir**: worker que chamou a Meta e morreu antes de concluir teria a mensagem reenviada. O critério agora é o **marcador de despacho** (`dispatchedAt`), gravado com fencing imediatamente antes da chamada: lease expirado **sem** marcador é seguro reassumir; **com** marcador vai para `unknown_after_dispatch` com a quota cobrada, e nunca de volta para envio. Também: (a) 2xx sem id de mensagem é **ambíguo**, não retentável — a Meta aceitou; (b) limites de taxa que chegam com HTTP 400 (`130429`, `131048`, `131056`) são **retentáveis** apesar do status; (c) a **liveness da reserva é verificada** imediatamente antes de gravar o marcador e chamar a Meta — o TTL da reserva (10 min) é mais curto que o backoff do outbox (até 25 min), então um `reservationId` gravado no dispatch pode apontar para reserva já expurgada; se morreu, reserva-se de novo sob o `claimToken`, e se a nova reserva estoura o teto o envio morre `failed_permanent`/`quota_exceeded` **sem chamar o transporte**. O `settle` informa se encontrou a reserva; (d) evento do outbox que morre marca o dispatch `failed_permanent`, porque `failed_before_send` prometia retentativa que não viria; (e) o estado do despacho é exposto no DTO da mensagem — fila de casos incertos invisível acumula em silêncio.
**Adendo 3 (segundo passe adversarial — o que as próprias correções quebraram):** três defeitos nasceram das correções anteriores, todos na mesma família: _estado deixado para trás_. (a) O claim **zerava a reserva** ao reassumir linha expirada. Com a verificação de liveness isso ficou redundante e virou dano: reserva **viva** perdia a referência, ninguém a liberava, e o contador ficava inflado até o TTL — recusando envios de terceiros com 402 e podendo matar a própria mensagem cuja vaga estava paga. (b) `finish` **não limpava `dispatchedAt`**. O marcador de uma tentativa sobrevivia para a seguinte, e um worker que morresse **antes** de chamar era lido como "pode ter enviado": `unknown_after_dispatch` com **cobrança fantasma** por mensagem provadamente nunca despachada. O marcador só tem sentido dentro de uma tentativa; concluir zera. (c) O dispatch era encerrado quando o outbox devolvia qualquer coisa diferente de `retry` — inclusive `lost`, que significa o oposto: **outro worker assumiu e vai tentar**. Encerrar ali matava uma entrega viva. Só `dead` encerra. Ainda: (d) existe uma **varredura de dispatches abandonados** (`sending` com lease vencido há muito), consumidora do índice `(state, leaseExpiresAt)` — sem ela, uma exceção entre o claim e a conclusão deixava a linha `sending` para sempre, a mensagem desaparecia em silêncio e a reserva ficava presa; ela cobra o que tem marcador e devolve o que não tem; (e) a cobrança acontece **depois** de vencer o fencing, não antes, senão worker travado e varredura cobravam a mesma mensagem duas vezes; (f) em `settle`/`release` quem ajusta o contador é quem **apagou** a reserva (contagem do `deleteMany`), não quem a leu — dois liquidantes concorrentes aplicavam o ajuste em dobro; (g) código de erro **desconhecido** da Meta é ambíguo, não retentável: repetir arriscaria mandar duas vezes; (h) a virada de período entre reservar e cobrar garante a linha do contador antes do ajuste, senão a cobrança lançava **depois** do efeito externo.

**Adendo 4 (terceiro passe — a varredura recém-criada era o defeito):** a própria varredura do adendo 3 nasceu com dois furos, ambos confirmados empiricamente na revisão. (a) O `UPDATE` filtrava por `messageId IN (subquery)` com o predicado **só** dentro da subquery. Em READ COMMITTED, quando o comando bloqueia numa linha alterada por outra transação, o Postgres refaz a qualificação contra a versão nova — mas reavalia a subquery no **snapshot original**, que ainda vê `sending`. A recheck passava e a varredura sobrescrevia um `sent` acabado de comitar: mensagem **entregue** exibida como "Não enviada", levando ao reenvio manual — o dano que este ADR existe para impedir, agora por caminho humano. O predicado é repetido no `WHERE` externo e a subquery usa `FOR UPDATE SKIP LOCKED`. (b) O limiar de 15 min é **menor que o backoff do outbox** (que chega a horas), então enterrar como `failed_permanent` matava entrega viva — mesmo defeito de família do `lost` tratado como `dead`. O desfecho passou a **consultar o outbox**: com evento vivo, o dispatch volta a `failed_before_send`, que é elegível ao claim, e a retentativa legítima acontece; só sem evento vivo ele é terminal. Ainda: (c) o marcador de despacho é zerado **apenas** em `failed_before_send` — o único estado que volta a ser elegível. Nos estados terminais ele FICA, porque é o instante do despacho de que depende a triagem humana da fila de incertos; zerá-lo em tudo dava duas linhas do mesmo estado com semânticas diferentes. (d) `markExhausted` faz compare-and-set (guarda no `where`, não em JS) e só liquida quota se realmente escreveu. (e) Reserva **expirada mas ainda não expurgada** é devolvida antes de reservar de novo: havia até 5 min (TTL 10, purga a cada 5) em que ela ocupava o contador e era lida como morta, e o envio podia ser recusado pela própria vaga que já havia pago. (f) No coletor de mídia, quem decide se o arquivo é resíduo é o **estado no banco**, não uma flag em memória: a primeira tentativa de correção zerava a referência depois da transação, o que não cobria o caso que ela documentava — se o COMMIT vence e só a resposta se perde, a atribuição nunca acontece e o `catch` apagava um `FileObject` já ANEXADO, levando o anexo por cascade e deixando a mídia `fetched` sem arquivo, irreivindicável porque o claim exige `pending`. A limpeza relê a mídia e só descarta se ela ainda está `pending` ou já aponta para outro arquivo. (g) Existe também watchdog para o outro lado da mentira: `failed_before_send` parado, sem evento vivo no outbox, é encerrado como `failed_permanent`/`no_retrier` — "aguardando nova tentativa" sem ninguém que possa tentar é a mesma classe de estado falso. (h) `markExhausted` exige lease NÃO vivo para tocar `sending`, como o claim e a varredura: sem isso, um evento que morre enquanto outro worker detém a posse fazia a linha ser rebaixada debaixo dele. (i) O reset de `reservationId` após a varredura é guardado pelo valor esperado, para não apagar uma reserva nova de um worker que reivindicou a linha nesse meio-tempo.

**A verificar contra a API real (9.1 exige validação manual antes de qualquer piloto):** o destinatário sai em `+E.164`, como o `wa_id` normalizado que guardamos; os exemplos da Meta usam o número **sem** o `+`. A Graph API costuma tolerar, mas isto entra na lista de conferência do primeiro envio real, junto do formato de template e do fuso dos recibos.

**Trade assumido:** entre cobrança dupla e envio não cobrado, escolhemos o segundo. A cobrança acontece **depois** de vencer o fencing, então a morte do processo entre concluir e cobrar deixa uma mensagem entregue sem consumo registrado (a reserva órfã é devolvida pela purga). Cobrar antes dava o inverso — worker travado e varredura cobrando a mesma mensagem. Reconciliação (`sent` sem consumo) está registrada como dívida com gatilho, porque a distorção é de cobrança, não de entrega.

**Consequências:** no pior caso uma mensagem fica pendente de decisão humana em vez de ser duplicada — a escolha é assumida: duplicar é pior. Preço: existe uma fila de casos incertos para alguém resolver, e ela precisa ser visível o suficiente para não acumular em silêncio. `AiProposal.send_message` fica **apenas desenhado**: entra na 9.3, quando a sugestão de resposta existir.

## ADR-040 — Ingestão externa passa pelo domínio, e quota não descarta mensagem

**Status:** aceito · **Data:** 2026-08-21

**Contexto:** a primeira versão da ingestão criava o contato direto na tabela. Funcionava e era errada por três motivos: não consumia quota, não emitia `Activity` e não enfileirava `contact.created` — logo, **um lead chegando por WhatsApp não disparava automação**, que é exatamente o fluxo que o piloto precisa. Havia também a pergunta que ninguém tinha respondido: o que acontece quando a quota de contatos está esgotada e uma mensagem nova chega?
**Decisão:** (a) A criação passa por `ContactsService.createFromExternalChannel`, dentro da transação da ingestão, preservando quota, `Activity` (ator `system`) e outbox. (b) A quota é consumida **sem barrar**: perder a mensagem de um paciente por limite de plano é dano irrecuperável para ele — a Meta reentregaria, falharia sempre, e o paciente ficaria sem resposta —, enquanto ultrapassar o teto é problema de cobrança, visível no medidor e resolvido com uma conversa. Criação **manual** continua barrada em 402: lá o usuário está presente, vê o limite e pode decidir. (c) Toda a ingestão de uma mensagem roda em **uma transação sob lock consultivo** por `(workspaceId, channelId, telefone)`, com o dedupe **dentro** do lock: verificar duplicata antes da transação é corrida perdida, e entregas simultâneas — que a Meta faz — criavam contatos duplicados com uma delas estourando no unique da mensagem.
**Adendo (revisão da 9.1.a):** o "nunca regredir" dos timestamps passou a ser **atômico no banco** (`GREATEST` + `CASE`). Calcular o máximo em JavaScript depois de ler a conversa era corrida: o lock consultivo serializa por telefone, mas uma mensagem **humana** de saída toca a mesma conversa por outro caminho, sem passar por ele — se commitasse entre a leitura e a escrita, a ingestão sobrescreveria o horário novo por um timestamp antigo do provedor. O instante do provedor também é **limitado ao presente**: timestamp no futuro travaria a conversa à frente de tudo e o carimbo `now()` de uma mensagem humana nunca mais apareceria como o mais recente. E a garantia da linha do contador saiu de dentro da transação: pedir uma conexão nova ali dobrava o consumo do pool e, sob concorrência, derrubava as requisições em bloco.
**Consequências:** o canal externo é cidadão de primeira classe do domínio, não um atalho. Preço: existe um caminho em que o gauge de contatos passa do teto do plano — deliberado, e por isso o medidor mostra o excesso em vez de esconder. O lock serializa por telefone, então conversas de contatos diferentes continuam em paralelo.

## ADR-041 — Sem assinatura ativa, custo externo cai para o plano padrão (nunca ilimitado)

**Status:** aceito · **Data:** 2026-08-21

**Contexto:** `limitsFor` devolvia mapa vazio quando o workspace não tinha `Subscription` **ativa**, e mapa vazio significava "sem limite". Enquanto todas as métricas eram internas (contatos, armazenamento, custo de IA estimado), isso era só leniência. Com a 9.1.b existe envio externo de verdade: cada mensagem custa dinheiro no provedor. O efeito era o pior possível — o controle de plano **deixava de existir exatamente no inadimplente**, e uma falha de provisionamento (workspace criado sem assinatura) virava uso pago sem teto. A migration de billing já dizia isso em comentário ("sem assinatura não há limite aplicável, e o sistema ficaria sem o equivalente ao default-deny"), mas resolvia por backfill, que não protege quem entra depois.

**Decisão:** **fail-closed com o plano padrão**, com recorte explícito por natureza da métrica.

1. A métrica declara no catálogo se **nunca pode ficar sem teto** (`neverUnlimited`). O critério não é "importante", é **gasta dinheiro de terceiro** — e por isso vale para `messages_sent` (provedor de WhatsApp) e para `ai_runs`/`ai_cost_cents` (provedor de LLM). A primeira versão marcou só o envio, seguindo o enunciado do pedido; a revisão apontou a incoerência com o próprio critério: `ai_cost_cents` é a única métrica cuja **unidade é dinheiro**, e deixá-la sem teto era o furo que este ADR fecha.
2. O piso vale nos **dois ramos**, com e sem assinatura ativa. Restringi-lo ao caso sem assinatura protegia só o excepcional: bastava um plano novo (um `enterprise`, um plano de piloto) sem a linha da métrica para aquele cliente gastar sem teto na nossa conta do provedor — e sem alerta, porque o alerta vivia só no outro ramo. Para essas métricas, ausência de linha é **lacuna de configuração**, nunca "ilimitado por escolha".
3. Quando o catálogo não resolve (nenhum plano padrão, ou plano padrão sem a linha), entra um **piso declarado no código** e um alerta **diferente**: isso é incidente de configuração, não condição comercial, e confundir os dois manda o operador procurar no lugar errado. Nunca "sem limite".
4. `Plan.isDefault` virou marca **TRUE/NULL com unique** (padrão de `Pipeline.defaultMark`): deixou de ser preferência de provisionamento e passou a decidir teto, e dois planos padrão dariam limites diferentes conforme a ordem que o Postgres devolvesse — possivelmente o mais generoso.
5. Os limites herdados vêm do **plano padrão** resolvido no banco — não de uma chave `'base'` escrita no código, que a primeira renomeação de plano transformaria em "sem limite" de novo, silenciosamente.
6. Métrica **interna** continua sem teto nesse caso. Barrá-la puniria quem não pode resolver a questão comercial (o atendente que cadastra um contato não decide inadimplência), e o excesso já aparece no medidor. O recorte tem teste próprio, para que "todas as métricas" não entre por descuido depois.
7. **Entrada nunca é afetada.** Mensagem recebida continua aceita com teto zerado e sem assinatura: o ADR-040 já decidiu que perder a mensagem de um paciente é dano irrecuperável para ele, e nada aqui mexe nisso. A assimetria é o ponto — envio é dinheiro nosso saindo, recebimento é informação de alguém chegando.
8. **Alerta operacional** por workspace, estrangulado a um por hora: o caminho é quente (todo envio passa por ele), e um alerta por mensagem esconderia o próprio alerta. Workspace sem assinatura ativa é falha de provisionamento ou condição comercial a tratar, não estado normal — precisa aparecer, não virar rotina.

**Alternativas descartadas:** (a) _fallback global para o plano padrão_ — mudaria o comportamento de contatos e armazenamento junto, indo além do problema e podendo barrar operação de quem não causou a situação; (b) _bloquear tudo sem assinatura_ — transforma erro de provisionamento em interrupção total do produto, e o dano de barrar entrada é irreversível; (c) _manter ilimitado e resolver no billing_ — é justamente o furo, porque a fatura chega depois do gasto e o provedor não estorna.

**Alcance real hoje:** nada no sistema escreve `status` diferente de `active` — não há webhook de billing nem job de renovação. Então o caso que esta decisão protege **agora** é o do workspace **sem linha de `Subscription`** (falha de provisionamento), não o do inadimplente; o inadimplente entra quando billing existir e escrever `past_due`. Registro isto para que ninguém "conserte" a lacuna tratando `currentPeriodEnd < now()` como inativo: como nada renova o período, isso jogaria **todo** workspace com mais de um mês no fallback de uma vez.

**Penhasco a decidir quando billing chegar:** um `pro` (teto 20000) com 5000 mensagens no mês que virasse `past_due` herdaria o teto do padrão (1000) e passaria a recusar **todo** envio na hora, porque o consumo do período já passou do novo teto. Não é "envia até o teto do plano padrão", é parada total no meio do período. A janela de dunning (carência antes de apertar o teto) fica como decisão pendente, registrada em dívida — não é resolvível sem billing real.

**Adendo (revisão da 9.1.c — a fronteira é a API, não a tela):** a visão de uso expõe DOIS níveis de informação na mesma rota. Medidor e plano aplicado são informação de **trabalho** (`workspace:read`) — e a procedência do teto também, **exceto** nas métricas monetárias, onde ela sai junto do valor; status, preço e fim do período são **situação comercial** e exigem `billing:manage`. A primeira tentativa esconde a anomalia na interface — e isso não é controle nenhum: qualquer portador do medidor obtinha o dado chamando `/api/usage`. O campo passou a ser **omitido no servidor**, e a tela depende do dado já filtrado; o nome do plano vem do plano aplicado, não da assinatura, senão a interface passaria a mentir para quem não vê billing. Quando o direito depende do campo e não da rota, a checagem é em runtime com o `PermissionsService` que já existia para isso (a primeira versão desta correção criou uma segunda primitiva na mesma pasta, com o mesmo nome de método e chave não tipada — duas primitivas de autorização divergem quando uma é endurecida, então sobra uma).

**A fronteira é o DINHEIRO, não o medidor.** Registrei antes o oposto — que o medidor de consumo, inclusive `ai_cost_cents`, ficaria em `workspace:read`, com "um Guest vê o gasto de IA em dólares" como consequência assumida. Está errado no que importa: custo em USD é dado comercial tão sensível quanto preço de plano, e mais, para convidado externo, porque é o gasto **real** da conta e não uma tabela pública. A regra é: **`billing:manage`** vê o valor monetário completo (usado e teto em centavos); **`workspace:read`** vê apenas **disponibilidade** — a razão de uso e, perto do teto, "uso de IA próximo do limite" —, sem centavos, preço ou orçamento. Isso preserva o propósito original (nunca deixar "limite atingido" sem explicação) sem revelar valor. O critério de omissão é a **unidade** (`MONETARY_UNITS`, mapa exaustivo: unidade nova não compila sem decisão), não uma lista de nomes de métrica. A razão é **quantizada em decis** quando o valor é omitido, e a **procedência do teto é omitida junto** — defesa em profundidade, não barreira: o denominador continua inferível pelo plano aplicado e pelas métricas não monetárias da mesma resposta, e quem protege de fato é o decil. A razão exata reconstrói o centavo (0,274 × 500 = 137), e um ponto percentual ainda daria erro de 2 centavos no plano-base e reconstrução EXATA no piso de segurança (teto 100). Residuais assumidos e registrados para não serem redescobertos: (a) quem tem `intelligence:use` pode disparar runs e calibrar o teto observando o degrau do decil; (b) `inputTokens`/`outputTokens` continuam visíveis na visão de administração e, com a tabela de preços pública do provedor, permitem recompor o custo — a linha "tokens são diagnóstico, dólar é comercial" é defensável, mas é a linha de um dado derivável. O que a regra impede é o valor sair pronto num único GET. A projeção acontece no **servidor**, e vale para toda superfície: `/api/usage` e também `/api/intelligence/usage`, onde a rota segue em `workspace:manage` (runs, tokens e latência são diagnóstico de administração) mas os valores em dólar exigem `billing:manage` — sem isso o Admin, que tem uma permissão e não a outra, lia o gasto por execução, com a porta da frente fechada e a de serviço aberta.

**Consequências:** um workspace sem assinatura ativa consegue enviar até o teto do plano padrão, e não mais. Preço: existe um caminho em que a operação é limitada por um estado administrativo — por isso o alerta, para que a causa seja tratada em vez de virar mistério de suporte. O log é o canal de alerta que temos hoje; alerta com destinatário (e-mail/on-call) fica registrado como dívida, porque não existe infraestrutura de alerta no projeto ainda.

## ADR-042 — Retenção de `AiRun.result`: o conteúdo expira, o run permanece

**Status:** aceito · **Data:** 2026-08-22

**Contexto:** `AiRun.result` guarda a saída estruturada da capacidade (resumo de conversa, próxima ação, explicação de score). É **conteúdo derivado de conversa** — dado do paciente reescrito por um modelo — e ficava para sempre, enquanto `AuditLog` já tinha expurgo desde a Entrega 5. A dívida foi registrada na 7 e o gatilho era esta entrega. Sem retenção, um pedido de exclusão LGPD deixaria cópias derivadas para trás, e o volume só cresce.

**Decisão:** o expurgo **anula o `result`**; não apaga a linha do run.

1. `AiRun` é a trilha de **custo e uso**: tokens, centavos, capacidade, modelo, ação tomada, motivo de recusa. Apagar a linha destruiria a contabilidade do que já foi pago e a evidência de que uma ação de IA aconteceu — que é exatamente o que o ADR-030 exige preservar. O que precisa expirar é o **conteúdo**, não o fato.
2. Prazo em `AI_RESULT_RETENTION_DAYS` (default **90 dias**), no mesmo job diário da retenção de auditoria. Prazo separado do `AUDIT_RETENTION_DAYS` (365) de propósito: a trilha de quem fez o quê tem valor por mais tempo que o texto derivado.
3. A interface **já lida com resultado ausente** — `latestResult` devolve `null` quando não há —, então expirar não quebra tela: volta a ser "sem resumo", que é o estado normal antes da primeira execução.
4. O expurgo é **cross-workspace** (`raw` justificado, SECURITY.md §2) e roda pela porta do módulo: `src/intelligence` continua sem tocar Prisma (ADR-027).

**Alternativas descartadas:** (a) _apagar o run inteiro_ — perde custo e trilha, e o custo é a base do teto de plano (ADR-041); (b) _cifrar em vez de expirar_ — troca um problema de retenção por um de gestão de chave, e não atende exclusão; (c) _expurgo sob demanda por workspace_ — necessário para LGPD, mas não substitui prazo automático; entra quando existir o fluxo de exclusão, e este ADR não o dispensa.

**Consequências:** depois de 90 dias, um resumo antigo some da tela e a próxima visita gera outro (com custo novo). Preço aceito: o insight é barato de refazer e o dado é de terceiro. A contabilidade de custo permanece íntegra para sempre — ou até a retenção de `AiRun` como linha, que **não existe** e fica registrada como dívida com gatilho de volume.

## ADR-043 — Scanner de arquivos: quarentena é terminal, e os bytes saem com confirmação

**Status:** aceito · **Data:** 2026-08-22

**Contexto:** `FileObject.scanStatus` existe desde a Entrega 6.3 com o portão de saída externa (`assertSendableExternally`) esperando por ele — mas nunca deixava `pending`, porque não havia scanner. Com canal externo real (9.1), o portão passou a importar de verdade: arquivo não verificado não pode sair para um paciente.

**Decisão:**

1. **Integrar, não construir** (CLAUDE.md §3.15): ClamAV via `clamd`, atrás de uma porta `FILE_SCANNER` — mesmo desenho de `LLM_CLIENT` (ADR-029) e `META_TRANSPORT` (ADR-037). Escrever heurística de malware seria construir mal o que existe maduro e atualizado diariamente.
2. **Sem scanner configurado, o arquivo fica `pending`** — e `pending` não sai para canal externo. A ausência de scanner degrada para o comportamento seguro que já existia, em vez de liberar.
3. **A varredura é job com claim, lease e fencing**, como a coleta de mídia (ADR-037): ler bytes e escanear leva tempo, e dois workers no mesmo arquivo desperdiçariam trabalho e embaralhariam estado.
4. **Quarentena é TERMINAL.** Infectado nunca volta para `pending`, nunca é baixado, visualizado, reenviado ou anexado a envio externo — e a **linha permanece**, com `scannedAt` e trilha em `AuditLog`. Apagar a linha destruiria a evidência de que o arquivo existiu e foi barrado.
5. **Os bytes saem do storage depois da transação que registra a quarentena**, nunca dentro dela (ADR-024 já separava efeito externo de transação). Guardar malware no nosso disco é passivo sem contrapartida: o download já está bloqueado, então os bytes não servem a ninguém.
6. **A limpeza só é dada como concluída com CONFIRMAÇÃO do driver.** `bytesPurgedAt` é gravado apenas depois de o driver confirmar ausência — e por isso o contrato do `StorageDriver` ganhou `exists()`: o `delete` do driver local usa `rm(force: true)`, que **não falha quando o arquivo não existe**, então "não lançou" jamais foi prova de remoção.
7. **A quota de armazenamento volta com os bytes.** `storage_bytes` é gauge cobrado: sem devolver, o workspace pagaria para sempre por bytes destruídos, e alguns arquivos infectados consumiriam o teto sem ocupar disco. A devolução e a marca `bytesPurgedAt` commitam na MESMA transação, depois da confirmação física — marcar primeiro tiraria o arquivo da fila com a quota inflada, que é o defeito simétrico ao do item anterior. Por isso `remove()` recusa arquivo em quarentena também por contabilidade: devolveria de novo bytes já devolvidos.
8. **Falha na remoção física não desfaz nada**: a linha continua `quarantined` com `bytesPurgedAt` nulo, e um job **idempotente** tenta de novo. O estado inverso — banco dizendo `pending` enquanto o arquivo sumiu — é o que esta ordem impede.

**Alternativas descartadas:** (a) _apagar a linha junto dos bytes_ — perde a evidência, e um arquivo que some sem rastro é indistinguível de bug; (b) _manter os bytes indefinidamente em quarentena_ — passivo de malware no nosso storage, sem uso possível; (c) _escanear de forma síncrona no upload_ — prende a requisição pelo tempo do ClamAV e derruba o upload quando o scanner cai, trocando disponibilidade por uma verificação que pode ser feita antes do único momento que importa (a saída).

**Residual aceito:** o `zPING`→`PONG` que confirma a identidade do clamd roda em OUTRA conexão que a do veredito — atrás de DNS round-robin ou balanceador, quem responde `PONG` pode não ser quem escaneia, e `PONG` não é autenticação. Ele é defesa em profundidade e cumpre o que promete (fechar o caso provável do host apontado para o serviço errado); quem sustenta a garantia é o parser fail-closed mais a regra de rede da §7 — instância nossa, mesmo limite de rede.

**Consequências:** existe uma janela entre o upload e o veredito em que o arquivo é `pending`: baixável internamente, barrado para fora. É a mesma janela que a política de §7.5 já assumia. E existe um estado observável de "quarentena com bytes ainda no disco" — deliberado, porque a alternativa seria mentir sobre a remoção.

## ADR-044 — Sugestão de resposta: a IA redige, o humano decide, o domínio envia

**Status:** aceito · **Data:** 2026-08-24

**Contexto:** a Entrega 9.3 é a primeira capacidade de IA que toca um efeito **externo e irreversível**: uma mensagem no WhatsApp de uma pessoa real. Todo o caminho de envio já existe e é caro de conquistar — política de janela de 24h, opt-in, quota de plano com reserva, `Message` append-only, `MessageDispatch` com lease/fencing e outbox (ADR-037, ADR-039). A tentação é a IA "só chamar a Meta"; o ADR-027 (IA não toca Prisma) e o ADR-030 (ação externa é proposta aprovada por humano) já dizem que não.

**Decisão:**

1. **Só janela livre.** A sugestão existe apenas para conversa de WhatsApp dentro das 24h de resposta gratuita. Template é mensagem iniciada pelo negócio, com conteúdo pré-aprovado e parâmetros posicionais: sugerir texto livre para ele é sugerir algo que a Meta não aceitaria. Fora da janela a capacidade se declara indisponível — e o motivo vem do servidor.
2. **Consentimento é portão, não filtro.** Sem `AiConsent.conversationContent` vigente **não há chamada ao provedor** — o run nasce `refused/no_consent`, como no resumo de conversa (ADR-028). A sugestão é literalmente derivada do corpo das mensagens; pedir para depois descartar já teria enviado o dado.
3. **A IA não tem ferramenta de escrita.** A capacidade devolve **um rascunho** validado por Zod estrito (texto, limite de tamanho, sem anexo, sem destinatário, sem canal). Não há tool de envio para o modelo chamar: a contenção de prompt injection não é o prompt, é a **ausência de superfície**. O pior caso de uma instrução escondida na mensagem do contato é um rascunho ruim que um humano lê antes de aprovar.
4. **Aprovar delega ao domínio.** `WhatsappSendService.enqueueOutbound` foi partido em duas peças sem mudar o comportamento do caminho humano: `prepareOutbound` (carrega conversa, avalia política, reserva quota — fora da transação, como sempre foi) e `writeOutboundWithin(tx, …)` (cria `Message`, `MessageDispatch`, toca a conversa, enfileira no outbox). A aprovação da proposta compõe as duas. O módulo `src/intelligence` continua sem escrever `Message` e sem conhecer transporte; quem compõe é o adaptador em `src/intelligence-persistence`, onde os services de domínio já vivem (ADR-027).
5. **Proposta, mensagem e enfileiramento são uma transação.** O CAS `pending → executing` acontece **dentro** da mesma transação que grava a mensagem. Duas aprovações simultâneas: uma vence o CAS, a outra vê `count === 0` e recebe 400 — no máximo uma `Message` e um `MessageDispatch`. É o mesmo desenho do `create_task` (ADR-030), agora com um efeito que sai do sistema.
6. **Política é reavaliada na aprovação, não na geração.** `prepareOutbound` roda **antes** do CAS. Se a janela fechou, o opt-in caiu ou a quota estourou entre gerar e aprovar, ele lança — a proposta **permanece `pending`**, com erro explícito em pt-BR. Uma proposta consumida por política vencida seria pior que um erro: perderia o rascunho e mentiria sobre o motivo.
7. **A trilha separa quem redigiu de quem mandou.** `AuditLog` recebe `actorType='ai'`, `actorId=AiRun.id` e `actorMembershipId` = quem aprovou. Sem os dois lados, ou a IA vira anônima ou uma pessoa carrega a autoria de um texto que não escreveu.
8. **Editar o rascunho muda a autoria.** O aprovador pode reescrever antes de aprovar. Se o corpo enviado for idêntico ao da proposta, `Message.authorType='ai'`; se foi editado, `'user'` — e é esse `authorType` que a auditoria registra (a allowlist de `message` o admite; um campo `edited` seria a mesma informação com outro nome fora dela). `authorMembershipId` é sempre o aprovador nos dois casos. Marcar como IA um texto reescrito por uma pessoa corromperia a única fonte que responde "quanto do que saiu daqui foi escrito por modelo".
9. **RBAC cumulativo.** Aprovar exige `intelligence:approve` **e** `conversations:write`: a primeira governa agir por proposta de IA, a segunda governa falar com o contato. Quem revisa IA sem poder responder não adquire o poder de responder por intermédio dela.
10. **Sem anexo nesta entrega.** O rascunho é texto. Mídia externa depende da validação WABA e do transporte de mídia, que seguem pendentes.

**Alternativas descartadas:** (a) _dar ao modelo uma tool de envio com aprovação depois_ — inverte o ADR-030 e transforma injection em envio; (b) _gerar a proposta já com a quota reservada_ — uma reserva presa a um rascunho que pode nunca ser aprovado bloqueia teto de plano por horas, e a política teria de ser reavaliada de todo modo; (c) _reimplementar o envio no adaptador de IA_ — duplicaria janela, opt-in, quota e outbox, e a segunda cópia envelheceria em silêncio; (d) _`authorType='ai'` sempre_ — barato, mas falso quando o humano reescreve.

**Consequências:** o caminho humano de envio ganhou uma costura interna (prepare/write) que precisa continuar coberta pelos testes de 9.1.b — a garantia é que ambos os chamadores passam pelas mesmas duas peças, não por caminhos parecidos. E existe um estado observável de proposta `pending` que **não pode ser aprovada** porque a janela fechou: deliberado, porque a alternativa é enviar fora da janela ou apagar a evidência de que a IA sugeriu algo.

**Adendo 1 (2026-08-24) — no máximo um rascunho pendente por conversa, garantido pelo banco.** Duas propostas pendentes na mesma conversa convidariam a aprovar as duas — duas mensagens reais para a mesma pessoa, cada uma "aprovada por um humano". A garantia não pode morar na aplicação: duas gerações simultâneas superseiam uma à outra e, se uma supersessão falhar, sobram duas aprováveis. Por isso:

1. `AiProposal.pendingReplyMark` é `TRUE` enquanto o rascunho está `pending` e `NULL` em qualquer outro estado, com `@@unique([workspaceId, conversationId, pendingReplyMark])` — o mesmo padrão de `ContactChannelConsent.activeMark` e `Plan.isDefault`, usado porque `NULL`s são distintos no unique e o Prisma não expressa índice parcial. Proposta de tarefa nasce com `NULL` e não é constrangida.
2. Supersessão e criação acontecem na MESMA transação: gerar um rascunho novo marca o anterior como `expired` (não `rejected` — ninguém o recusou, ele ficou obsoleto) e insere o novo.
3. Quando o banco recusa o segundo pendente, a geração perdedora devolve **o rascunho vencedor** em vez de um erro: quem pediu queria um rascunho para revisar, e existe um.

A supersessão gera `AuditLog` próprio (`ai_proposal.superseded`, adendo 3), distinto de `ai_proposal.expired`: ela invalida trabalho que outra pessoa poderia aprovar, então a trilha diz quem gerou o substituto e qual rascunho morreu.

**Residual aceito:** o `proposalId` devolvido por uma geração pode já ter sido superseded por outra — inerente, e igual ao caso trivial de clicar "sugerir" duas vezes. Aprovar um rascunho obsoleto é recusado com motivo claro e **não envia nada**; a tela recarrega o pendente atual. E o run da geração perdedora fica registrado com `action='proposed'` embora seu rascunho tenha sido descartado: o custo foi real e a contabilidade não mente sobre ele, mas a contagem de runs "que propuseram" pode exceder a de propostas na fila.

**Adendo 2 (2026-08-24, revisto) — descartar um rascunho exige as MESMAS permissões de enviá-lo.** A primeira versão deste adendo tratava a rejeição como agnóstica de tipo, argumentando que descartar "só reduz poder". O usuário bloqueou o push por isso, e com razão: `POST /proposals/:id/reject` exigia apenas `intelligence:approve`, então um papel que aprova IA mas **não pode escrever conversas** descartava a resposta que uma pessoa ia mandar a um paciente — bastava conhecer o id, que a própria fila de IA entrega. Descartar não é limpeza de fila: é decidir o que **deixa de ser dito** ao contato, e isso é ação sobre a conversa.

1. `POST /proposals/:id/reject-reply` exige `intelligence:approve` **e** `conversations:write` — a mesma exigência cumulativa de aprovar (item 9).
2. `POST /proposals/:id/reject` fica **exclusiva de `create_task`** e recusa `send_message`, como a rota de aprovação de tarefa já recusava. A restrição é do TIPO, não do ator: o mesmo revisor continua descartando propostas de tarefa.
3. A tela segue a mesma regra: sem as duas permissões, o painel do inbox mostra o rascunho (quem tem `conversations:read` já podia ler a conversa) e **nenhuma ação utilizável** — enviar desabilitado, descartar ausente. Esconder apenas o envio deixaria o descarte como um poder de decisão concedido pelo id.

**Lição registrada:** "reduz poder" não é sinônimo de "não precisa de permissão". Destruir um artefato que só existe dentro de um domínio é ação daquele domínio. A supersessão, que substitui em vez de destruir, ficou registrada como exceção — e o adendo 3 a fechou.

## Adendo 3 (2026-08-24) — gerar rascunho também exige `conversations:write`

**Contexto:** o adendo 2 fechou o descarte e deixou a supersessão como exceção documentada: gerar uma sugestão nova expira o rascunho pendente (adendo 1) e exigia apenas `intelligence:use` + `conversations:read`. O argumento para mantê-la era que substituir não é destruir — a fila nunca fica vazia, e quem supersede não ganha voz na conversa. O usuário decidiu o contrário, e a decisão é melhor: **gerar rascunho novo altera o estado da conversa e invalida o trabalho de outra pessoa** — alguém pode estar a um clique de aprovar aquele texto.

**Decisão:** `POST /intelligence/conversations/:id/reply-suggestion` exige `intelligence:use` + `conversations:read` + `conversations:write`.

1. **Ler e analisar continua com `conversations:read`**: o `GET` do rascunho pendente não mudou. Quem revisa sem responder continua vendo a conversa inteira e o rascunho — só não substitui o que outra pessoa poderá enviar.
2. **Toda supersessão gera `AuditLog`** (`ai_proposal.superseded`), na MESMA transação que expira o anterior e insere o substituto: ator é quem gerou, `entityId` é o rascunho substituído e `after.supersededByProposalId` aponta o que o substituiu. `supersededByProposalId` entrou na allowlist de `aiProposal` por ser **id, não conteúdo** — o corpo do rascunho nunca entra na trilha.
3. **O trade-off é intencional e está aceito:** quem não pode escrever na conversa pode ler, analisar e revisar, mas não substituir. Vale para a tela também — sem `conversations:write` o botão de gerar aparece desabilitado, com o motivo.

**Consequência:** o modelo de permissão fica coerente — decidir sobre um rascunho (aprovar, descartar) e produzir um que substitui outro são, todos, ações sobre a conversa. Some a única exceção permanente que o adendo 2 tinha aberto.

## ADR-045 — O produto tem moldura e tem entrada: `Hoje` como raiz, e uma faixa de aplicação

**Status:** aceito · **Data:** 2026-08-25

**Contexto:** a identidade visual foi executada (fontes, paleta, medidor de janela, marca de cobre da IA) e o produto continuou parecendo "um conjunto de páginas". A avaliação do usuário nomeou o que faltava melhor do que qualquer métrica: _"não tem topo, já começa com a página"_ e _"ainda sem personalidade"_. Duas ausências estruturais explicavam isso. A primeira: não havia moldura — nenhuma faixa constante dizendo onde a pessoa está, sem busca global, com notificação e conta escondidas no rodapé da barra lateral. A segunda, mais séria: `DESIGN_DIRECTION.md §1` promete **duas densidades** — a executiva, com respiro e poucos números grandes, e a operacional, densa — e só a operacional existia. `/` redirecionava para `/pipeline`: entrar no produto era cair numa tabela, e a identidade nunca tinha um lugar para respirar.

**Decisão:**

1. **`/` deixa de ser redirect e vira tela: `Hoje`**, destino do login. É a visão executiva do §1 — hierarquia tipográfica forte, números em mono, espaço.
2. **Só dado que já existe.** Nenhuma métrica nova, nenhum endpoint novo, nenhum gráfico decorativo: janelas fechando vêm de `GET /api/conversations`, propostas pendentes de `GET /api/intelligence/proposals`, tarefas de `GET /api/tasks`, funil do mesmo dado do pipeline, teto de plano do `usedRatio` que o servidor já calcula. Cada número responde uma pergunta e leva ao lugar onde se age. Dashboard cujo gráfico não responde pergunta é proibido pelo §2 do documento de design, e a regra vale para a nossa própria tela inicial.
3. **A janela de 24h é o herói.** É a coisa mais característica deste produto — a regra da plataforma que governa se dá para responder agora. Na `Hoje` ela deixa de ser detalhe de rodapé e vira o número grande da tela.
4. **Faixa de aplicação persistente**: rastro (workspace / bloco / seção), busca global por `⌘K` e o cluster de notificação, tema e conta. A busca tem **duas fontes reais** — contatos e seções —, e a de contatos só é disparada com `contacts:read`: a tela não pede o que o servidor negaria.
5. **`src/lib/nav.ts` é o mapa único de seções**, lido pela lateral, pelo rastro e pela busca. Três listas paralelas divergiriam na primeira seção nova.

**Alternativas descartadas:** (a) _manter `/pipeline` como entrada_ — pipeline é trabalho de vendas, não o estado do dia de quem atende, e deixaria o produto sem nenhuma superfície de respiro; (b) _dashboard com KPIs configuráveis_ — é produto de outro tamanho, e o MVP não tem pergunta nem dado para sustentá-lo; (c) _busca global sem fonte real, só navegação_ — atalho de teclado vestido de busca, que ensina o usuário a não confiar no campo.

**Consequências:** o login agora termina em `Hoje`, e os testes de ponta a ponta que interagiam com a tabela logo após entrar passaram a navegar explicitamente (`e2e/tests/helpers.ts` ganhou o destino como parâmetro). A `Hoje` depende de quatro endpoints: se algum ficar lento, é a primeira tela que sofre — cada bloco carrega e falha de forma independente, e nenhum bloqueia os outros. E existe uma tela a mais para manter em toda mudança de domínio: o preço de ter uma entrada.

## ADR-046 — Staging convive com a VPS existente: um proxy, um container de entrada, e um transporte falso que precisa de trava

**Status:** aceito · **Data:** 2026-08-25 · **Revisto após diagnóstico:** 2026-08-25 · **Transporte falso aprovado:** 2026-08-26

**Contexto:** o Veyra vai para `veyra-staging.malachdigital.com.br`, numa VPS que já hospeda VerboPlus, Norteie e outros projetos. O diagnóstico (somente leitura, 25/08/2026) mediu o que havia: Ubuntu 24.04 x86_64, Coolify 4.3.11 com **~40 containers**, proxy **Traefik v3.6** (`coolify-proxy`) dono de 80/443, rede `coolify`, certresolver `letsencrypt`, faixas 10.0.0.0/24 a 10.0.6.0/24 em uso, e — o número que mais restringe — **7,8 GB de memória com ~4,0 GB disponíveis e 1,4 GB de swap já consumido**. Qualquer coisa que dispute porta, rede, faixa de IP ou memória derruba serviço alheio.

**Decisão:**

1. **Um proxy só, e ele já existe.** O Veyra não sobe proxy e **não publica porta nenhuma, nem em loopback**: o container de entrada (`web`, nginx sem privilégio) escuta 8080 e o Traefik o alcança pela rede `coolify`. O roteamento é por **labels** — é como o Traefik se configura, e o trecho de nginx que a primeira versão deste ADR previa não teria servido para nada. As labels reaproveitam o padrão da casa (entrypoints `http`/`https`, `certresolver=letsencrypt`), mas com **middlewares próprios**: usar os de outro container amarraria o Veyra ao ciclo de vida dele.
2. **O container de entrada também serve `/api`.** Assim o proxy da VPS ganha **um** upstream em vez de duas regras, e `/api/channels/whatsapp/webhook` funciona sem tratamento especial. O nginx interno não bufferiza nem transforma o corpo: a assinatura HMAC do webhook é calculada sobre os bytes exatos (ADR-037).
3. **Isolamento por nome em tudo**: projeto `veyra-staging`, rede `veyra-staging` com faixa fixada em `172.28.7.0/24` (fora da sequência 10.0.x do Coolify), volumes `veyra-staging-*`, diretório `/opt/veyra-staging`. Nenhum recurso compartilhado com os vizinhos, e a limpeza do Veyra nunca alcança VerboPlus ou Norteie.
4. **ClamAV desligado por padrão** (perfil `scanner`), por capacidade e não por preferência: ele pede 1,5–2 GB residentes numa máquina com ~4 GB livres e swap já em uso, e ligá-lo arriscaria empurrar o VerboPlus de PRODUÇÃO para swap. Sem scanner, arquivo fica `pending` e não sai para canal externo (ADR-043) — a degradação segura, que em staging com dado fictício não custa nada. Volta com um comando quando a memória permitir.
5. **Nenhuma porta de banco publicada.** O Postgres existe só na rede do projeto. O VerboPlus tem Postgres com porta pública nesta mesma VPS, com hardening pendente registrado nos docs dele; não repetimos o padrão.
6. **Segredo só em `/opt/veyra-staging/.env`**, root, `0600`, fora do repositório e fora de qualquer log. O repositório carrega apenas `.env.example` com placeholders (CLAUDE.md §3.12).
7. **Backup para destino externo, cifrado, com verificação.** `restic` num container próprio: dump lógico do Postgres por STDIN (sem arquivo temporário com dado no disco) + storage, retenção com `--prune` e `check` por amostragem a cada ciclo. Backup no mesmo disco que ele protege não é backup, e backup que ninguém verifica não é backup.
8. **Migration é passo explícito de deploy** (`run --rm api npx prisma migrate deploy`), nunca no boot do container: dois containers subindo ao mesmo tempo disputariam o mesmo schema, e um deploy que migra sozinho tira do operador a decisão sobre a única etapa irreversível.

**Transporte falso do WhatsApp (aprovado em 26/08/2026).** O requisito de staging é não enviar nada para a Meta. Hoje o `META_TRANSPORT` é fixo (`GraphApiTransport`), então cumprir isso exige **mudança em código de produto**: escolher o transporte por ambiente. É um caminho que FINGE um efeito externo, e por isso não entra sem trava:

- seleção por `META_TRANSPORT_MODE` (`graph` por padrão — a ausência da variável nunca produz transporte falso);
- `env.ts` **recusa o boot** se `META_TRANSPORT_MODE=fake` e `VEYRA_ENV` não for `staging`, do mesmo jeito que o harness de teste recusa banco cujo nome não contenha "test";
- o transporte falso registra em log, no boot e em cada envio, que nada saiu — um ambiente que finge envio em silêncio é pior que um que falha.

Implementado com duas decisões que só apareceram ao escrever: a seleção é por **fábrica** e não por classe, porque dois providers do mesmo símbolo se sobrescreveriam pela ordem do array — dependência de ordenação que ninguém enxerga em revisão; e o `externalId` sintético é **marcado** (`wamid.FAKE-…`), impossível de confundir com um wamid da Meta em log, banco ou tela. A coleta de mídia **falha de propósito** em vez de devolver bytes inventados: bytes sintéticos passariam pelo scanner e virariam anexo real no banco, um arquivo que ninguém enviou.

**Alternativas descartadas:** (a) _proxy próprio do Veyra em 80/443_ — disputa direta com o proxy existente, derruba os vizinhos; (b) _compose puro por SSH_ — era a minha recomendação inicial, e a operação decidiu o contrário (ver adendo 1). O arquivo continua servindo aos dois modos; (c) _banco compartilhado com outro projeto_ — quebra o isolamento que o produto inteiro sustenta desde a Entrega 1.

**Consequências:** o Veyra depende do Traefik do Coolify — uma mudança nele derruba o staging, e é o preço de não subir um segundo proxy. A máquina está apertada de memória: qualquer serviço novo aqui, do Veyra ou de outro projeto, precisa passar pela mesma conta que desligou o ClamAV. E o diagnóstico precisa ser refeito quando a VPS mudar de forma — a primeira versão deste ADR supôs um nginx de host a partir de um cabeçalho HTTP visto de fora, e estava errada: era uma aplicação atrás do Traefik. Supor topologia por evidência indireta produziu configuração que não serviria.

**Adendo 1 (2026-08-26) — o Veyra entra como recurso do Coolify.** Decisão da operação, e ela manda: toda a casa é Coolify, e um serviço fora do painel é um serviço que ninguém lembra que existe. Três consequências que valem estar escritas, porque nenhuma é neutra.

1. **O painel passa a ser dono do roteamento.** As labels de Traefik saem do compose: quem as gera é o Coolify, a partir de `SERVICE_FQDN_WEB_8080`. Manter as minhas produziria duas regras para o mesmo host, e qual vence depende da ordem de leitura do proxy — o tipo de conflito que só aparece num restart, meses depois.
2. **Nome de projeto, rede e volumes deixam de ser fixos**, porque o Coolify os prefixa com o id do recurso. É o que garante que não colidam com os ~40 vizinhos, e é também o que obriga o runbook a começar anotando os nomes reais: um roteiro de restauração com nome errado é pior que nenhum.
3. **Os segredos ficam nas variáveis do painel — decidido pelo padrão da casa.** A instrução original era "segredos exclusivamente em arquivo fora do repositório, por exemplo `/opt/veyra-staging/.env`", e a mudança foi avaliada contra o que os projetos vizinhos fazem. O VerboPlus registra a MESMA decisão, tomada depois de um incidente: _"Segredos só em env vars (Coolify) — pós-incidente de segredos versionados no git e rotacionados em 2026-06-12"_. Reverter para arquivo sem motivo novo desfaria aprendizado que já foi pago.

   A superfície muda e isso fica escrito: **quem tem o painel tem os segredos**, sem precisar de SSH. Com root na máquina os dois modos são igualmente legíveis (`docker inspect` mostra as variáveis de qualquer container), então o que o painel acrescenta é uma porta a mais — mitigada por 2FA e por poucos operadores, não pelo formato de armazenamento. O próprio VerboPlus registra o custo com todas as letras: "depende de gestão correta no Coolify".

   O que NÃO muda, e é a parte que mais importa: o Veyra continua separando os dois tipos de segredo. Chave de plataforma (JWT, cifra, senha do banco) vai em variável de ambiente; segredo de terceiro POR WORKSPACE — o token do canal WhatsApp — continua **cifrado no banco** com AES-256-GCM e chave independente (CLAUDE.md §3.12). O VerboPlus faz o mesmo com as chaves do Asaas, cifradas e mascaradas, "não em env var". O padrão dos dois projetos coincide: env var para o que a plataforma precisa no boot, cifra no banco para o que pertence a um cliente.

   O caminho híbrido (arquivo em `/opt/veyra-staging/.env`) fica registrado no runbook §11.2 como reversão possível, não como pendência.

**Residual aceito:** com transporte falso, nenhum recibo de status volta da Meta — o `MessageDispatch` fica em `sent` para sempre e a quota é cobrada. Na tela, "enviada" fica indistinguível do envio real para quem não olha o banco; o `externalId` marcado (`wamid.FAKE-…`) é o que distingue.

## ADR-047 — Contrato de extensão do Core: seis pontos de composição, nenhum registro de plugins

**Status:** aceito · **Data:** 2026-10-19 · Aprovação da F0 (documental): aprova o desenho, não código nem migrations; nada implementado até a F1

### Contexto

O ADR-015 decidiu **como** um vertical estende o Core (extension tables, custom fields, entidades próprias, composição no bootstrap), mas o código de hoje não tem onde o vertical se encaixar. Os registros que um vertical precisa alimentar são constantes fechadas dentro do Core:

- `WORKSPACE_MODELS`, `APPEND_ONLY_MODELS` e `RELATION_TARGETS` (`apps/api/src/prisma/workspace-models.ts`), conferidos por um teste de drift que lê **um** arquivo, `prisma/schema.prisma`;
- `PERMISSION_CATALOG` e `PermissionKey` (`packages/contracts/src/permissions.ts`): `@RequirePermissions(...keys: PermissionKey[])` só aceita chaves do Core em tempo de compilação;
- `SYSTEM_ROLE_TEMPLATES`: `Owner` recebe `[...PERMISSION_KEYS]` e `Admin` recebe todas menos `billing:manage`. **Qualquer chave adicionada ao catálogo do Core vai automaticamente para o Owner e o Admin de todo workspace provisionado**, use ele o vertical ou não;
- `AUDIT_FIELDS` (`apps/api/src/audit/audit.service.ts`): allowlist por entidade. Entidade não registrada tem todos os campos gravados como `"[changed]"`, ou seja, o comportamento já é fail-closed;
- `src/lib/nav.ts` no web, o mapa único de seções (ADR-045);
- a montagem de contexto da IA (`src/intelligence`), a aprovação de propostas, o despacho de mensagens e a entrega de eventos a webhooks (`OUTBOX_EVENTS`) não sabem que um contato pode estar no contexto de um vertical com dado de saúde. O ADR-048 exige que saibam, sem que o Core conheça o vertical.

Sem pontos de extensão, a única forma de o Clinics existir seria editar esses arquivos com nomes do vertical. Isso viola o CLAUDE.md §3.8 (o Core não conhece verticais) já no primeiro commit.

### Alternativas consideradas

1. **Editar os registros do Core listando modelos e chaves do Clinics.** É o caminho mais curto, mas faz o Core nomear o vertical, e o efeito colateral do `Owner = [...PERMISSION_KEYS]` daria permissões clínicas a todo workspace. Descartada.
2. **Registro genérico de plugins** (manifesto, descoberta dinâmica, ganchos de ciclo de vida). Já foi descartado no ADR-015. Construiria um framework para um único vertical, e cada gancho genérico seria uma superfície de isolamento a mais para revisar. Descartada.
3. **Vertical em pacote ou banco separado, com Prisma client próprio.** Sem o mesmo banco não existe FK composta `ClinicsPatient(workspaceId, contactId) → Contact(workspaceId, id)`, e o isolamento passaria a depender de disciplina entre dois clients. Descartada.
4. **Composição explícita na raiz do produto, por pontos neutros e fechados.** Escolhida. Cada ponto existe porque o Clinics precisa dele agora, e nenhum descobre nada sozinho: a raiz de composição declara o que entra.

### Decisão

**1. Onde o vertical mora.** O código fica em `apps/api/src/verticals/clinics/`, `packages/contracts/src/verticals/clinics/` e `apps/web/src/verticals/clinics/`. O schema fica em arquivo próprio, no **mesmo** banco e na mesma pasta de migrations, usando o schema Prisma em vários arquivos (o `prisma.config.ts` passa a apontar para uma pasta). O mesmo banco é requisito: as FKs compostas para `Contact` dependem dele.

**2. Barreira de dependência.** Só a **raiz de composição** importa `verticals/`: `app.module.ts` na API e a raiz de rotas e navegação no web. O restante do Core é proibido de importar o vertical por `no-restricted-imports`, com um teste de fronteira que repete a regra, no mesmo padrão do ADR-027. Um vertical importa services e contratos do Core; o caminho contrário é bloqueado. Quando o Core precisa de uma resposta do vertical (E2 e E6), ele declara uma **porta** com nome neutro, e o vertical fornece a implementação na raiz de composição.

**3. Os seis pontos de extensão, e somente eles:**

| #   | Ponto                                                 | Como funciona                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | O que continua garantido                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Modelos protegidos                                    | O `PrismaService` passa a receber, por injeção, o conjunto **composto na raiz** (Core ∪ vertical) de modelos protegidos, append-only e alvos de relação. O teste de drift passa a ler **todos** os arquivos do schema.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Modelo com `workspaceId` fora do conjunto composto continua deixando o build vermelho. Sem contexto de workspace, a query continua sendo recusada.                                                                                                |
| E2  | Catálogo de permissões e disponibilidade              | O vertical declara catálogo próprio com prefixo obrigatório (`clinics:`), mais uma porta de **disponibilidade**: dado um workspace, quais chaves do vertical podem ser concedidas ali (no Clinics, só onde ele está **ativo**). O seed de permissões usa o catálogo composto. Qualquer caminho do Core que atribua permissões a papéis consulta essa porta e **recusa** chave indisponível. Cada lado tem seu decorator tipado; **no boot**, toda chave exigida por alguma rota precisa existir no catálogo composto. **`SYSTEM_ROLE_TEMPLATES` do Core não muda.**                                                                                                                      | Default-deny inalterado. Workspace sem o vertical ativo não recebe chave dele por nenhum caminho.                                                                                                                                                 |
| E3  | Ativação por workspace e papel do vertical            | O Core **não ganha** flag de vertical. Ativação e desativação são do vertical, com ciclo de vida no item 4. O vertical pode criar **papéis de sistema próprios**, identificados por `systemKey` com prefixo do vertical (`clinics:professional`). Isso refina o ADR-017: o Core continua ramificando **só** por `owner` e ignora valores que não conhece.                                                                                                                                                                                                                                                                                                                                | Revogação imediata (ADR-009). Nenhuma escrita em workspace que não pediu o vertical. Papel nunca identificado por nome.                                                                                                                           |
| E4  | Allowlist de auditoria                                | O `AuditService` recebe as allowlists compostas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Entidade sem allowlist continua com todos os campos gravados como `"[changed]"`.                                                                                                                                                                  |
| E5  | Navegação e rotas (web)                               | O vertical contribui rotas e entradas para o mapa único de seções na raiz do web. As entradas só aparecem quando `GET /api/clinics/status` responde que está ativo **e** a pessoa tem a permissão da seção.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `nav.ts` continua sendo o mapa único (ADR-045).                                                                                                                                                                                                   |
| E6  | Restrição de conteúdo por contato, **por consumidor** | O Core declara uma porta neutra: dado um workspace, um **consumidor** (`ai` ou `webhook`) e um conjunto de contatos, quais estão **restritos para aquele consumidor**. O vertical implementa a porta, com as regras do ADR-048 §6.4. Uma liberação para um consumidor **nunca** vale para outro. Os pontos de checagem no Core estão listados no ADR-048 §6.3: toda chamada ao provedor de IA, a leitura de resultados e propostas persistidos, a aprovação, o despacho de mensagem de autoria da IA e a entrega a webhooks (conferida **na entrega**, não só na emissão). Quando a porta responde com erro, o contato é tratado como restrito. O resultado **não é guardado em cache**. | O Core não sabe **por que** um contato é restrito, só **que** é, e para qual consumidor. Workspace sem o vertical segue o comportamento normal do Core. Mensagem escrita por pessoa não é afetada: a clínica continua conversando com o paciente. |

**4. Ciclo de vida da ativação (E3).**

Estados: _ausente_ → `active` ⇄ `disabled`. O estado fica em `ClinicsSettings` (1:1 com o workspace), com `activatedAt` e `disabledAt`. A ativação e a desativação acontecem **só pela CLI administrativa do vertical**, com `raw` justificado como em `provision`. Não existe ativação pela interface (ADR-014).

| Comando                  | Estado atual          | Efeito                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clinics:enable --slug`  | ausente               | Cria `ClinicsSettings(active)` e a unidade inicial; cria o papel `Profissional` (`systemKey: 'clinics:professional'`) **se não existir**; concede a matriz do ADR-048 §5 aos papéis **por `systemKey`**; incrementa o `tokenVersion` das memberships afetadas; grava `AuditLog` `clinics.enabled` com `actorType: 'system'`. A partir do commit, **todo contato do workspace, existente ou futuro, está restrito** (ADR-048 §6.4). A CLI dispara a expiração de resultados e propostas de IA anteriores e **imprime quantos webhooks ativos o workspace tem**, avisando que eles deixam de receber eventos de contatos (ADR-048 §6.5). |
| `clinics:enable --slug`  | `active`              | **Nada muda.** Sai com código 0 e a mensagem "já ativo". Não recria o papel nem concede a matriz de novo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `clinics:enable --slug`  | `disabled`            | Reativa: volta a `active` e concede a matriz **aos papéis de sistema e ao `Profissional`**, que nunca são removidos. Papéis customizados não existem hoje (não há API para criá-los), então não há o que restaurar. Incrementa o `tokenVersion`, grava `clinics.reenabled` e repete o aviso de webhooks. Os dados estão intactos; as liberações de IA não desfeitas voltam a valer.                                                                                                                                                                                                                                                    |
| `clinics:disable --slug` | `active`              | Passa a `disabled`; **remove todas as chaves `clinics:*` de todos os papéis do workspace**; incrementa o `tokenVersion` das memberships afetadas; grava `clinics.disabled`. O papel `Profissional` **permanece**, só com as chaves do Core que tiver, porque apagá-lo deixaria memberships sem papel. As rotas passam a responder 404, a navegação some e os jobs do vertical pulam o workspace. **Nenhum dado é apagado nem anonimizado**, e **a restrição de conteúdo continua valendo**; as liberações de IA ficam suspensas.                                                                                                       |
| `clinics:disable --slug` | ausente ou `disabled` | Nada muda; sai com código 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Cada comando roda numa transação única, sob lock consultivo por workspace, e reexecutar é sempre seguro: o efeito depende do estado, não do número de execuções. O papel `Profissional` é localizado pelo `systemKey`, protegido pelo unique `(workspaceId, systemKey)`, e nunca pelo nome: um papel chamado "Profissional" criado de outra forma não é confundido com ele.

**O que a desativação NÃO faz:**

- **Não apaga dados.** Os registros de classe S continuam sob a política pendente do ADR-048 §9. Desativar não é um atalho para excluir.
- **Não levanta a restrição de conteúdo (E6).** Desativar muda o **status**, e a restrição **não lê o status** (ver "Ciclo de vida da restrição" abaixo).
- **Não remove o vertical do workspace.** Apagar os dados do Clinics só acontece por exclusão do workspace inteiro (cascade do Core, que leva junto os próprios contatos) ou pela política que vier do ADR-048 §9. Não existe comando "purgar Clinics" no MVP.

**Ciclo de vida da restrição (E6) — independente do status da ativação.** A ativação e a restrição são coisas **distintas**:

- a **ativação** (`active`/`disabled`) controla **acesso ao vertical**: rotas, navegação, permissões e jobs;
- a **restrição** depende da **presença do vertical no workspace**, que não acaba ao desativar.

Regras:

1. **Gatilho da restrição.** A porta do E6 considera o workspace **com Clinics presente** quando existe a linha `ClinicsSettings`, **em qualquer status**, **ou** quando existe qualquer linha de dados do vertical no workspace (paciente, agendamento, atendimento, pacote, liberação). A implementação da porta **não filtra por `status`**. O segundo critério é redundância deliberada: mesmo que a linha `ClinicsSettings` desaparecesse por uma rotina fora do produto, a presença de dados mantém a restrição.
2. **A linha `ClinicsSettings` nunca é apagada pelo vertical.** Desativar só muda o status. Nenhum comando, rota ou job do vertical a remove.
3. **Com o Clinics `disabled`**:
   - a IA continua recusando todos os contatos restritos, em todos os pontos do ADR-048 §6.3;
   - os webhooks continuam sem receber eventos ligados a contato;
   - resultados e propostas persistidos continuam ocultos;
   - **as liberações de IA ficam suspensas**: todo contato volta a ser restrito para IA até a reativação. Com o vertical desativado as rotas respondem 404, então ninguém conseguiria gerenciar ou desfazer uma liberação. Mantê-las valendo sem ninguém poder revogá-las seria abrir em vez de fechar.
4. **Reativar** devolve o acesso ao vertical e a validade das liberações de IA ainda não desfeitas. A restrição em si nunca foi interrompida.
5. **Levantar a restrição num workspace não é possível no MVP.** Só deixa de haver restrição se o workspace inteiro for excluído. Qualquer outro caminho (por exemplo, purgar o Clinics depois da decisão do ADR-048 §9) exige ADR próprio.
6. **Falha ao avaliar a presença** do vertical é tratada como "presente", ou seja, restrito.

**Como a ativação alcança contatos já existentes.** A restrição **não é uma marca gravada em cada contato**: ela é **derivada**, a cada checagem, da presença do vertical (regra 1). Por isso não há backfill nem janela: no instante em que a transação de ativação faz commit, todo contato do workspace, os que já existiam e os que vierem depois, passa a ser restrito em todos os pontos de checagem, sem depender de nenhum processo ter percorrido os contatos. Dois casos ficam cobertos à parte:

- **Conteúdo derivado antes da ativação** (resultados de IA e propostas pendentes): a leitura confere a restrição e **não devolve** esse conteúdo. A expiração disparada pela CLI só limpa o que a leitura já esconde, e se falhar não abre nada.
- **Operação em andamento no momento da ativação** (uma chamada à IA já em curso, um evento já no outbox): o resultado é bloqueado na **leitura**, e o evento na **entrega**. O que estava em voo não sai por causa disso.

**5. O que deliberadamente NÃO vira ponto de extensão agora.** Cada item abaixo, se um dia for necessário, entra com ADR próprio e gatilho:

- **Timeline do Core** (`Activity`, ADR-011): adicionar um tipo de referência é coluna nova numa tabela do Core, então abrir esse ponto faria o Core conhecer o vertical. O Clinics mantém histórico próprio.
- **Catálogo de automações** (ADR-035) e **catálogo de eventos de webhook**: o vertical não publica evento nenhum. A única relação com webhooks é a supressão do E6.
- **Ferramentas de IA** sobre dados do vertical.
- **Restrição de LEITURA por contato nas telas do Core** (notas, tarefas e conversas de contato restrito exigirem permissão adicional). É o caminho para levantar o bloqueio B1 do ADR-048 e entra, se aprovado, como ADR próprio.
- **Criação e edição de papéis pelo admin.** É uma lacuna do Core, não do vertical (ADR-048 §5).
- **Quotas e billing por vertical**, e **`CustomFieldEntity`** para entidades do vertical.

**6. "O Core não depende do vertical" é verificado, não prometido.** A regra de lint e o teste de fronteira são obrigatórios desde o primeiro commit do vertical. Rodar a suíte do Core com uma composição sem o vertical é desejável; se o custo couber, isso entra no critério de aceite da F1.

### Consequências

- O Core muda em pontos universais (`PrismaService` e teste de drift, decorator, seed e atribuição de permissões, `AuditService`, cliente de LLM e montagem de contexto da IA, leitura de resultados e propostas, aprovação, despacho de mensagem, entrega de webhooks, raiz do web) **sem nenhum nome de vertical**. As mudanças tocam tenancy, RBAC e IA, então a F1 exige `reviewer` + `security` antes do commit (CLAUDE.md §5.4).
- A garantia "toda chave existe" é dividida em duas checagens de compilação (uma em cada lado) mais uma no boot.
- O `systemKey` passa a aceitar valores com prefixo de vertical. Toda lógica do Core que hoje pressuponha exatamente quatro papéis de sistema precisa ser conferida na F1.
- O E6 tem efeito visível no Core: num workspace com o Clinics, capacidades de IA recusam contatos restritos com motivo explícito, e **integrações por webhook já existentes deixam de receber eventos sobre eles** (ADR-048 §6.5).
- Desativar o vertical é reversível e não destrutivo. O preço é que um workspace desativado continua guardando dado sensível, e continua restrito, até existir a política do ADR-048 §9.

### Testes exigidos na F1

- `enable` e `disable` repetidos convergem para o mesmo estado: sem linhas duplicadas, sem segundo papel `Profissional`, sem concessão repetida.
- Um papel customizado chamado "Profissional" não é confundido com o papel do vertical.
- Depois de `disable`, não resta nenhuma `RolePermission` com prefixo `clinics:` no workspace, o papel `Profissional` continua existindo e as sessões antigas caem na request seguinte. A restrição de conteúdo continua valendo depois do `disable` (bateria "Desativação e reativação" do ADR-048 §6.6).
- Num workspace não ativado, nenhum caminho do Core concede `clinics:*`.
- Rota do vertical em workspace `disabled` ou ausente responde 404, mesmo para quem guardou um token antigo.
- Contatos criados **antes** da ativação ficam restritos assim que a ativação faz commit, sem backfill. Um resultado de IA gerado antes da ativação deixa de ser devolvido.
- A bateria de restrição de conteúdo e de webhooks do ADR-048 §6.6.
- Teste de fronteira: nada fora da raiz de composição importa `verticals/`.

### Pontos a confirmar na F1 (não bloqueiam a aprovação)

- Nome e forma dos tokens de injeção; se o teste de drift lê os arquivos do schema por glob.
- Se a suíte do Core sem o vertical cabe no CI atual.

### Adendo 1 (2026-10-19) — implementação da F1.a e o que ela decidiu

A F1.a implementou os pontos E1, E2 (checagem de boot), E4 e E6 no Core, **sem nenhum vertical composto** (`src/composition.ts` vazio). E3 e E5 ficam para a F1.b, junto do primeiro consumidor. Algumas decisões só apareceram ao escrever o código:

1. **Forma da composição.** `src/extensions/` concentra o contrato (`CoreExtension`), o registro composto e validado (`composeRegistry`) e o `ExtensionsModule.forRoot(...)`, global, chamado só por `app.module.ts` a partir de `composition.ts`. O `PrismaService` e o `AuditService` recebem o registro por injeção. Sem ele, usam o registro do Core puro, de modo que um modelo de extensão não composto continua **proibido** no client protegido. A composição recusa no boot: modelo, chave ou allowlist que redefina algo do Core; nome de extensão que colida com namespace do Core; chave sem o prefixo da extensão; e relação acrescentada a modelo do Core apontando para fora da extensão.
2. **Schema em pasta.** `prisma/schema/schema.prisma`, com `prisma.config.ts` apontando para a pasta. Validado assim: o client gerado é idêntico (só muda o texto embutido do schema), `migrate status` está em dia, e `migrate diff` entre um banco migrado do zero e a pasta não encontra diferença. O teste de drift lê todos os arquivos `.prisma` da pasta e compara com o registro **composto**.
3. **E2 sem porta de disponibilidade.** Hoje nenhum fluxo do Core concede permissões a papéis, exceto o provisionamento, que usa só os templates do Core. A porta foi adiada, e o adiamento é seguro porque um teste protege a regra completa:
   - só `provisioning.service.ts` escreve `RolePermission` no Core;
   - os templates de papel só usam chaves do catálogo do Core;
   - o catálogo do Core só tem namespaces do Core;
   - provisionar com uma extensão composta não concede nem registra nenhuma chave dela.

   Um caminho novo de concessão quebra esse teste e passa a exigir a porta. A checagem de boot (toda chave exigida por rota existe no catálogo composto) está implementada.

4. **E6 na IA: um gateway, não o token do provedor.** Os testes substituem `LLM_CLIENT` por um provedor falso. Uma guarda colocada nesse token seria pulada justamente nos testes. Por isso a guarda é o `LlmGateway`, que envolve `LLM_CLIENT`; o serviço só fala com ele, e um teste garante que nenhum outro arquivo do módulo injeta o provedor.
   - Todo pedido declara um **escopo** (workspace e contatos cujo conteúdo carrega). Pedido sem escopo, ou com escopo vazio, é recusado.
   - A checagem acontece em três camadas: na capacidade, antes de ler qualquer corpo; antes de reservar quota; e no gateway, antes da rede. Uma restrição que surja entre a primeira e a última devolve a reserva inteira.
   - Leitura de resultado e de proposta persistidos, aprovação de proposta e despacho de mensagem de autoria `ai` reconferem.
   - O lead score continua determinístico e calculado no processo; só a redação pelo modelo é recusada.
5. **Conteúdo sem contato.** O sujeito `null` representa conteúdo que não se atribui a contato nenhum (conversa sem contato, evento cuja entidade sumiu). Quem implementa a porta decide o `null`; a regra do Clinics (ADR-048 §6.4) o trata como restrito.
6. **E6 nos webhooks.** Um mapa **exaustivo** sobre o tipo `WebhookEvent` diz de qual entidade é cada evento: evento novo no catálogo sem entrada no mapa não compila. Deal e tarefa são resolvidos para o contato no momento da entrega.
   - Entidade sem contato não tem o que restringir e sai.
   - Entidade que sumiu vira `null`.
   - Evento suprimido é concluído **sem** registro de entrega, porque o histórico de entregas é visível ao cliente. As automações não passam pela supressão.
7. **Operação de limpeza.** `IntelligenceService.expireContentFor(workspaceId, alvo)` anula resultados (pelo contato do run **ou** da conversa, já que o resumo só grava a conversa) e expira propostas pendentes, com trilha `system`. A F1.b a chama na ativação e ao criar perfil de paciente.
8. **Contrato público.** `content_restricted` passa a ser status possível do resumo, da sugestão de resposta e da próxima ação.

**Correções da revisão (`reviewer` + `security`, 2026-10-19), já implementadas e testadas:**

9. **Replay de idempotência.** O cache de idempotência devolvia o corpo guardado (resumo, rascunho, próxima ação) sem passar pela restrição. Agora `@Idempotent({ replayGuard })` consulta uma guarda no momento da repetição. Nas três rotas de capacidade, a guarda refaz a checagem de restrição; se o contato estiver restrito, o corpo guardado é **descartado** e a rota executa de novo, devolvendo `content_restricted` sem chamar o provedor. `expireContentFor` também apaga essas respostas do cache. Um teste estático exige guarda em toda rota de capacidade marcada com `@Idempotent`.
10. **Três estados na porta.** Além de liberado e restrito, existe **indisponível** (exceção, timeout de 3 s ou resposta malformada). Indisponível bloqueia como restrito, mas não descarta nada:
    - o webhook lança, e o dispatcher devolve o evento ao outbox com backoff;
    - o despacho vira `failed_before_send` (`restriction_unavailable`) e é retentado;
    - a aprovação devolve 503 e mantém a proposta pendente;
    - as capacidades devolvem 503 sem gravar run `content_restricted` (falha de infraestrutura não é recusa por restrição) e, por ser erro, nada fica no cache de idempotência;
    - a guarda de replay também tem três estados: indisponível responde 503 **sem** apagar o corpo guardado, e só "restrito" descarta e reexecuta (sem isso, uma oscilação da porta faria uma chamada nova ao provedor e duplicaria a proposta).

    A limpeza do cache de replay só apaga respostas **gravadas** (`completed`) das rotas de capacidade de IA. Apagar uma reserva em andamento liberaria uma execução concorrente duplicada.

    Fail-closed é "não sai", não "perde para sempre". O log da falha registra só o nome do erro, nunca a mensagem, que pode conter ids e valores.

11. **Tarefa pelo deal.** Uma tarefa responde pelo contato dela **e** pelo contato do deal a que pertence. Assim, uma tarefa criada a partir do deal de um paciente não sai por webhook.
12. **Modelos globais.** `CORE_GLOBAL_MODELS` lista os modelos sem `workspaceId` do Core (`User`, `Workspace`, `Permission`…). A composição recusa extensão que reivindique qualquer modelo do Core, exige o prefixo da extensão nos modelos dela (`Clinics*`) e confere se eles existem no schema. O teste de drift garante que todo modelo do arquivo do Core está classificado.
13. **Fila de propostas.** A restrição vale também pelo contato **atual** da conversa (que pode ter sido religada depois da geração), numa única consulta à porta para a página inteira.
14. **Lead score.** Restrito não grava run: é uma leitura, feita a cada visualização do contato, e um run por visualização poluiria o histórico de custo. A coleta de sinais lê dados do contato, mas só dentro do processo; nada sai para o provedor.
15. **Trilha da limpeza.** `expireContentFor` lê o workspace do contexto, e não de parâmetro, e audita a contagem de resultados anulados (`ai_run.results_expired`, sem ids nem conteúdo).
16. **Catálogo no banco.** O texto original do E2 dizia que "o seed de permissões usa o catálogo composto". A implementação ficou mais restrita: nenhuma rotina do Core grava chave de extensão na tabela `Permission`. Registrar as chaves do vertical (exigidas pela FK `RolePermission → Permission`) é responsabilidade da CLI de ativação da F1.b.

**Condições para compor a primeira porta (F1.b), além da pendência abaixo:**

- **Contato da emissão.** Gravar no evento do outbox o contato da **emissão**, em coluna e fora do payload, e conferir emissão ∪ entrega. Hoje deal e tarefa são resolvidos pelo vínculo no momento da entrega: um deal desligado do paciente entre emitir e entregar sairia. Isso exige migration no Core e fica para a F1.b.
- **Retenção de payloads expirados.** Payloads de propostas não pendentes continuam guardados, embora ocultos na leitura. Isso entra no plano de exclusão LGPD (ADR-048 §9).

**Pendência para a F1.b, que precisa de decisão antes da primeira migration do vertical.** O Prisma exige o **lado oposto** de toda relação, e um modelo não pode ser dividido entre arquivos. Uma FK `ClinicsPatient → Contact` declarada no Prisma obriga o arquivo de schema do Core a ter, no `Contact`, uma linha de relação nomeando `ClinicsPatient`. A alternativa, FK composta só no SQL da migration e fora do schema, é exatamente o que o ADR-018 registrou como perdido: um `migrate dev` posterior a removeu. O código do Core continua sem conhecer o vertical, já que o registro composto já aceita esse acréscimo (`relationTargets` de modelo alheio, apontando só para dentro da extensão). Mas a linha no arquivo do Core é uma exceção visível ao §3.8 e precisa ser aceita, ou trocada por outra solução, antes da F1.b.

### Adendo 2 (2026-10-19) — decisões aprovadas para a F1.b

O plano da F1.b foi aprovado com as decisões abaixo. A entrega 1 (fotografia no outbox, item 6) está implementada; as demais valem para a entrega 2.

1. **Exceção no schema do Core: só o lado reverso de relação.** O Prisma exige o lado oposto de toda relação, e um modelo não se divide entre arquivos. Por isso o arquivo de schema do Core pode citar modelo do vertical **apenas** como tipo de campo de relação reverso (por exemplo, `clinicsContactReleases ClinicsContactRelease[]` em `Contact`). Nunca com `@relation(fields: …)`, porque a FK fica sempre do lado do vertical. Nunca como escalar, e nunca como enum. Na F1.b isso dá linhas em `Workspace`, `Contact` e `Membership`; cada modelo novo do vertical acrescenta as suas. Um teste varre o arquivo do Core e falha em qualquer outra forma. O código do Core continua sem importar lógica, rotas ou regras do vertical (lint e teste de fronteira).
2. **`ClinicsUnit` antecipado para a F1.b.** É só o schema; API e tela ficam na F1.c. O `clinics:enable` cria a unidade inicial, como manda o ciclo de vida do §4, sem precisar mexer depois num workspace já ativo.
3. **E5 (navegação no web) movido para a F1.c.** Ele entra junto da primeira tela real, o catálogo da clínica. O `GET /api/clinics/status` entra na F1.b.
4. **403 em vez de 404.** Os guards globais do Nest conferem a permissão antes do guard de ativação do vertical. Em workspace sem o Clinics nenhum papel tem chave `clinics:*` (o `disable` remove todas), então a resposta é **403**. O 404 do guard de ativação fica para o caso residual de chave presente em workspace desativado. Isso substitui o "404" das tabelas do §3 e do §4. Não houve perda de segurança, e um guard global faria o Core conhecer o vertical.
5. **Liberação de IA.**
   - Motivos de lista fechada: `supplier`, `partner`, `staff` e `non_clinical_business`, sem "outro" e sem texto livre.
   - Revogar **apaga a linha**; a prova fica na auditoria.
   - Se o nome "Profissional" já existir num papel não-sistema, a ativação **aborta** com mensagem clara, sem renomear em silêncio.
6. **Fotografia dos contatos no outbox (entrega 1, implementada).**
   - `OutboxEvent.subjectContactIds UUID[]`, anulável e **sem FK**: é registro histórico, e contato excluído depois não apaga nem bloqueia o evento.
   - Todo evento do catálogo de webhooks **declara** os contatos na emissão, na mesma transação; esquecer lança erro. Tarefa declara o contato dela e o do deal; deal declara o dele; contato declara a si mesmo. `contact.deleted` é emitido antes do delete.
   - Como não há FK, o **isolamento é conferido na emissão**: todo id precisa ser contato do mesmo workspace do evento, lido na mesma transação, com `workspaceId` explícito (vale no client protegido e em transação `raw`). Id de outro workspace, inexistente ou malformado derruba a transação de domínio inteira.
   - A entrega soma a fotografia à resolução do momento. NULL significa evento interno, anterior à coluna ou **terminal** (fotografia zerada), e nesses casos vale só a resolução. Reprocessar um evento terminal ficou proibido no banco (adendo 3, item 1).
   - Migration aditiva, gerada por `migrate diff` contra banco migrado do zero e aplicada com `migrate deploy`.
   - **Evento derivado herda os sujeitos do evento que o causou, por procedência.** A tarefa criada por automação herda a fotografia do evento disparador **somada** à resolução atual da entidade dele, lidas no mesmo workspace (`inheritSubjectsFrom`), sem revalidar a existência dos contatos. Eles já foram conferidos na emissão de origem, e revalidar faria a automação falhar sempre que o contato tivesse sido excluído no meio do caminho. Origem inexistente no workspace ou já concluída **lança**: herdar "nada" em silêncio liberaria justamente o conteúdo derivado. Sem a herança, uma automação em `deal.created` com `{{title}}` produziria um `task.created` sem contato, carregando o título do deal de um contato restrito.
   - **Raiz da cadeia na entrega.** Evento que nasceu de cadeia de automação (`chainId`) responde também pela entidade do evento **raiz**, resolvida no momento da entrega. Os títulos derivados vêm da raiz, e o vínculo dela com um contato pode surgir depois da emissão (deal criado sem contato e ligado a um contato restrito antes de a tarefa derivada ser entregue). A resolução por entidade é uma regra só, em `outbox/event-subjects.ts`, usada pela entrega e pela herança. Limite conhecido: a procedência fica no **evento**, não na tarefa. Um evento futuro sobre uma tarefa derivada, emitido fora da cadeia (por exemplo `task.completed`), precisará que a tarefa guarde a própria origem antes de ser emitido; isso está registrado como dívida com gatilho.
   - **Retenção (LGPD).** A fotografia é zerada (NULL) quando o evento chega a `delivered` ou `dead`, porque só tem uso enquanto o evento ainda pode ser entregue. O resíduo fica limitado ao tempo pendente (no pior caso, cerca de 13 h de backoff). O payload do outbox (por exemplo, o nome em `contact.created`) já não tinha retenção antes desta entrega, e isso fica registrado como dívida com gatilho.
   - **Tipagem.** O tipo do `enqueue` exige `subjectContactIds` em evento público e não o aceita em evento interno, de forma **não distributiva**: um emissor genérico, com o tipo da união inteira, também é cobrado. Evento novo que esquecer de declarar os contatos não compila. A checagem em runtime continua, para quem burlar o tipo.
   - **`check:fk`.** A heurística passa a pegar colunas `*Ids`, e uma checagem de dados (`unnest`) recusa elemento da fotografia que aponte para contato de outro workspace.
   - **Migration.** Usa `lock_timeout` de 5 s: o `ADD COLUMN` só mexe em metadados, mas pede lock exclusivo na tabela mais escrita do sistema. Se estourar, o runbook (DEPLOY_STAGING §4) manda `prisma migrate resolve --rolled-back` antes de repetir.
   - **Exclusão e arquivamento concorrentes de contato.** Os dois travam a linha no início da transação e **releem** o estado antes de decidir a cota e a auditoria. Duas exclusões, ou um arquivamento e uma exclusão, viram operações seriais: a perdedora responde 404 ou age sobre o estado de agora, e a cota cai uma vez só. Antes, caía duas vezes.
   - **Contrato da porta para a entrega 2.** A fotografia leva à porta ids de contatos já excluídos. A porta real do Clinics trata "id sem linha de contato no workspace" como **restrito**, com teste.
7. **Permissões depois do registro global.** Quando a CLI de um vertical grava as chaves dele no catálogo `Permission`, provisionar um workspace novo ainda concede **zero** delas: o Owner recebe exatamente o template do Core. Na entrega 1 isso é provado com uma extensão de teste; na entrega 2, com a CLI real e as chaves `clinics:*`.

A aprovação não libera ativar o Clinics em staging nem usar dados reais: as hipóteses H1–H7 e os bloqueios B1–B4 continuam.

### Adendo 3 (2026-10-19) — entrega 2 da F1.b: o vertical composto, desativado por padrão

A entrega 2 compõe o Veyra Clinics no produto (`composition.ts` e `app.module.ts`). Ele fica **desativado em todo workspace** até alguém rodar a CLI, e nenhum workspace foi ativado em staging. Decisões tomadas ao implementar:

1. **Estados terminais do outbox são definitivos, no banco.** A fotografia é zerada em `delivered` e `dead` (adendo 2, item 6). Isso só é seguro se nada reabrir esses estados para uma nova entrega, porque um replay sem a fotografia entregaria sem a restrição de conteúdo. O código foi conferido:
   - o claim só pega `pending`, ou `processing` com lease vencido;
   - renovar, concluir e falhar exigem `processing` e o token dono;
   - a automação só anula `originAutomationId`;
   - não existe rota, script nem job de reenvio.

   O trigger `OutboxEvent_terminal_is_final` (migration `20261019210000`) transforma isso em garantia, que vale também para UPDATE manual: o banco recusa mudar o status de um evento terminal e recusa devolver fotografia a ele. Apagar continua permitido, para retenção. O trigger não alcança um INSERT manual que copie um evento (a cópia nasceria sem fotografia); o runbook proíbe isso (DEPLOY_STAGING §7.2). A migration usa `lock_timeout` de 5 s com `RESET` no fim, como a da fotografia (runbook P3009 em DEPLOY_STAGING §4). **Um reenvio manual futuro exige ADR** e precisa manter a fotografia até que reenviar não seja mais possível. Na prática, a fotografia passaria a ser zerada no fim desse prazo, e não em `delivered`. Os testes estão em `outbox/outbox-subjects.integration-spec.ts`.

2. **Schema do vertical**, em `prisma/schema/clinics.prisma`:
   - `ClinicsSettings`: uma linha por workspace, com status `active` ou `disabled`;
   - `ClinicsUnit`: só o schema; API e tela ficam na F1.c;
   - `ClinicsContactRelease`: `consumer` tem um único valor, `ai`, e o motivo é de lista fechada.

   As FKs são compostas. A FK para `Contact` usa CASCADE, de modo que a liberação de um contato excluído desaparece com ele. É uma exceção deliberada ao NO ACTION do ADR-048 §9.1: aquela regra protege o **perfil de paciente**, e a liberação diz o contrário (contato sem relação com o Clinics). Recusar a exclusão por causa dela só atrapalharia a LGPD, e a prova fica na auditoria, que registra o id do contato (item 5). A FK para `Membership` (quem liberou) usa NO ACTION. A migration só cria tabelas, mas o `ADD FOREIGN KEY` trava `Contact`, `Membership` e `Workspace`, e por isso ela também fixa `lock_timeout` de 5 s. O teste `prisma/core-schema-boundary.spec.ts` impõe o limite do item 1 do adendo 2.

3. **Ativação (E3).** `ClinicsActivationService` é chamado só pela CLI `clinics enable|disable --slug`. O corpo da CLI fica em `cli/clinics-command.ts`, coberto por teste de integração; o ponto de entrada só sobe o contexto e imprime. Tudo roda numa transação com prazo explícito de 15 s, com `raw` justificado e trava consultiva por workspace (namespace `clinics_activation`). A trava é **tentada** (`pg_try_advisory_xact_lock`), não esperada: duas execuções simultâneas no mesmo workspace são acidente de operação, e a segunda recusa sem efeito, com mensagem em português. Esperar a trava contaria no prazo da transação, e a CLI morreria com um erro interno do Prisma, em inglês.
   - **`enable`:**
     1. registra as sete chaves no catálogo global;
     2. cria o papel `Profissional` pelo `systemKey`. Se o nome já pertence a um papel que não é de sistema, a ativação aborta e nada muda, nem o catálogo;
     3. concede a matriz por `systemKey` e incrementa o `tokenVersion` das memberships dos papéis afetados. O token de acesso emitido antes recebe 401, e o refresh emite outro com as permissões atuais;
     4. cria `ClinicsSettings` e a unidade inicial, ou reativa a linha existente, e audita. `activatedAt` registra a ativação **vigente**, e o histórico completo fica na auditoria. A data é sempre gravada pelo relógio da aplicação, o mesmo de `disabledAt`;
     5. depois do commit, expira o conteúdo de IA do workspace. Se essa limpeza falhar, a falha é relatada, e a leitura já oculta esse conteúdo.

     Com o vertical já ativo, nada muda, inclusive um ajuste manual de permissão feito pelo admin.

   - **`disable`:** remove **toda** chave `clinics:*` de **todo** papel, de sistema ou customizado, invalida da mesma forma os tokens de quem as tinha e marca `disabled`. Não apaga dado nem `ClinicsSettings`, e o `Profissional` fica só com `workspace:read`.
   - Testes estáticos garantem que só esse serviço escreve `RolePermission` no vertical e que nada no vertical apaga `ClinicsSettings`.
4. **Porta real do E6.** `ClinicsContentRestriction` roda no client protegido, no CLS do workspace consultado.
   - **Presença:** `ClinicsSettings` em qualquer status, **ou** qualquer linha de qualquer modelo de `CLINICS_MODELS`. É a mesma lista do registro, e um teste a confere contra o schema.
   - **Sem presença:** nada é restrito.
   - **Com presença:**
     - todo consumidor que não seja `ai` é sempre restrito. É uma allowlist: um consumidor novo do Core nasce restrito, sem herdar a liberação de IA;
     - `ai` é restrito, salvo liberação vigente **com** o Clinics ativo;
     - `null` e id sem contato no workspace são restritos.
   - **Erro de leitura:** a porta rejeita em vez de responder "liberado", e o Core trata a rejeição como indisponível.

   Duas mutações da porta foram feitas de propósito e pegas pelos testes de regressão: filtrar a presença por status (5 falhas) e deixar a liberação de IA valer para webhook (9 falhas).

   **Limite aceito: duas leituras sem snapshot.** A porta lê a ativação e depois as liberações, em comandos separados. Um `disable` entre as duas não cria "liberado" indevido, porque o resultado equivale a ler tudo no instante da primeira leitura: o `disable` não apaga liberação, e uma revogação nesse meio só torna o resultado mais restrito. O único caso anômalo exige uma **concessão** gravada no exato intervalo entre o guard de ativação e um `disable` concorrente. É um ato humano explícito sobre aquele contato, e o efeito máximo é uma checagem, porque as seguintes já leem `disabled`. Fechar isso exigiria trava compartilhada entre concessão e ativação, ou snapshot em toda checagem do sistema; nenhuma das duas compensa agora.

5. **API.**
   - `GET /api/clinics/status` usa `@AuthenticatedOnly` e devolve só um booleano sobre o workspace da sessão.
   - `GET /api/clinics/ai-releases` e `POST|DELETE /api/clinics/contacts/:id/ai-release` exigem `clinics:restriction:manage`; conceder e revogar exigem também `contacts:read`. As três rotas passam pelo `ClinicsActiveGuard`, que dá o 404 residual.
   - Conceder de novo devolve a liberação existente, com o motivo original.
   - O corpo é estrito: um `consumer` no corpo dá 400.
   - Revogar apaga a linha, audita e expira o conteúdo de IA daquele contato. Se a expiração falhar depois do commit, a falha é relatada e a resposta continua 200; repetir daria 404 para uma revogação já feita.
   - A auditoria registra o **fato e os ids**: `contactId`, consumidor e motivo, na concessão e na revogação. Sem o id, a revogação ou a exclusão do contato (que apagam a linha) deixariam a trilha sem titular. Nada do contato entra.
   - Duas concessões simultâneas para o mesmo contato, ou o contato excluído entre a leitura e a gravação, dão 409 pelo filtro global de P2002/P2003.
   - A listagem tem teto de 500 sem paginação. Está registrada como dívida, com gatilho na tela de liberação (F2).
6. **Critério do item 7 do adendo 2, provado com a CLI.** O teste roda o corpo da CLI num contexto montado como a CLI o monta e registra as chaves. Depois provisiona um workspace novo pelo `ProvisioningService` e verifica:
   - nenhuma chave `clinics:*` concedida;
   - Owner com exatamente o template do Core;
   - `/api/auth/me` sem chave do vertical;
   - 403 nas rotas do vertical.

   Só depois do `enable` naquele workspace as chaves aparecem. Na validação manual, a mesma cadeia rodou com os binários compilados (`dist/cli/provision.js` e `dist/verticals/clinics/cli/clinics.js`) contra o banco de teste.

7. **Reconferência no fan-out de webhook (mudança no Core, sem nome de vertical).** A porta era consultada uma vez antes de um fan-out que pode levar cerca de 100 s. Agora é consultada de novo antes de cada destino além do primeiro: um contato que fica restrito no meio não sai para os destinos restantes, cumprindo o §4 ("o que estava em voo não sai"). Porta indisponível no meio devolve o evento ao outbox sem penalizar nenhum webhook. Os testes estão em `extensions/content-restriction.integration-spec.ts`. Limite conhecido: a lista de contatos do evento é calculada uma vez, no início. Um deal **sem** contato que ganha contato no meio do fan-out continua saindo para os destinos restantes, porque sem contato não há o que reconferir. O payload foi fotografado na emissão e não traz dado de contato, e deal sem contato já sai pelo §6.5 do ADR-048. O teste de fronteira também ganhou uma regra: arquivo do Core não usa delegate do Prisma de modelo de vertical (`.clinicsSettings.`). Acesso por colchete não é pego; a barreira principal continua sendo o lint de import.
8. **Consequência de disponibilidade.** Com uma extensão composta, a porta é consultada em toda entrega de webhook, inclusive de workspace sem o Clinics. Uma indisponibilidade longa da porta (na prática, do banco) consome tentativas e pode levar eventos a `dead`, o que agora é definitivo. É disponibilidade, não sigilo: nada sai indevidamente.
9. **Fica para a F2**, porque depende de `ClinicsPatient`: a liberação perder efeito quando o contato vira paciente (§6.3, item 6, do ADR-048), com o teste correspondente do §6.6.

O Clinics continua desativado em staging. Ativá-lo lá, ou usar dados reais, segue bloqueado pelas hipóteses H1–H7 e pelos bloqueios B1–B4.

### Adendo 4 (2026-10-19) — E5: a porta de navegação no web

A F1.c, entrega 2, implementa o E5 com a forma abaixo.

1. **Contribuições por contexto, preenchido pela raiz.** O `lib/nav.ts` do Core mantém `NAV_GROUPS` e ganha um provider de contribuições e o hook `useNavGroups()`, que junta o Core com o que a raiz entregar. A barra lateral, o rastro do cabeçalho e a busca global leem o hook. Não há registro global mutável: o Core não importa vertical, e um teste monta o shell com qualquer composição.
2. **A raiz é `apps/web/src/composition.tsx`**, a única do web liberada no lint e no teste de fronteira. Ela lista os verticais. Cada um contribui um **hook** que devolve seus grupos de navegação e as **rotas** dele. O `App.tsx` importa só `./composition`, monta o provider e as rotas dentro do shell protegido. A lista é fixa por build, e os hooks dos verticais são chamados sempre na mesma ordem.
3. **Visibilidade derivada do status e da permissão.** Uma entrada de vertical só aparece quando o status do vertical confirma "ativo" **e** a pessoa tem a permissão da seção. Enquanto o status carrega, ou se ele falhar, a entrada fica oculta e nenhuma consulta do vertical sai. Esconder é usabilidade; quem garante o acesso é o servidor (403 sem a chave).
4. **Rota acessada direto com o vertical inativo** mostra uma mensagem de indisponível, sem consultar dados. Enquanto o status carrega, mostra só o carregamento; se ele falhar, mostra o erro. Uma falha de **recarga** do status também esconde o vertical (falha fechada), mesmo depois de uma confirmação anterior. É deliberado: é o critério aprovado, e o custo é perder um formulário não salvo numa rede instável.
5. **Notas.** A estabilidade do hook vindo do contexto depende de convenção (a raiz entrega uma função de módulo) e dos testes de navegação; o projeto não usa `eslint-plugin-react-hooks`. O `vite.config.ts` cita o subpath de contratos do vertical em `optimizeDeps`: é configuração de build, não import de código, e a barreira de lint não o alcança. As rotas de vertical têm prefixo próprio e não podem coincidir com uma seção do Core (teste em `composition.test.ts`).

### Adendo 5 (2026-10-19) — E6: mudança de restrição e aprovação serializadas pela linha do contato

Condição aprovada na revisão do plano da F2 (ADR-048, adendo 2, item 2). **Se uma mudança POR CONTATO que torna um contato restrito comitar, nenhuma aprovação concorrente pode converter uma proposta daquele contato em mensagem ou tarefa.** Reconferir a porta antes da transação não basta: entre a checagem e o claim, a mudança pode comitar. Mudanças que valem para o workspace inteiro (ativar e desativar o vertical) usam trava consultiva por workspace e **não** se serializam com aprovações; ver item 7.

1. **Primitiva do Core: `lockContactsForRestriction(tx, workspaceId, contactIds)`** (`src/contacts/`). Ela trava, dentro da transação do chamador, a linha de cada contato, em ordem de id para não haver deadlock. O `workspaceId` vai explícito no filtro, porque o tipo da transação é o mesmo para o client protegido e o `raw`. Usa o mesmo mecanismo de `ContactsService.lockAndRead` e ignora `null` e contato que não existe mais (a porta trata id desconhecido como restrito). É uma função pura do domínio de contatos, sem injeção de dependência, para que o Core e as extensões a usem sem ciclo de módulos.
2. **Regra do contrato do E6 para extensões:** toda escrita que **muda a restrição** de um contato (no Clinics: criar paciente, conceder e revogar liberação) **trava a linha do contato** com essa primitiva antes de escrever, na mesma transação.
3. **Aprovação no Core:** `executeSendMessage` e `executeCreateTask` recebem uma **guarda** com os contatos da proposta e uma função de reconferência. Dentro da transação, **antes do claim**, o repositório trava os contatos e chama a reconferência, que consulta a porta. Se a resposta for "restrito" ou "indisponível", nada é executado. A aprovação responde como hoje (400 e proposta expirada, ou 503 sem expirar), e a reserva de envio é liberada. A checagem rápida antes da transação continua, porque evita trabalho, mas a garantia vem da reconferência sob trava.
4. **Ordem resultante:**
   - **mudança comitada primeiro:** a aprovação esperava a trava, reconfere depois do commit e recusa;
   - **aprovação travada primeiro:** ela termina inteira antes da mudança, numa ordem serial legítima, e o despacho de mensagem da IA reconfere a porta antes de enviar.
5. **Custo aceito:**
   - a trava atualiza o `updatedAt` do contato, como já fazem a exclusão e o arquivamento concorrentes;
   - aprovações de propostas do mesmo contato passam a ser seriais;
   - **a reconferência usa outra conexão do pool** enquanto a transação da aprovação segura a sua. Uma rajada de aprovações simultâneas que esgote o pool (10 conexões por instância, por padrão) só termina pelo timeout da porta (3 s, resposta 503) ou da transação (5 s). A falha é fechada: nada é executado nem expirado. Fica como dívida com gatilho. A correção, que é a porta ler pela própria transação, muda o contrato do E6 e pede adendo próprio.
6. **Prova:** teste determinístico com uma conexão que segura a linha do contato e insere a mudança de restrição na mesma transação. A aprovação, de mensagem e de tarefa, fica comprovadamente bloqueada e recusa depois do commit, sem mensagem, tarefa nem despacho. Uma mutação que remova a trava da aprovação derruba o teste.
7. **Limites conhecidos, fora desta garantia:**
   - **(a) Geração nova:** o gateway confere a porta e chama o provedor sem trava. Uma mudança que comite durante esse único `await` deixa sair o pedido já autorizado. Uma trava não pode atravessar uma chamada de LLM, que leva segundos. O resultado fica oculto na leitura e é recusado na aprovação, mas pode sobrar sem expirar até a próxima limpeza.
   - **(b) Mudanças do workspace inteiro:** ativar e desativar não travam contatos. Uma aprovação de tarefa concorrente pode comitar depois. A mensagem é barrada no despacho e o webhook na entrega, mas a tarefa nasce.
   - **(c) Despacho de mensagem da IA:** reconfere só o contato **atual** da conversa. Se a conversa for religada a outro contato liberado entre a aprovação e o despacho, a mensagem sai. É anterior a este adendo e exige religação.
   - Os três estão registrados como dívida. O plano para fechá-los, com a fronteira da garantia, está no adendo 6 (proposto).

### Adendo 6 (2026-10-19, PROPOSTO — em revisão; não autoriza código) — fronteira da garantia: nenhum uso externo começa depois de uma mudança de restrição

**Situação:** proposta para revisão. A revisão de 2026-10-19 **não levantou o B2**, por causa dos limites do item 7 do adendo 5. Pediu que esses casos sejam fechados com garantia e testes antes de o B2 voltar para decisão. O B2 só volta para decisão depois de três coisas: este adendo aprovado e implementado, a bateria completa verde e os passes de `security` e `reviewer`. Até lá, o Clinics fica desativado em staging e sem dados reais.

#### 1. O que a revisão pediu, e o que o inventário mostrou

A revisão pediu:

- **a fronteira da garantia:** uma mudança de restrição não pode comitar enquanto uma operação externa autorizada ainda puder começar. Timeout ou lease vencido, sozinhos, não provam que uma chamada externa incerta terminou;
- **o tratamento de timeout e de retentativas;**
- **a ordem das travas:** primeiro o workspace, depois os contatos, em ordem estável;
- **o destino da reserva** quando o desfecho é incerto.

O inventário do código (2026-10-19) mostrou o seguinte:

- **Usos externos de conteúdo de contato.** São três: a chamada ao provedor de IA, o envio de mensagem de autoria da IA (WhatsApp) e a entrega de webhook.
  - Os três **conferem a porta e depois chamam a rede sem nenhuma trava**. O despacho da mensagem da IA tem quatro passos entre a checagem e o envio. A entrega de webhook lê entregas anteriores e renova o lease antes do primeiro POST.
- **Fora do escopo do E6.** A mensagem escrita por pessoa (a clínica fala com o paciente), a varredura de arquivos no ClamAV (infraestrutura própria, não um consumidor) e o download de mídia da Meta (entrada).
- **SDK da IA.** É criado com os padrões: timeout de 600 s e `maxRetries = 2`. Cada retentativa reenvia o prompt inteiro **sem reconferir a porta**, e o pior caso passa de 30 min.
- **Timeouts da Meta e do webhook.** São de **socket ocioso** (15 s e 5 s), não prazos absolutos, e a resolução de DNS do webhook não tem prazo nenhum.
- **Reserva da IA.** O resultado do `settle` é ignorado. Uma chamada mais longa que o TTL da reserva (10 min) termina sem cobrança, porque a varredura já devolveu o valor.
- **Religar conversa.** Não existe: o `contactId` da conversa só é gravado na criação, pelo contrato e pelo serviço. O limite (c) do adendo 5 não é alcançável hoje (item 9).
- **Mudanças sem trava de contato.** A troca de contato de deal ou de tarefa não trava contato nem emite evento. A exclusão de contato usa `lockAndRead`. Ativar e desativar usam só uma trava consultiva **tentada** por workspace.
- **Pool.** Há um único pool do Prisma (10 conexões, sem prazo para obter conexão). As transações interativas expiram em 5 s por padrão. Não existe `idle_in_transaction_session_timeout` nem keepalive configurado.

#### 2. A fronteira da garantia (enunciado)

> **G.** Seja M uma escrita que torna o conteúdo de um contato C restrito para um consumidor, ou que muda a qual contato um conteúdo pertence (lista no item 6). Se M comita no instante t, nenhuma operação externa que carregue conteúdo de C para esse consumidor **começa** depois de t.

- **"Começar"** é o processo iniciar a requisição de rede. Cada retentativa é uma operação nova, que começa de novo.
- **Operações começadas antes de t** podem terminar depois. O resultado delas é tratado como conteúdo restrito: fica oculto na leitura, é expirado, não vira ação, e o desfecho incerto **nunca** é retentado.
- **Consequência direta:** M não pode comitar enquanto existir uma operação **autorizada** que ainda possa começar. A prova disso **não usa prazo**. Usa uma trava de banco mantida por uma **sessão viva** durante toda a janela em que a operação pode começar, e M precisa da trava em modo conflitante.

#### 3. Mecanismo: uso externo sob trava (`ContentUseGuard`, Core)

**3.1. Travas consultivas de restrição, separadas das travas de linha.** O adendo 5 travava a linha do contato com `updateMany` de `updatedAt`. Para usos que duram segundos, isso bloquearia edições comuns do contato e reescreveria o `updatedAt` a cada leitura da IA. A proposta é trocar esse mecanismo por **travas consultivas de chave única de 64 bits**. Esse espaço de chaves não colide com as travas existentes, que usam duas chaves de 32 bits. São duas famílias:

- **workspace:** `hashtextextended('veyra.restriction.ws:' || workspaceId, 0)`;
- **contato:** `hashtextextended('veyra.restriction.contact:' || contactId, 0)`.

Uma colisão de hash só causa espera a mais, nunca liberação indevida. A primitiva `lockContactsForRestriction` passa a pegar essas travas em vez de tocar a linha. Ela é a única peça do Core com SQL próprio para isso, registrada como exceção ao §3.3 com a justificativa "coordenação de restrição".

**3.2. Ordem global das travas (sem exceção):**

1. Trava de restrição do **workspace**: compartilhada para usos, aprovações e mudanças por contato; **exclusiva** para mudanças do workspace inteiro.
2. Travas de restrição dos **contatos**, em **ordem crescente de id**, sem repetição: compartilhadas para usos e aprovações, exclusivas para mudanças.
3. Travas de **entidade** que determinam a quem um conteúdo pertence (deal e tarefa, item 6), em ordem crescente de id.
4. Linhas próprias da operação (proposta, dispatch, evento do outbox).

Nenhum caminho pega um nível depois de um nível posterior. A trava tentada de ativação (`clinics_activation`) fica **antes** do nível 1, porque é exclusão mútua entre CLIs.

Os lotes que hoje travam contatos fora de ordem (`companies.service.ts`, remoção de empresa) passam a travar em ordem de id. Isso paga a dívida registrada.

**3.3. Sessões de guarda num pool próprio.** Um uso segura a trava durante a chamada externa. Para não disputar o pool do Prisma, a guarda usa um **pool dedicado** (`pg`, `application_name = veyra-guard`), com tamanho configurável (padrão 5) e keepalive TCP ligado. Cada sessão de guarda:

1. `BEGIN`.
2. `SET LOCAL idle_in_transaction_session_timeout = 0` (a sessão fica ociosa em transação durante a chamada, e um padrão do servidor não pode derrubá-la no meio) e `SET LOCAL lock_timeout = '5s'`.
3. Pega as travas compartilhadas dos níveis 1 a 3, na ordem.
4. **Reconfere a porta.** É uma consulta nova, feita depois das travas, que enxerga qualquer mudança já comitada.
5. Faz uma **prova de vida** da própria sessão (`SELECT 1` nela): as travas existem neste instante.
6. **Inicia a operação externa**, sem I/O entre a prova de vida e o início.
7. Espera o desfecho dentro do prazo absoluto (item 4).
8. **Persiste o resultado ainda sob a trava**: run, proposta, desfecho do dispatch ou da entrega.
9. `COMMIT`, que solta as travas.

**Fronteira de módulos.** A IA usa a guarda por uma porta, `run(escopo, operação)`. A operação é a chamada ao provedor mais a persistência do resultado. O módulo `intelligence` continua sem tocar o Prisma, e a guarda fica no Core, ao lado da porta do E6.

**3.4. Por que isso fecha G.** Uma mudança M precisa da trava exclusiva do contato (ou do workspace), que conflita com a compartilhada do uso.

- **Uso autorizado antes de M:** M espera o uso soltar. Quando ele solta, já começou, terminou ou foi abortado, e o resultado está persistido. Então M comita, e a expiração depois do commit alcança esse resultado. Isso elimina o resíduo do limite (a).
- **Uso que tenta começar depois de M pegar a trava:** espera, reconfere depois do commit de M e é recusado.

O prazo nunca entra na prova: só a trava, mantida pela sessão viva.

**3.5. O único caso que a trava não cobre: a sessão de guarda morrer.** Se a sessão morrer, o Postgres solta as travas; isso acontece com reinício do banco ou conexão derrubada.

- **Prevenção:** a prova de vida (passo 5) fica imediatamente antes do início. Para M comitar indevidamente, a sessão teria de morrer, e M pegar a trava e comitar, dentro do intervalo, sem I/O, entre a resposta da prova de vida e o início da requisição.
- **Detecção garantida:** se o `COMMIT` da guarda falhar, o uso é marcado `guard_lost`:
  - o resultado da IA é descartado (não é persistido) e a reserva é cobrada;
  - o desfecho do envio fica como está;
  - um evento de auditoria `content_use.guard_lost`, só com ids, abre o incidente.
- **A revisão decide** se aceita esse residual, com detecção garantida, ou se pede outra forma de prevenção.
- **Decisão da revisão (2026-10-20): residual NÃO aceito como prova de G.** Se a sessão morrer depois da prova de vida e antes do início da requisição, a mudança pode comitar primeiro e a chamada começar depois. Detectar no `COMMIT` não impede a chamada. **Decisão em aberto:** reforçar a garantia ou rever o critério com aprovação explícita. Até lá, o B2 continua fechado.

#### 4. Prazos e retentativas

**Prazo absoluto por operação, imposto por nós** (`AbortSignal` mais timer que destrói o socket), além do timeout do cliente:

| Operação                            | Prazo                                             | Retentativa automática dentro do uso |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------ |
| Chamada ao provedor de IA           | 60 s; SDK com `timeout: 60_000` e `maxRetries: 0` | nenhuma                              |
| Envio Meta (mensagem da IA)         | 20 s, incluindo conexão                           | nenhuma                              |
| Entrega de webhook, **por destino** | 10 s, incluindo DNS                               | nenhuma                              |

- **Retentativa é sempre um uso novo**, que pega as travas de novo e reconfere:
  - **IA:** a pessoa pede de novo;
  - **mensagem e webhook:** pelo outbox, como hoje.
- **Desfecho incerto:**
  - **IA:** nunca é retentado;
  - **mensagem:** fica `unknown_after_dispatch`, sem reenvio, como hoje;
  - **webhook:** a retentativa pelo outbox continua (entrega pelo menos uma vez; quem recebe deduplica pelo id do evento), e cada tentativa passa pela guarda.
- **Webhook com vários destinos:** cada destino é um uso próprio, com travas pegas e soltas por destino.
- **Uso esperando trava** (há uma mudança em andamento): `lock_timeout` de 5 s. A operação **não começa**, e cada caminho responde como hoje à porta indisponível:
  - **IA:** 503, reserva devolvida;
  - **mensagem:** `failed_before_send` e nova tentativa;
  - **webhook:** `markFailed`.
- **Mudança esperando usos:**

  | Mudança                                                                                                   | `lock_timeout` | Transação interativa | Ao estourar                                                                      |
  | --------------------------------------------------------------------------------------------------------- | -------------- | -------------------- | -------------------------------------------------------------------------------- |
  | Interativa por contato (paciente, conceder, revogar, excluir contato, trocar o contato de deal ou tarefa) | 10 s           | 30 s                 | 409 "uso em andamento para este contato; tente de novo em instantes", sem efeito |
  | Ativar e desativar (CLI)                                                                                  | 90 s           | 120 s                | 409 na CLI, sem efeito                                                           |

  O filtro global passa a converter `55P03` (`lock_not_available`) em 409.

#### 5. Reserva e desfecho incerto

**Antes de começar:** recusa na reconferência, porta indisponível, guarda sem conexão disponível, trava não obtida ou prova de vida falha. Nada começou:

- a **reserva volta inteira**;
- a proposta continua pendente (503) ou é expirada (restrito).

**Começou e terminou com resposta:** cobra o consumo real, como hoje.

**Começou e ficou incerto** (prazo estourado, conexão caída, erro depois do início, ou `guard_lost`):

- **a reserva fica e é cobrada pelo teto**: na IA, o `ai_runs` e o custo máximo reservado; na mensagem, a quota do envio;
- nunca é retentado;
- o run ou o dispatch registra `unknown_after_dispatch`.

**Reserva expurgada antes do acerto.** O `settle` da IA passa a conferir o retorno. Se a reserva já foi expurgada, cobra pelo caminho de consumo acima do teto, como o `chargeOne` do envio. Com o prazo de 60 s, isso só acontece se a persistência travar, mas a regra não pode depender disso.

#### 6. Escritas que entram no protocolo de mudança

**Mudanças por contato.** Pegam a trava do workspace compartilhada e as dos contatos exclusivas:

- criar paciente;
- revogar liberação;
- conceder liberação;
- **excluir contato**, porque depois do commit nenhum uso do conteúdo apagado começa;
- **trocar o contato de deal ou de tarefa**. Esta pega também a trava de entidade do deal ou da tarefa, porque muda a quem o conteúdo pertence para o webhook.

Conceder liberação **reduz** a restrição. Entra no protocolo pela ordem das travas, não pela garantia.

**Mudanças do workspace inteiro.** Ativar e desativar pegam a trava do workspace **exclusiva**:

- esperam os usos e as aprovações em andamento no workspace;
- a desativação passa a expirar o conteúdo de IA do workspace depois do commit, como a ativação já faz.

**Aprovações** (limite (b)). `executeSendMessage` e `executeCreateTask`:

- pegam a trava do workspace compartilhada e as dos contatos compartilhadas, no lugar da trava de linha do adendo 5;
- reconferem a porta sob as travas, como hoje.

Uma aprovação concorrente com a ativação espera, reconfere e recusa: a tarefa não nasce. Aprovações do mesmo contato deixam de ser seriais entre si; o claim da proposta continua impedindo dupla execução.

#### 7. O que cada uso trava

| Uso                              | Nível 1   | Nível 2                                            | Nível 3                                      |
| -------------------------------- | --------- | -------------------------------------------------- | -------------------------------------------- |
| Chamada à IA                     | workspace | contatos do escopo                                 | —                                            |
| Envio de mensagem da IA          | workspace | contato da conversa                                | —                                            |
| Entrega de webhook (por destino) | workspace | contatos (fotografia ∪ resolução atual, como hoje) | deal ou tarefa do evento e da raiz da cadeia |

O envio de mensagem da IA guarda os passos 3.3.3 a 3.3.9 em volta do envio. Os passos de política, consentimento e reserva continuam antes da guarda.

#### 8. Custos aceitos

- **Uma sessão do pool de guarda por operação externa em andamento.** Com o pool cheio, a operação espera (no máximo 5 s) e depois segue o caminho de "não começou". O tamanho do pool limita as operações externas simultâneas **por instância**; é um parâmetro operacional.
- **Uma mudança por contato pode esperar** até o fim de uma geração de IA em andamento (no máximo 60 s mais a persistência). Na prática, espera até 10 s e responde 409 para tentar de novo.
- **Ativar e desativar** esperam os usos do workspace inteiro.
- **Duas a quatro consultas a mais por operação externa**, numa transação curta fora do pool principal.
- **Fim do custo do adendo 5:** o `updatedAt` do contato deixa de ser reescrito pelas travas.

#### 9. Religar conversa (limite (c))

Hoje a religação não existe, e o limite (c) não é alcançável. Em vez de gravar uma fotografia de contatos no despacho, a proposta é:

- **um teste estático** que fixa a imutabilidade do `contactId` da conversa, no contrato e no serviço;
- **uma regra no contrato do E6:** quem criar religação faz dela uma mudança deste protocolo, com os contatos antigo e novo nas travas de contato e a conversa como entidade.

**Alternativa**, se a revisão preferir defesa em profundidade: gravar os contatos da aprovação no `MessageDispatch` (migration aditiva, validada como a fotografia do outbox) e reconferir todos eles no envio.

#### 10. Testes (todos determinísticos, com dados fictícios)

Para cada uso (IA, mensagem da IA e webhook) e para cada mudança (paciente, revogar, excluir contato, trocar o contato de deal, ativar e desativar), os testes cobrem estes cenários:

1. **Uso primeiro.** O transporte falso segura a chamada em andamento. O teste comprova que a mudança está bloqueada (`esperarBloqueadosPor`). Ao soltar a chamada, o resultado é persistido, a mudança comita e a expiração alcança o resultado.
2. **Mudança primeiro.** Uma conexão externa segura a trava exclusiva. O uso fica comprovadamente bloqueado, e o transporte não é chamado. Depois do commit, o uso recusa sem chamar o transporte.
3. **Sessão de guarda morta antes da prova de vida.** O teste mata a sessão (`pg_terminate_backend`) por um ponto de teste. O uso não começa, responde 503 e devolve a reserva.
4. **Sessão de guarda morta durante a chamada.** O `COMMIT` falha, o caso vira `guard_lost` com auditoria, e a reserva é cobrada.
5. **Prazo estourado.** Desfecho incerto, reserva cobrada pelo teto, sem retentativa. A trava é solta, e a mudança que esperava comita.
6. **Pool de guarda esgotado.** O uso não começa (503 ou nova tentativa), sem chamar o transporte.
7. **Aprovação contra ativação.** A ativação primeiro faz a tarefa não nascer. A aprovação primeiro faz a ativação esperar.
8. **Webhook contra troca de contato do deal**, com a mesma bateria.
9. **Ordem das travas:**
   - um teste estático garante que toda aquisição passa por uma única primitiva ordenada;
   - um cenário com mudança por contato, ativação, aprovação e uso concorrentes termina sem deadlock.
10. **Mutações:**
    - sem a trava no uso, os testes do cenário 2 caem;
    - sem a prova de vida, cai o cenário 3;
    - persistindo o resultado fora da trava, cai a expiração do cenário 1;
    - com retentativa do SDK ligada, cai o cenário 5;
    - sem conferir o `settle`, cai o teste da reserva expurgada.
11. **SDK:** um teste fixa as opções do client da IA: prazo e `maxRetries: 0`.

#### 11. Alternativas consideradas

- **Lease com prazo e espera pelo vencimento.** Rejeitada: o vencimento não prova que a chamada terminou nem impede que ela comece, que é a exigência da revisão.
- **Trava de linha do contato nos usos** (o mecanismo do adendo 5). Rejeitada: bloquearia edições do contato durante cada geração e reescreveria o `updatedAt` em toda leitura da IA.
- **Expirar depois e aceitar o risco.** Rejeitada pela revisão para o B2.
- **Fila única de operações externas por workspace.** Rejeitada: serializa o workspace inteiro sem necessidade.

#### 12. Decisões para a revisão

1. Aceitar o residual do item 3.5 (sessão de guarda morta no intervalo sem I/O), com detecção garantida e incidente auditado.
2. Prazos: 60 s para a IA (sem retentativa do SDK), 20 s para a Meta e 10 s por destino de webhook. Tamanho do pool de guarda: 5.
3. Mudanças interativas: esperar até 10 s e responder 409, em vez de esperar o fim da geração.
4. Religação de conversa: regra mais teste estático (recomendado), ou fotografia no dispatch.
5. A troca de contato de deal ou de tarefa entra no protocolo como mudança de pertencimento.

**Decisões da revisão (2026-10-20).** O adendo **continua proposto**, e isto não autoriza implementar nem levantar o B2.

1. **Residual da sessão de guarda: NÃO aceito.** Fica como decisão em aberto (item 3.5). Antes de implementar, o plano precisa trazer uma garantia que impeça a chamada (não só que a detecte), ou um critério revisto para aprovação.
2. **Prazos: aprovados.** São absolutos: 60 s para a IA, 20 s para a Meta e 10 s por destino de webhook. As tentativas automáticas do SDK ficam desligadas, e cada nova tentativa passa pela guarda de novo.
3. **Espera: aprovada.** Mudanças interativas por contato esperam até 10 s e respondem 409, sem efeito colateral quando o prazo estoura. A CLI de ativar e desativar espera até 90 s.
4. **Religação de conversa: aprovada a regra.** O vínculo continua imutável, fixado por teste. Se a religação surgir, ela entra no protocolo e protege o contato antigo, o novo e a conversa.
5. **Troca de contato de deal ou tarefa: aprovada como mudança de titularidade do conteúdo.** Protege os contatos antigo e novo e a entidade, na ordem de travas do item 3.2.

## ADR-048 — Veyra Clinics para estética: domínio próprio, classificação de dados e escopo do MVP

**Status:** aceito · **Data:** 2026-10-19 · Aprovação da F0 (documental): aprova o desenho e as decisões marcadas como aprovadas, não código nem migrations. **Seguem pendentes:** validação operacional das hipóteses H1–H7, avaliação jurídica (§9.2) e bloqueios B1–B4 — sem eles, nenhum dado real de paciente e nenhum piloto clínico

### Contexto

O ADR-036 definiu o Clinics como o primeiro vertical, sem prontuário, com tese comercial (`lead → WhatsApp → agendamento → confirmação → consulta → retorno/reativação`) e três métricas: faltas, conversão e pacientes recuperados. O primeiro público passa a ser **clínicas de estética no Brasil, começando com uma unidade**.

**Nenhuma validação com a operação real de uma clínica foi feita até a data deste ADR.** O product owner revisa o fluxo do produto, mas essa revisão **não conta como validação operacional**: sem alguém de uma clínica revisando, as hipóteses abaixo continuam **explicitamente não validadas**.

Duas linhas do `PRODUCT_BRIEF §5` original são revistas aqui: "agenda clínica = especialização da agenda do Core" e "profissional = extensão de `Membership`/`User`".

### Hipóteses

| #   | Hipótese                                                                                              | Revisão de produto (PO) | Validação com operação | O que muda se for falsa                                             |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------- | ------------------------------------------------------------------- |
| H1  | O fluxo é: agendamento → confirmação → chegada → procedimento → retorno, além de cancelamento e falta | pendente                | **não validada**       | Estados do agendamento e da tela da recepção                        |
| H2  | Pacotes de sessões são parte central da venda                                                         | pendente                | **não validada**       | `ClinicsPackage` sai do MVP ou muda de forma                        |
| H3  | Retorno tem intervalo previsível por serviço                                                          | pendente                | **não validada**       | Retorno vira tarefa manual, sem cálculo                             |
| H4  | Serviço tem duração fixa e exige um profissional habilitado                                           | pendente                | **não validada**       | Agenda por slot livre ou duração variável                           |
| H5  | Conflito de **sala** é uma dor real                                                                   | pendente                | **não validada**       | Decide se `ClinicsRoom` entra (D2)                                  |
| H6  | Faltas, conversão e pacientes recuperados são as métricas que a clínica acompanha e compraria         | pendente                | **não validada**       | Critério de sucesso do piloto (ADR-036) precisa ser revisto         |
| H7  | O MVP não precisa de prontuário, prescrição, pagamento online, fotos nem texto clínico livre          | pendente                | **não validada**       | Se falsa, aciona as condições do §7 antes de qualquer implementação |

A coluna "Revisão de produto (PO)" passa a "feita" quando o PO revisar. A coluna "Validação com operação" só muda com a revisão de alguém de uma clínica, registrada com data e papel de quem revisou.

### Alternativas consideradas

- **Agendamento como especialização de `CalendarEvent`** (extension table 1:1 sobre o evento). Descartada: impedir sobreposição exige uma regra de exclusão sobre o intervalo **na mesma tabela** que guarda o horário, e o Postgres não aplica `EXCLUDE` entre tabelas. Os horários ficariam duplicados (com risco de divergência) ou a regra iria para o service (com risco de corrida). Além disso, `CalendarEvent` tem título e descrição livres, um convite a texto clínico.
- **Profissional como extensão de `User`.** Descartada: `User` é global (ADR-003), e prender dado de uma clínica à identidade global quebra o modelo de tenant. Também não serve para profissional sem login.
- **Tudo em custom fields do Core.** Descartada: agenda, pacote e consumo de sessão têm invariantes (sobreposição, saldo, consumo único) que o banco precisa garantir, e custom fields herdam as permissões do contato, não permissões próprias.
- **Agenda e atendimento numa tabela só, sob a mesma permissão.** Descartada: quem agenda (recepção) não precisa ver o que aconteceu no atendimento.
- **Restrição só para pacientes.** Descartada (D4): um lead que ainda não é paciente pode falar do procedimento pelo WhatsApp, e essa conversa iria para a IA.
- **Restrição por marcação positiva** (só é restrito quem foi marcado como "do Clinics"). Descartada: um caminho de entrada esquecido (por exemplo, contato criado na tela do Core que depois conversa pelo número da clínica) deixaria conteúdo de saúde passar. A regra adotada é a inversa: **restrito por padrão, liberado por exceção** (§6.4).

### Decisão

**1. Tese e métricas.** A tese comercial do ADR-036 se mantém, com as métricas tratadas como H6. O critério de sucesso do MVP é: a equipe cadastra um paciente e um serviço, agenda com o profissional certo, registra o atendimento e acompanha sessões e retorno, com permissões adequadas e sem planilha. Com dados reais do piloto, que dependem dos bloqueios do §10, as três métricas precisam ser **apuráveis**.

**2. Agenda própria.** `ClinicsAppointment` é dono do próprio intervalo de tempo e **não depende de `CalendarEvent`**. A sobreposição é impedida pelo banco: `EXCLUDE USING gist` por profissional e, se `ClinicsRoom` entrar, por sala, valendo só para estados ativos (`btree_gist`, disponível no Postgres 17 do projeto). A interface pode reaproveitar componentes visuais da agenda do Core. A página "Agenda" do Core não mostra atendimentos da clínica, e isso é consequência aceita.

**3. Profissional sem login.** `ClinicsProfessional` é entidade do vertical, com `membershipId` **opcional** ligado por FK composta `(workspaceId, membershipId) → Membership(workspaceId, id)` e no máximo um profissional por membership. Registro em conselho não entra no MVP: em estética nem todo profissional tem conselho, e isso fica condicionado à validação. O cadastro `ClinicsProfessional` (quem atende na agenda) e o papel `Profissional` (o que uma conta pode fazer, §5) são coisas diferentes: um profissional sem login não tem papel.

**4. Modelos.** Todos com `workspaceId`, `@@unique([workspaceId, id])`, FKs compostas e índices liderados por `workspaceId`. A coluna "Classe" segue o §6.

| Modelo                                                                     | Conteúdo                                                                                                                                                                                                                                       | Classe |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `ClinicsSettings`                                                          | 1:1 com o workspace: estado da ativação (ADR-047 §4)                                                                                                                                                                                           | C      |
| `ClinicsUnit`                                                              | Nasce com uma linha. As demais tabelas já referenciam `unitId`; multiunidade não tem interface no MVP                                                                                                                                          | C      |
| `ClinicsService`                                                           | Nome, `durationMin`, `priceCents` + `currency` (possibilidade preservada, §8), intervalo de retorno opcional (H3), se exige sala (H5)                                                                                                          | C      |
| `ClinicsRoom`                                                              | **Em aberto (D2)**                                                                                                                                                                                                                             | C      |
| `ClinicsProfessional`, `ClinicsProfessionalService`, `ClinicsWorkingHours` | Quem atende, quais serviços pode fazer e quando atende                                                                                                                                                                                         | P      |
| `ClinicsContactRelease`                                                    | Liberação explícita de um contato **sem relação com o Clinics**, **por consumidor** (§6.4): `(workspaceId, contactId, consumer)` único, com quem liberou, quando e o motivo, por **lista fechada**. No MVP o único consumidor liberável é `ai` | P      |
| `ClinicsPatient`                                                           | 1:1 sobre `Contact` com FK composta. Só campos operacionais mínimos; nada clínico                                                                                                                                                              | **S**  |
| `ClinicsAppointment`                                                       | Paciente, profissional, serviço, unidade, sala?, intervalo, status de **agenda** (`scheduled/confirmed/arrived/canceled/no_show/attended`), motivo de cancelamento por **lista fechada**                                                       | **S**  |
| `ClinicsAttendance`                                                        | 1:1 com o agendamento `attended`: quem executou, quando foi concluído e qual sessão de pacote foi consumida. É o **registro de atendimento**, separado da agenda                                                                               | **S**  |
| `ClinicsPackage`                                                           | Paciente, serviço, total de sessões, preço **congelado** em centavos (possibilidade, §8), `dealId` opcional (FK composta). Consumo de no máximo uma sessão por atendimento (unique); saldo derivado                                            | **S**  |

Equipamentos ficam fora. Retornos e follow-ups usam `Task` do Core, com título **neutro** (sem nome de serviço ou procedimento), ligada ao contato.

**5. Permissões e papéis.**

**5.1 Sete chaves.** A sétima, `clinics:restriction:manage`, entra por causa da liberação de contatos decidida na D4. A agenda e o atendimento são separados de propósito: **ter permissão de agenda não dá acesso a dados de atendimento.**

| Chave                        | Protege                                                                                                                                                                 | Dados           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `clinics:catalog:read`       | Ver unidades, serviços (com duração e preço), profissionais, serviços habilitados e horários                                                                            | C, P            |
| `clinics:catalog:manage`     | Criar, editar e arquivar unidades, serviços, preços, profissionais, serviços habilitados e horários                                                                     | C, P            |
| `clinics:schedule:read`      | Ver a agenda (paciente, profissional, serviço, horário, status de agenda) e o perfil operacional do paciente. **Não** inclui registro de atendimento, pacote nem saldo  | S — agenda      |
| `clinics:schedule:write`     | Criar o perfil de paciente sobre um contato; agendar, remarcar, confirmar, cancelar; registrar chegada e falta                                                          | S — agenda      |
| `clinics:care:read`          | Ver registros de atendimento, pacotes (sessões, saldo, preço) e o histórico de continuidade e retornos do paciente                                                      | S — atendimento |
| `clinics:care:write`         | Registrar o atendimento realizado (`attended` + `ClinicsAttendance`), consumir sessão, criar e encerrar pacote, gerar retorno                                           | S — atendimento |
| `clinics:restriction:manage` | Liberar um contato **para uso de IA** como sem relação com o Clinics, ou desfazer a liberação (§6.4). **Não** libera webhooks: esse consumidor não tem liberação no MVP | P               |

As rotas que precisam de mais de uma família declaram todas, como faz o ADR-044: registrar atendimento exige `clinics:care:write` **e** `clinics:schedule:read`. A resposta da agenda **omite no servidor** o vínculo com atendimento e pacote para quem não tem `clinics:care:read` (autorização de campo, SECURITY §4).

**5.2 Matriz de concessão**, aplicada **somente** por `clinics:enable` e **somente** em workspace com o Clinics ativado (ADR-047, E2 e §4):

| Papel                                                          | Chaves do Clinics                                                                                                                                                                                 | Chaves do Core                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Owner                                                          | as sete                                                                                                                                                                                           | inalteradas                                                                                                                                                                                                                                                                    |
| Admin                                                          | as sete                                                                                                                                                                                           | inalteradas                                                                                                                                                                                                                                                                    |
| Member (**recepção**)                                          | `catalog:read`, `schedule:read`, `schedule:write`. **Sem atendimento e sem liberação de contatos**                                                                                                | inalteradas                                                                                                                                                                                                                                                                    |
| Guest                                                          | nenhuma                                                                                                                                                                                           | inalteradas                                                                                                                                                                                                                                                                    |
| **`Profissional`** (novo, `systemKey: 'clinics:professional'`) | `catalog:read`, `schedule:read`, `care:read`, `care:write`: **consulta a agenda e registra atendimento**. **Sem** escrita de agenda (marcar e remarcar é da recepção) e sem liberação de contatos | **somente `workspace:read`**. Sem `contacts:read`, `tasks:read` nem `conversations:read`: o profissional vê o paciente pela agenda do Clinics e não pelo CRM, e notas e conversas do Core (onde pode haver texto clínico digitado por pessoas, §6.6) ficam fora do seu alcance |

**5.3 O papel `Profissional`, com as ferramentas de hoje.**

- É **criado na ativação** (`clinics:enable`), de forma idempotente: localizado por `systemKey` e nunca recriado.
- **Alcance: todos os atendimentos e pacotes do workspace, não só os próprios.** `clinics:care:read` não distingue profissional. O Core não tem restrição por dono do registro, e restringir cada profissional aos próprios atendimentos é uma **decisão operacional pendente (D8)** que, se for necessária, exige um mecanismo novo com ADR próprio. Até lá, quem recebe o papel vê o atendimento de todos os pacientes da clínica.
- **Sem escrita de agenda (decidido para o MVP).** O profissional consulta a agenda e registra atendimentos; marcar e remarcar é da recepção. `clinics:schedule:write` não distingue o dono do horário, então dá-la ao profissional permitiria alterar a agenda **da clínica inteira**. A decisão é reaberta se a operação validar a necessidade, e nesse caso vem junto com o mecanismo de dono do registro da D8.
- É **papel de sistema** (`isSystem: true`). **Não é editável nem removível pelo produto**, porque o Core **não tem hoje API nem tela para editar papéis ou suas permissões**. Mudar a matriz no futuro é mudança do vertical, com ADR e atualização aplicada pela CLI.
- **Atribuir** o papel a uma pessoa usa o que a API já tem: convite com `roleId` (`POST /invites`) e troca de papel (`PATCH /members/:id/role`), sujeitos à regra do Core de que ninguém concede o que não tem. **Nenhum desses fluxos tem tela no web hoje.**

**5.4 Limites que a criação do papel NÃO resolve (D7 e B4).**

- **Um papel por membro (D7).** `Membership.roleId` é único: quem é recepção e também atende não tem um papel que cubra as duas funções. Sem edição de papéis no Core, esse papel não pode ser criado.
- **Sem gestão de equipe no web (B4).** Convites e troca de papel só existem pela API.
- **Premissa para F1–F3:** Member cobre a **recepção** (agenda, sem atendimento) e `Profissional` cobre **consulta à agenda e atendimento**. As duas limitações acima seguem como **dependências explícitas para um piloto com equipe**.
- **D7 é reaberta antes da F4** se qualquer função precisar combinar o Clinics com permissões do CRM ou do Inbox do Core. O caso mais provável é o profissional que conversa com o paciente pelo WhatsApp: `Profissional` não tem `conversations:*`.

**6. Classificação de dados.**

**6.1 As três classes:**

| Classe               | Significado                                                                                                                                               | Exemplos no Clinics                                                                                                                                     | Controles esperados                                                                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C** — Configuração | Estrutura e catálogo da clínica. **Não identifica pessoa**                                                                                                | Unidade, serviço (nome, duração, preço, intervalo de retorno), sala, estado de ativação                                                                 | Isolamento por workspace e FK composta; leitura por `clinics:catalog:read` e escrita por `clinics:catalog:manage`; auditoria com allowlist ampla (o valor do campo pode constar). Sem restrição adicional de exportação |
| **P** — Pessoal      | Identifica uma pessoa, mas **não a liga a saúde**                                                                                                         | Profissional (nome, vínculo com membership, serviços habilitados, horários); liberação de contato. No Core, o contato em si (nome, telefone) também é P | Tudo de C, mais: minimização (só o necessário para operar); auditoria registra o fato e os ids, com valores pessoais como `"[changed]"`; exclusão e exportação pelas regras do Core (ADR-022, SECURITY §9)              |
| **S** — Sensível     | Liga uma pessoa identificável a **serviço, procedimento, atendimento ou continuidade de tratamento**. É dado de saúde (LGPD art. 11) mesmo sem prontuário | Perfil de paciente, agendamento (quem + qual serviço + quando), registro de atendimento, pacote e saldo, vínculo de retorno                             | Ver §6.2                                                                                                                                                                                                                |

Na dúvida entre duas classes, vale a mais restrita.

**6.2 Controles da classe S:**

1. **Modelos e permissões próprios.** Dado S só existe em tabelas do vertical, sob as chaves do §5. Nunca em entidade do Core.
2. **O vertical nunca escreve conteúdo S em entidade do Core.** Título de tarefa de retorno, título de deal, nota, mensagem, payload de notificação e `Activity` não carregam nome de serviço, procedimento nem estado de atendimento. Isso é verificado por teste.
3. **Auditoria** com allowlist de ids, status, horários e motivo de cancelamento (lista fechada). Nunca texto livre.
4. **Sem texto livre e sem arquivo** nas entidades S do MVP (§7).
5. **Fora de webhooks, timeline do Core e IA**, pela fronteira do §6.3.
6. **Visibilidade:** quem tem a permissão vê a clínica inteira, inclusive o papel `Profissional` (§5.3). Restringir o profissional aos próprios atendimentos exige um mecanismo de dono do registro que o Core não tem (D8).
7. **Exclusão e retenção:** pendentes (§9). **Nada de exclusão ou anonimização de S é implementado antes da decisão jurídica.**

**6.3 Fronteira técnica entre o Clinics e o Core.** Implementada pelo E6 do ADR-047 e pelos controles acima. Cada ponto de checagem consulta a restrição **para o seu consumidor** (§6.4):

**Consumidor `ai`: toda a superfície de IA, e não só aprovação e envio.**

1. **Antes de qualquer envio ao provedor.** A checagem fica no **ponto único por onde toda chamada ao provedor passa** (o cliente de LLM), e não em cada capacidade. Toda chamada declara os contatos cujo conteúdo carrega, e a chamada sem essa declaração é recusada. Assim, resumo, sugestão de resposta, próxima ação, explicação de lead score e qualquer capacidade futura são cobertos sem depender de quem a escreveu lembrar da regra. Contato restrito resulta em run recusado com motivo `content_restricted`, sem chamada ao provedor e sem reserva de quota.
2. **Ao montar o contexto.** As capacidades conferem a restrição também antes de ler conversas, mensagens, notas, tarefas, deals ou dados do contato. É a segunda camada; a primeira é o item 1.
3. **Ao ler conteúdo persistido.** Resultado de IA (`AiRun.result`: resumo no inbox, lead score, sinais) e proposta pendente (incluindo o rascunho de `send_message`) sobre contato restrito **não são devolvidos** por nenhum endpoint: a fila de propostas os omite, e o endpoint do alvo responde como se não houvesse resultado. Isso vale também para conteúdo gerado **antes** de a restrição existir.
4. **Ao aprovar uma proposta.** A aprovação reconfere e recusa, porque o contato pode ter ficado restrito entre gerar e aprovar.
5. **Ao despachar mensagem de autoria da IA.** O worker reconfere antes de chamar o provedor de mensagens. Mensagens escritas por pessoas não passam por essa checagem: a clínica continua conversando com os pacientes.
6. **Ao associar o contato a um paciente.** Na mesma transação que cria o `ClinicsPatient`, a liberação de IA daquele contato **deixa de valer** e as propostas pendentes dele são expiradas. A partir do commit, os itens 1 a 5 voltam a recusá-lo.
7. **Limpeza.** Resultados e propostas de contato restrito são expirados por uma operação do Core (útil também para LGPD), chamada pelo vertical. A limpeza é complementar: quem protege é a leitura do item 3, e a limpeza falhar não expõe nada.

**Consumidor `webhook`:** nenhum evento sobre contato do workspace com o Clinics chega a webhooks externos (§6.5).

**Dado clínico** tem modelos e permissões próprios (§6.2, itens 1 e 2).

**6.4 Quem é restrito — restrito por padrão, com controles separados por consumidor (D4, aprovada).** Num workspace **com o Clinics presente**, **todo contato é restrito para todos os consumidores**: leads, contatos vindos pelo WhatsApp, contatos criados nas telas do Core, os **existentes** no momento da ativação e os **futuros**. "Presente" significa existir `ClinicsSettings` em **qualquer status** ou qualquer dado do vertical no workspace, de modo que **desativar o Clinics não levanta a restrição** (ADR-047 §4, "Ciclo de vida da restrição"). A restrição é derivada a cada checagem, não gravada por contato, e por isso alcança os existentes sem backfill.

| Consumidor | Liberação no MVP                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai`       | Possível, contato a contato, como "sem relação com o Clinics": `ClinicsContactRelease(consumer: 'ai')`, por quem tem `clinics:restriction:manage` (Owner e Admin), com motivo de **lista fechada** e `AuditLog` |
| `webhook`  | **Nenhuma.** Contatos de um workspace com o Clinics não são enviados por webhooks. Uma exceção futura exige autorização própria, com ADR, chave e liberação separadas do consumidor `ai`                        |

Regras comuns:

- **Uma liberação para IA não libera webhooks**, nem o contrário. Cada consumidor consulta só a sua liberação.
- **A liberação perde efeito** quando o contato ganha perfil de paciente (§6.3, item 6). O vínculo clínico sempre vence.
- Liberar não apaga nada e pode ser desfeito; desfazer volta a restringir imediatamente.
- **Com o Clinics desativado, as liberações de IA ficam suspensas** e todo contato volta a ser restrito para IA. A restrição continua valendo para os dois consumidores.
- Só um workspace em que o Clinics **nunca esteve presente** não tem restrição: a IA e os webhooks funcionam como hoje.
- Erro ao avaliar a restrição equivale a "restrito".

**O que isso garante:** nenhum conteúdo de contato de um workspace com o Clinics chega à IA sem um ato humano **explícito, autorizado e auditado para esse consumidor**, e nenhum chega a webhooks. O que não se garante tecnicamente é que uma liberação de IA esteja certa: liberar por engano alguém que fala de saúde é erro humano, mitigado pela permissão restrita, pela trilha e pela reversão automática quando surge o perfil de paciente. Até um teste provar a regra (B2), ela não vale como garantia.

Consequência aceita: no MVP, a IA fica **indisponível para as conversas da clínica** (só contatos liberados para IA a usam), e **nenhum** contato do workspace sai por webhook.

**6.5 Webhooks e integrações existentes (aprovado).**

- Num workspace com o Clinics, eventos do Core sobre **qualquer contato** não são entregues a webhooks externos. Isso inclui `contact.created`, `contact.updated` e `contact.deleted`, além de eventos de deal e tarefa **ligados** a um contato. **A liberação de IA não altera isso.**
- A restrição é conferida **na entrega**, não só na emissão. Um evento emitido antes da ativação e ainda pendente no outbox também não sai.
- **Integrações já configuradas no workspace são afetadas.** Elas continuam ativas, mas deixam de receber todo evento ligado a contato. A CLI de ativação informa quantos webhooks ativos existem e avisa sobre esse efeito (ADR-047 §4).
- **O que continua saindo:** eventos de deal ou tarefa **sem contato**. Workspaces sem o Clinics não são afetados. Os consumidores internos (automações) não mudam.
- Resíduo, coberto pelo B1: deal ou tarefa **sem contato** cujo título livre tenha texto clínico digitado por alguém ainda sai por webhook.

**6.6 Testes exigidos da fronteira** (F1, com a porta do E6; repetidos na F2 com dados do vertical):

_Ativação_

- Contato criado **antes** da ativação fica restrito para `ai` e `webhook` assim que a ativação faz commit, sem backfill; o mesmo vale para contato criado depois.
- A consulta de presença falhando equivale a "restrito".

_Desativação e reativação_

- Depois de `clinics:disable`:
  - **cada** ponto de checagem de IA do §6.3 continua recusando, para contatos existentes e para contatos **criados depois da desativação**;
  - resultados e propostas persistidos continuam ocultos;
  - nenhum evento ligado a contato é entregue a webhook.
- Depois de `clinics:disable`, um contato que **estava liberado para IA** passa a ser recusado (liberação suspensa). Depois de `clinics:enable`, volta a ser aceito se a liberação não foi desfeita.
- A porta do E6 devolve "restrito" com `ClinicsSettings` em `disabled`. **Teste de regressão:** a implementação não pode filtrar por `status`.
- Com dados do vertical presentes e **sem** a linha `ClinicsSettings` (simulando remoção fora do produto), a porta continua devolvendo "restrito".
- Nenhum comando, rota ou job do vertical apaga `ClinicsSettings`.
- `enable` → `disable` → `enable` → `disable` repetidos nunca produzem uma janela em que um contato restrito chegue à IA ou a webhook.

_IA, em toda a superfície_

- **Cada** capacidade existente (resumo, sugestão de resposta, próxima ação, explicação de lead score) recusa contato restrito **sem chamar o provedor e sem reservar quota**.
- Chamada ao cliente de LLM **sem** a declaração de contatos é recusada. Isso garante que uma capacidade futura não escape da regra.
- Resultado persistido e proposta pendente de contato restrito **não são devolvidos** por nenhum endpoint de leitura, inclusive o que foi gerado antes da ativação.
- Aprovar proposta de contato que ficou restrito depois da geração é recusado.
- Mensagem de autoria da IA para contato restrito não é despachada; mensagem escrita por pessoa é despachada normalmente.
- Contato liberado para IA que ganha perfil de paciente volta a ser recusado em todos os pontos acima, e suas propostas pendentes ficam expiradas.

_Webhooks_

- Para **cada tipo** do catálogo de webhooks, nenhum evento ligado a contato de workspace com o Clinics é entregue, **inclusive de contato liberado para IA**.
- Evento pendente no outbox, emitido antes da ativação, não é entregue.
- Evento de deal ou tarefa sem contato continua sendo entregue.
- Num workspace sem o Clinics, todos os eventos são entregues como antes.

_Liberação e falha_

- A porta do E6 falhando produz o mesmo resultado que "restrito", para os dois consumidores.
- Liberação só com `clinics:restriction:manage`; motivo fora da lista é recusado; consumidor diferente de `ai` é recusado no MVP.
- Workspace sem o Clinics: IA e webhooks se comportam exatamente como antes (teste de não regressão).

**6.7 O que a fronteira técnica NÃO garante, e por isso bloqueia dados reais.** As superfícies genéricas do Core aceitam texto livre escrito por pessoas: notas, tarefas, conversas, tags e custom fields. Se a equipe escrever ali "alergia a…", o texto fica visível **com as permissões do Core** (por exemplo `tasks:read`), e não com as do Clinics. A fronteira tira esse texto da IA (salvo contato liberado para IA) e dos webhooks, mas **não da leitura interna**. O papel `Profissional` não tem essas permissões do Core, mas Member, Admin e Owner têm. Orientação na interface não é tratada como garantia. Isso é o **bloqueio B1 para uso de dados reais**, não um risco aceito. Caminhos para levantar o bloqueio, a decidir em ADR próprio:

- restrição de **leitura** por contato nas telas do Core, em que notas, tarefas e conversas de contato restrito exigem uma permissão adicional contribuída pelo vertical (extensão do E6, hoje fora do ADR-047);
- ou um modelo de anotação própria do vertical, com permissões próprias, que hoje cai na exclusão de texto clínico livre (§7).

**7. Fotos e texto clínico livre: fora do MVP, com condições para voltar.** Se a validação mostrar que são essenciais, nada é implementado antes de um ADR que responda:

- **Acesso:** quem vê o quê, se por papel ou por profissional responsável, e se exige o mecanismo de dono do registro (§6.2, item 6).
- **Proteção:** cifra na borda dos bytes (SECURITY §7.6, **hoje não implementada**: arquivos ficam em claro no disco); scanner ativo (ADR-043; desligado no staging pelo ADR-046); proibição de envio a canal externo.
- **Retenção e exclusão:** prazo legal mínimo, se houver, e como isso convive com a exclusão do titular (§9).
- **IA:** consentimento específico, separado do consentimento de conversa (ADR-028).
- **Consentimento do paciente** para fotos: forma, prova e revogação.

**8. Preço e pagamento.** O preço do serviço e o preço congelado do pacote, em centavos, ficam **preservados como possibilidade** do modelo. Isso não constitui módulo financeiro: não há razão contábil, recebível, valor parcial nem meio de pagamento. **Marcar "pago/em aberto" continua em aberto (D1)** até a revisão do fluxo. Se for aprovado, entra como um estado simples no pacote, com ADR curto.

**9. Exclusão e retenção de registros de atendimento.**

**9.1 Decidido para agora: recusa provisória (aprovada).** As FKs do vertical para `Contact` e `ClinicsPatient` usam `NO ACTION`. **Excluir um contato que tem perfil de paciente é recusado com 409.** É um desvio consciente do ADR-022, limitado a workspaces com o Clinics e aceitável **apenas com dados fictícios**. A recusa nunca pode virar silenciosamente uma exclusão. A resposta 409 diz que o contato tem registros clínicos sob política pendente, sem expor o conteúdo desses registros.

**9.2 Pendente de avaliação jurídica: a política definitiva.** **Nenhuma exclusão ou anonimização definitiva de atendimentos e pacotes é implementada antes da decisão.** As alternativas estão abaixo; a (b) é **apenas a proposta técnica**:

| Opção                                                                                                                                                                   | Efeito                                                                             | Problema                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| a) `CASCADE` em tudo                                                                                                                                                    | Exclusão total, simples                                                            | Apaga faltas e sessões da estatística; se houver obrigação legal de guarda, a viola                                                           |
| b) `ClinicsPatient` com `CASCADE`; `ClinicsAppointment`, `ClinicsAttendance` e `ClinicsPackage` com `ON DELETE SET NULL ("patientId")` (lista de colunas, Postgres 15+) | O histórico operacional fica, desvinculado da pessoa, como o ADR-022 faz com deals | Profissional, serviço e horário podem permitir reidentificação em clínica pequena; e se a guarda for obrigatória, desvincular pode não bastar |
| c) Manter a recusa (o provisório do §9.1)                                                                                                                               | Preserva tudo                                                                      | Contraria o ADR-022 de forma permanente e não atende ao pedido de exclusão do titular                                                         |
| d) Retenção restrita com base legal (LGPD art. 16, I)                                                                                                                   | Guarda o mínimo exigido, com acesso restrito, e exclui o resto                     | Exige mecanismo novo de retenção e um fluxo de exclusão que o Core hoje não tem                                                               |

**Perguntas para o jurídico:**

1. O registro de que um procedimento estético foi realizado (quem, quando, qual serviço) constitui prontuário ou documento de guarda obrigatória? Isso depende de quem executa (profissional de saúde regulamentado ou não) e do conselho aplicável.
2. Se sim, qual o prazo e qual o conteúdo mínimo?
3. Um pedido de exclusão do titular pode ser parcialmente recusado com base nessa obrigação?
4. A exclusão de um **workspace inteiro**, que no Core é cascade, pode apagar registros sob guarda obrigatória?
5. Como atender ao direito de acesso e exportação do titular sobre dados de classe S?

**Nota de implementação**, para quando houver decisão: o Prisma não expressa `SET NULL` com lista de colunas. A constraint precisaria de SQL manual na migration e de teste que a confirme. Um `SET NULL` sem lista sobre FK composta tentaria anular também o `workspaceId` (NOT NULL), e a exclusão falharia.

**10. Bloqueios para uso de dados reais.** Até que **todos** sejam levantados, staging, testes e qualquer outro ambiente usam **somente dados fictícios**.

| #   | Bloqueio                                                                                                                   | Como se levanta                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Texto clínico escrito por pessoas nas superfícies do Core fica legível com permissões do Core (§6.7)                       | ADR aprovado e implementado para restrição de leitura ou para anotação própria                                                                      |
| B2  | A regra "restrito por padrão" (§6.4) ainda não está implementada nem provada                                               | E6 e liberação implementados, com a bateria do §6.6 verde                                                                                           |
| B3  | Política definitiva de exclusão e retenção de registros S sem decisão (§9.2)                                               | Avaliação jurídica respondida e política implementada                                                                                               |
| B4  | Equipe não consegue ser montada pela interface (convite e troca de papel só por API), e cada membro tem um só papel (§5.4) | Telas de gestão de equipe no Core, e D7 decidida para os papéis que o piloto precisar. Não é condição de segurança, mas de operação real com equipe |

**11. Dependência da WABA.** A validação contra WABA real (`docs/WABA_VALIDATION.md`) **não bloqueia** a F0 nem as fases operacionais (F1–F3). Ela é dependência apenas da parte do fluxo comercial que **envia confirmações pelo WhatsApp** (F4).

### Consequências

- O vertical tem domínio próprio de verdade: agenda, atendimento e pacote não são registros genéricos do CRM, e as invariantes ficam no banco.
- Agenda e atendimento separados custam uma tabela e uma família de permissões a mais. Em troca, a recepção opera sem ver o que aconteceu no procedimento.
- Num workspace de clínica, a IA do Core fica indisponível para as conversas da clínica, e as integrações por webhook deixam de ver qualquer evento ligado a contato. É o preço da fronteira técnica, aceito na D4.
- O papel `Profissional` é rígido e amplo: não se edita, vê todos os atendimentos da clínica (D8), e quem acumula funções não tem papel adequado (D7). A rigidez vem do Core, que não tem edição de papéis nem restrição por dono do registro, e não do vertical.
- O MVP é deliberadamente pobre em texto. Se a clínica precisar anotar, a pressão vai aparecer, e a resposta é o §7 e o B1, não um campo livre improvisado.
- O caminho crítico para um piloto com dados reais são os bloqueios B1–B4, e não as fases de engenharia F1–F3.

### Decisões

**Aprovadas em 2026-10-19:**

- **D3:** matriz de permissões e papel padrão `Profissional`, criado na ativação (§5).
- **D4:** todo contato do workspace com o Clinics é restrito por padrão, com controles separados por consumidor: liberação só para IA, e nenhuma para webhooks no MVP (§6.4).
- Supressão de webhooks de contatos do workspace com o Clinics, inclusive para integrações existentes (§6.5).
- Recusa provisória de exclusão com 409. A anonimização segue só como proposta (§9).
- Sem dados reais enquanto B1–B4 estiverem abertos (§10).

**Em aberto:**

- **D1:** marcar "pago/em aberto" no pacote. Em aberto até a revisão do fluxo.
- **D2:** `ClinicsRoom`. Em aberto até a revisão do fluxo (H5).
- **D5:** política definitiva de exclusão e retenção (§9.2). Depende do jurídico.
- **D6:** validação operacional de H1–H7 com alguém de uma clínica. A revisão do PO não a substitui.
- **D7:** um papel por membro. Para F1–F3, Member é a recepção e `Profissional` cuida da consulta à agenda e do atendimento. É reaberta **antes da F4** se alguma função precisar combinar o Clinics com o CRM ou o Inbox (§5.4).
- **D8:** restringir o profissional aos próprios atendimentos. Hoje o papel vê todos (§5.3). É decisão operacional; se for necessária, exige mecanismo novo no Core com ADR.

### Adendo 1 (2026-10-19) — F1.c: catálogo da clínica

O plano da F1.c foi aprovado com as decisões abaixo. A entrega 1 traz contratos, schema e API; a entrega 2, a navegação (E5, adendo 4 do ADR-047) e a tela. O Clinics continua desativado em staging, e B1–B4 seguem valendo: só dados fictícios.

1. **Serviço (classe C).** Nome, duração em minutos (de 5 a 480, em passos de 5), preço **opcional** em centavos (`Int`) com moeda (`BRL` por padrão) e arquivamento. O preço é a possibilidade preservada do §8, sem nada financeiro. **Adiados**, porque prever coluna é pior que acrescentá-la quando houver uso: o intervalo de retorno (H3, usado só na F3) e o "exige sala" (D2 em aberto).
2. **Unidade (classe C).** Continua **uma por workspace**: a API não cria nem arquiva unidade. Edita nome e **fuso horário** (IANA, padrão `America/Sao_Paulo`), validado contra a lista do runtime. O fuso existe porque horário de atendimento é hora local da unidade, e o Core não tem fuso.
3. **Profissional (classe P).** Só o nome, por minimização: nada de telefone, documento ou conselho (§3). Vínculo **opcional** com uma conta, por FK composta para `Membership`, com no máximo um profissional por conta. Vincular exige `clinics:catalog:manage` **e** `members:read`, e só aceita conta **ativa**. Se o membro for removido depois, o vínculo fica e a resposta indica a conta como removida: o Core remove membership por status, não apaga a linha, e não avisa o vertical. Vincular **não muda papel**; o papel continua sendo atribuído pela API do Core (B4).
4. **Serviços habilitados.** Tabela de junção com FKs compostas para profissional e serviço. A edição **substitui o conjunto inteiro** numa transação, sob trava da linha do profissional.
5. **Horários semanais.** Cada intervalo tem profissional, unidade, dia ISO (1 = segunda, 7 = domingo) e início e fim em minutos do dia. Pode haver vários por dia. A edição substitui a semana inteira, sob a mesma trava.
   - **Sobreposição barrada pelo banco:** `EXCLUDE USING gist` por workspace, profissional e dia, sobre `int4range(início, fim)`, com `btree_gist`. Vale entre unidades: ninguém atende em dois lugares ao mesmo tempo. É o mesmo mecanismo da agenda da F2 (§2), provado aqui antes, numa tabela pequena.
   - **Spike no início da entrega:** a extensão `btree_gist` sob a migration, o convívio do `EXCLUDE` com o drift do Prisma e o erro que o Prisma devolve na violação (`23P01`). A violação responde **409, nunca 500**, com teste. Se o EXCLUDE não conviver com o Prisma, o fallback é validar no serviço sob a trava, também com 409, e o resultado fica registrado aqui.
   - Validação também no contrato: dia de 1 a 7, minutos de 0 a 1440, início antes do fim, sem sobreposição no próprio pedido.
6. **Arquivar, nunca apagar.** A agenda da F2 vai referenciar serviço e profissional. A API não tem DELETE para eles; arquivado some das listas por padrão (`includeArchived` para a tela de catálogo). As FKs entre tabelas do vertical usam `NO ACTION`; só a exclusão do workspace remove tudo, em cascata.
7. **API e permissões.** Leitura exige `clinics:catalog:read` (Owner, Admin, Member e Profissional, inclusive o preço, pela matriz do §5.2); escrita, `clinics:catalog:manage` (Owner e Admin). Sem a chave, a resposta é **403** pelo guard global, o que inclui todo workspace com o Clinics desativado. O `ClinicsActiveGuard` dá **404** só no caso residual de uma requisição que passa pelo guard de permissão e encontra o vertical desativado (adendo 2 do ADR-047, item 4).
8. **Auditoria por classe (§6.1).** Serviço e unidade têm allowlist ampla (nome, duração, preço, moeda, fuso, arquivamento). Profissional registra só ids, vínculo e arquivamento; o nome vira `[changed]`. Horários e serviços habilitados registram o fato e os ids (`intervalCount`, lista de serviços), nunca os horários em si. A chave da quantidade tem nome que não admite os horários: trocar o valor por eles exigiria mudar a allowlist.
9. **Integrar ou construir.** Nenhuma dependência nova: fusos pela lista do runtime (`Intl.supportedValuesOf('timeZone')`), editor de horários com os primitivos existentes. A escolha de biblioteca de agenda fica para a F2.

**Resultado do spike e decisões da implementação (entrega 1):**

10. **O `EXCLUDE` convive com o Prisma.** Com todas as migrations aplicadas do zero, o `migrate diff` contra o schema não acusa diferença: o Prisma ignora `EXCLUDE` e `CHECK`, e a extensão `btree_gist` (1.7) é criada pelo dono do banco. O intervalo é `[início, fim)`: 08h–12h seguido de 12h–13h é aceito. O fallback não foi necessário.
11. **A violação chega como P2039, e o filtro global a responde com 409.** Com o driver adapter, o Prisma não traduz `23P01`. Ele entrega um P2039 genérico, com o código original em `meta.driverAdapterError.cause.originalCode`. Sem mapeamento seria 500, como uma mutação do teste confirmou. O `PrismaExceptionFilter` do Core passou a responder 409 a `23P01`, numa regra universal sem nome de vertical (ARCHITECTURE §4). O `detail` do Postgres, com ids e valores, fica fora da resposta; o log registra só o código e o nome da constraint, porque hoje a violação só acontece por corrida ou defeito. A violação de `CHECK` (`23514`) continua 500 de propósito: o contrato valida as mesmas faixas, então ela só aconteceria por defeito, e um erro alto é o certo.
12. **Vincular conta tem rota própria** (`PUT /clinics/professionals/:id/account`), que exige `clinics:catalog:manage` **e** `members:read`. Renomear (`PATCH`) só trata do nome; criar e salvar o perfil levam nome, serviços e semana (item 23), nunca a conta. A autorização fica declarativa na rota (SECURITY §4), e cadastrar um nome não pede acesso à lista de membros. A resposta traz só o id da conta e se ela continua ativa: nome e e-mail da pessoa vêm da API de membros, para quem tem `members:read`.
13. **Toda substituição trava a linha do profissional antes de escrever** (conta, serviços e semana), no mesmo padrão de `ContactsService.lockAndRead`. Um teste prova isso de forma determinística: uma conexão externa segura a linha com `FOR NO KEY UPDATE`, que barra a trava do serviço mas não as checagens de FK, e cada substituição precisa ficar esperando. Remover a trava de qualquer um dos três métodos derruba o teste.
14. **Detalhes de contrato.** `includeArchived` só aceita `true` ou `false` (`z.coerce.boolean()` leria `"false"` como verdadeiro). PATCH parcial de serviço não tem defaults, então não zera o preço. Os serviços habilitados voltam ordenados por id, porque é um conjunto e os vínculos nascem no mesmo `createMany`. A unidade só tem `GET` e `PATCH`.

**Ajustes da revisão (reviewer e security):**

15. **Fuso canônico.** O fuso é canonizado pelo próprio runtime e precisa estar em `Intl.supportedValuesOf('timeZone')`, com até 64 caracteres. A **regra** é: canônico segundo o runtime **e** presente na lista dele. Caixa diferente vira o nome canônico (`america/sao_paulo` → `America/Sao_Paulo`). O destino de um alias depende da versão do ICU (no Node atual, `EST` → `America/Panama`), e por isso nenhum teste depende disso. A tela da entrega 2 parte da lista do navegador, que pode incluir `UTC` e `Etc/*`; ela precisa tratar o 400 do servidor, que é quem decide. Offsets (`+03:00`), zonas POSIX (`Etc/GMT+3`, que o Postgres lê com o sinal invertido) e `UTC` são recusados. Gravar só valor canônico protege a agenda da F2.
16. **Premissa dos horários: mesmo fuso entre unidades.** O `EXCLUDE` compara minutos locais. A regra "ninguém atende em dois lugares ao mesmo tempo" vale enquanto todas as unidades do workspace estiverem no mesmo fuso, o que é certo no MVP, com uma unidade só. Multiunidade com fusos diferentes exige revisar a regra, com ADR.
17. **Edição de serviço e de unidade trava a linha antes de ler o `before`.** Dois PATCH simultâneos viram seriais, e a trilha de cada um registra o valor que ele de fato substituiu.
18. **Vínculo de conta.** Repetir o mesmo vínculo não faz nada nem revalida a conta, que pode ter sido removida depois. Profissional arquivado **mantém** o vínculo e continua ocupando a conta: para vincular a conta a outro profissional, desfaça o vínculo antes.
19. **Corrida aceita.** Arquivar um serviço ao mesmo tempo em que ele é habilitado num profissional pode deixar esse vínculo com um serviço recém-arquivado, porque o arquivamento não conflita com a trava de chave da FK. Segue a regra do item 4: o vínculo sai na próxima substituição do conjunto.
20. **Dívidas com gatilho** (`docs/MEMORY/technical-debt.md`): as listagens do catálogo têm teto de 500 sem paginação, como a de liberações. A checagem de presença da porta E6 cresce com cada modelo do vertical: num workspace sem o Clinics, são sete consultas por checagem.

**Critérios da entrega 2 (navegação e tela), aprovados com o plano:**

21. **Nada do catálogo é consultado antes da confirmação.** Enquanto `GET /api/clinics/status` carrega, ou se falhar, a navegação do Clinics fica oculta. As consultas do catálogo só são habilitadas com o status "ativo" **e** a permissão `clinics:catalog:read` (adendo 4 do ADR-047, item 3).
22. **Vincular conta não muda papel nem concede permissão.** A tela diz isso no formulário do vínculo. O teste confere no servidor que papel, permissões e `tokenVersion` da conta vinculada não mudam e que a sessão dela continua válida, e confere na tela que o aviso aparece.
23. **O drawer do profissional salva tudo junto, numa transação.** Nome, serviços habilitados e horários vão num pedido só: `POST /clinics/professionals` ao criar e `PUT /clinics/professionals/:id/profile` ao editar. O servidor aplica tudo sob a trava da linha do profissional, ou nada; uma falha em qualquer parte desfaz as outras, com teste de rollback. O vínculo de conta continua como ação **separada**, porque exige outra permissão (`members:read`), e a tela deixa isso explícito. As rotas granulares (`services`, `working-hours`) continuam na API.
    - **`PUT .../profile` exige os três campos.** Ele substitui conjuntos, e um default faria um corpo só com o nome apagar serviços e semana sem erro. Os defaults ficam só na criação (`POST`). Salvar o mesmo perfil, em qualquer ordem, não altera dados nem audita (a trava toca só o `updatedAt`). Cada parte é substituída **só se mudou**: trocar o nome não revalida um conjunto de serviços intacto, que pode conter um serviço arquivado depois. A trilha registra só o que mudou, com os serviços ordenados nos dois lados.
    - **O editor só monta com serviços e unidades carregados** (achado P1 da revisão). Montado antes, os serviços marcados nasceriam de uma lista vazia, e "Salvar perfil" apagaria todos com a mensagem de sucesso. Os marcados partem do que o profissional tem; o filtro de arquivados acontece no envio, e a tela avisa quantos deixam de estar habilitados (item 19).
    - **Nome e e-mail de membros só aparecem com `members:read`**, mesmo que outra tela tenha deixado a lista no cache: a permissão decide se o dado é usado, não só se a consulta sai.

### Adendo 2 (2026-10-19) — plano da F2: paciente, agenda e atendimento (aprovado com condições)

**Situação: aprovado com condições (revisão de 2026-10-19).**

- **Aprovados:** a divisão F2.1–F2.3; o atendimento na F2; paciente sempre explícito; exclusão de contato de paciente recusada; grade simples; medição da porta de presença.
- **Aprovada só com prova de concorrência:** a expiração das propostas depois do commit (item 2).
- **Acrescentados pela revisão:**
  - duração registrada no agendamento;
  - tratamento de horários locais inexistentes ou ambíguos (item 4);
  - critério para levantar o B2 (tabela final).

O Clinics segue desativado em staging. Enquanto B1–B4 estiverem abertos, todos os testes usam **somente dados fictícios** (§10).

**Escopo.** A revisão pediu que a F2 cubra perfil de paciente, agenda, **atendimento** e a perda da liberação de IA quando o contato vira paciente. Por isso, o **registro de atendimento** sobe da F3 para a F2. Ficam na F3 os pacotes, o consumo de sessão, o retorno como `Task` e a apuração da taxa de faltas (H2, H3, H6, D1).

**Entregas propostas.** Cada entrega tem ADR antes do código, reviewer e security, bateria completa e parada para revisão.

- **F2.1:** paciente, a regra da liberação e a tela mínima de liberação para IA.
- **F2.2:** agenda e registro de atendimento, na API.
- **F2.3:** telas de agenda e de atendimento, mais o e2e.

#### Decisões propostas

1. **Perfil de paciente (`ClinicsPatient`, classe S).**
   - É 1:1 sobre `Contact`, com `@@unique([workspaceId, contactId])` e FK composta `NO ACTION`.
   - Só guarda o vínculo, quem criou e quando. Nada clínico e nenhum campo de texto (H7).
   - Nome e telefone continuam no contato.
   - Criar o perfil exige `clinics:schedule:write` + `contacts:read`.
   - Virar paciente é um **ato explícito**, com consequências mostradas na tela: restrição definitiva para IA e exclusão do contato recusada. **Recomendação:** o agendamento recebe um `patientId` já existente, e nunca cria paciente de passagem.
2. **A liberação de IA perde efeito ao virar paciente (§6.3, item 6).**
   - **Regra derivada na porta do E6:** a existência de `ClinicsPatient` para o contato torna-o restrito para IA, **com ou sem** liberação. É a garantia principal. Ela vale a partir do commit, e a leitura, a aprovação e o despacho já reconferem a porta.
   - **Na mesma transação que cria o paciente,** a linha da liberação é apagada e auditada (`clinics.ai_release.revoked_by_patient`, com o id do contato).
   - **Conceder liberação a um paciente** é recusado com 409.
   - **Expiração depois do commit, com garantia de concorrência (condição da revisão).** As propostas e os resultados são expirados **depois do commit** (`expireContentFor`), como na ativação e na revogação. A condição: **se a associação a paciente comitar, nenhuma aprovação concorrente pode converter a proposta em mensagem ou tarefa.** A garantia vem de **trava transacional**, não da limpeza:
     1. **Quem muda a restrição de um contato trava a linha do contato** antes de escrever, e o commit solta a trava. Isso vale para criar o paciente e também para conceder ou revogar liberação. A trava é a mesma de `ContactsService.lockAndRead`, exposta pelo Core como primitiva neutra.
     2. **A aprovação** (`executeSendMessage` e `executeCreateTask`) trava a linha de **cada contato** da proposta, em ordem de id para não haver deadlock, **dentro da sua transação e antes do claim**. Só então reconfere a porta. É uma mudança universal no Core, sem nome de vertical, com nova regra no contrato do E6 (adendo 5 do ADR-047, a escrever na F2.1).
     3. **Associação comitada primeiro:** a aprovação, que esperava a trava, reconfere depois do commit e vê o paciente. Ela recusa (400 "restrito") e marca a proposta como expirada. Nenhuma mensagem nem tarefa nasce.
     4. **Aprovação travada primeiro:** ela termina inteira **antes** da associação, numa ordem serial legítima. A mensagem que ela criou **não sai**, porque o despacho reconfere a porta (§6.3, item 5).
     5. **Prova determinística:** uma conexão de teste segura a linha do contato e insere o paciente na mesma transação. A aprovação é disparada e fica comprovadamente bloqueada (helper `esperarBloqueadosPor`). Depois do commit, a aprovação recusa, e não existe mensagem, tarefa nem despacho. O teste cobre os dois tipos de proposta. **Uma mutação que remova a trava da aprovação precisa derrubar o teste.**
     6. **Se a trava não puder ser garantida assim,** a expiração volta para a mesma transação da associação, como no texto original do §6.3, item 6, e isso é registrado aqui antes do código.
3. **Exclusão de contato com perfil de paciente: 409 (§9.1).**
   - A FK `NO ACTION` faz o `DELETE` do Core falhar no fim da transação de exclusão. O filtro global converte em 409, e **nada** da exclusão fica (notas, deals desvinculados, auditoria, outbox, cota), com teste.
   - A mensagem é a genérica do Core ("Registro em uso por outros dados"). Uma mensagem específica exigiria uma porta nova no Core, com ADR, e não compensa enquanto só há dados fictícios.
   - Nenhuma exclusão ou anonimização de dado S é implementada (B3).
4. **Agenda (`ClinicsAppointment`, classe S).**
   - **Campos:** paciente, profissional, serviço, unidade, `startsAt` e `endsAt` (`timestamptz`, UTC), status e motivo de cancelamento de **lista fechada**, quem criou, datas. Sem texto livre.
   - **Status (§4):** `scheduled`, `confirmed`, `arrived`, `canceled`, `no_show` e `attended`.
   - **Sobreposição barrada pelo banco:** `EXCLUDE USING gist` por workspace e profissional sobre `tstzrange(startsAt, endsAt)`, valendo só para os estados ativos (`scheduled`, `confirmed`, `arrived`, `attended`). É o mesmo mecanismo provado na F1.c. A violação responde 409 pelo filtro global.
   - **Duração registrada no agendamento (condição da revisão).**
     - `endsAt` é **gravado** no momento do agendamento, com `startsAt + durationMin` do serviço naquele instante (H4).
     - Mudar a duração do serviço depois **não altera** compromissos existentes. O teste muda a duração e confere os agendamentos antigos.
     - **Remarcar preserva a duração registrada** (`endsAt − startsAt`). Só trocar o **serviço** recalcula pela duração vigente do novo serviço.
     - O preço não é registrado no agendamento (sem financeiro, §8).
   - **Hora local, fuso e mudanças de horário (condição da revisão).**
     - **O instante é a verdade.** `startsAt` e `endsAt` são instantes (`timestamptz`); a hora local é só leitura, no fuso da **unidade**.
     - **Entrada:** a API recebe **data e hora locais da unidade** (`2026-11-02`, `08:30`) e converte com o fuso da unidade. A conversão usa a base de fusos do runtime, sem dependência nova.
     - **Hora local inexistente** (o "pulo" de uma mudança de horário): 400, "horário inexistente nesse dia por mudança de fuso". Nunca há ajuste silencioso.
     - **Hora local ambígua** (a hora que se repete): 400, pedindo o desambiguador `offset` (por exemplo `-03:00`). Com ele, o horário é aceito. A tela mostra as duas opções ("antes" e "depois da mudança").
     - **Expediente:** confere início e fim **locais** dentro do mesmo intervalo, no mesmo dia local. Um agendamento que atravessa a mudança e não cabe é recusado (400).
     - **Mudar o fuso da unidade** com agendamentos ativos futuros é **recusado (409)**. Mudar o fuso moveria a leitura local de compromissos já combinados.
     - **Atualização da base de fusos** (mudança de regra por governo): os instantes gravados não mudam, só a leitura local. Isso fica registrado como limite conhecido.
     - **Testes com fusos fictícios com mudança de horário** (por exemplo `America/New_York`): o pulo e a repetição, o expediente atravessando a mudança e a exibição. O Brasil não tem horário de verão desde 2019, mas a regra não pode depender disso.
   - **Regras validadas no serviço:**
     - profissional **habilitado** para o serviço;
     - profissional, serviço e unidade ativos;
     - horário **dentro do expediente** do profissional, na hora local da unidade. A conversão usa o fuso da unidade, sem dependência nova.
   - **Remarcar** reaplica as mesmas regras.
   - **Transições:**
     - `scheduled → confirmed → arrived`;
     - `canceled` e `no_show` a partir de `scheduled` ou `confirmed`;
     - `attended` **só** pelo registro de atendimento.
   - **Permissões:** marcar, remarcar, confirmar, cancelar, chegada e falta exigem `clinics:schedule:write` (recepção). Ler exige `clinics:schedule:read`.
   - **Paciente na agenda:** aparece só pelo nome. O papel `Profissional` vê o paciente pela agenda, não pelo CRM (§5.2).
5. **Registro de atendimento (`ClinicsAttendance`, classe S).**
   - É 1:1 com o agendamento (`appointmentId` único), com quem executou (profissional), quando foi concluído e quem registrou.
   - Exige `clinics:care:write` + `clinics:schedule:read`.
   - Na **mesma transação**, o agendamento vai a `attended`. Repetir ou registrar ao mesmo tempo resulta em exatamente um registro (unique mais trava).
   - O vínculo com pacote fica para a F3, com coluna anulável acrescentada lá.
   - **Na agenda:** a resposta **omite no servidor** o vínculo com atendimento para quem não tem `clinics:care:read` (autorização de campo, SECURITY §4).
6. **Tela mínima de liberação para IA** (pendência da F1).
   - Lista, concede com motivo de lista fechada e revoga. Exige `clinics:restriction:manage`.
   - Paciente aparece como "não liberável".
7. **Auditoria e fronteira.**
   - **Auditoria:** allowlists só com ids, status, horários e motivo de cancelamento (§6.2, item 3).
   - **Nada S sai do vertical:** nenhum conteúdo S em entidade do Core (`Task`, `Activity`, deal, nota, notificação), com teste estático e de integração. O vertical não publica eventos de outbox.
   - **Agenda do Core:** a página "Agenda" do Core não mostra os agendamentos da clínica, como já aceito no §2.
8. **Custo da checagem de presença (dívida com gatilho "antes da F2").**
   - A F2 leva a lista para dez modelos.
   - **Recomendação:**
     - rodar as consultas de presença **em paralelo** (`Promise.all`), mantendo o client protegido;
     - medir o p95 da porta antes e depois;
     - manter a dívida aberta.
   - Uma consulta única por SQL exigiria `raw` na porta, contra a regra atual, e precisaria de ADR.
9. **Telas (F2.3).** O ADR-048 adendo 1, item 9, adiou a escolha de biblioteca de agenda para a F2.
   - **Recomendação:** uma grade simples de **dia por profissional**, com os primitivos existentes. A visão de recursos do FullCalendar é paga; o `react-big-calendar` (MIT) traz localizador de datas e adaptação de estilo. Uma grade simples basta enquanto H1 não estiver validada. Reavaliamos com o piloto.
   - **Escopo:**
     - agenda do dia;
     - drawer para agendar (paciente, serviço, profissional habilitado, horário livre);
     - ações de status;
     - registro de atendimento para o papel `Profissional`;
     - lista de pacientes;
     - tela de liberação.
   - **Horários:** sempre na hora local da **unidade**, não do navegador.
   - **Filtro "minha agenda":** opcional, pelo profissional vinculado à conta. É só conveniência; não é restrição de acesso (D8).

#### Testes, todos com dados fictícios

- **Isolamento:** P0 em cada modelo novo, e FK composta recusando paciente, profissional, serviço ou unidade de outro workspace.
- **Concorrência:**
  - N agendamentos simultâneos no mesmo horário e profissional resultam em **exatamente um**; os outros recebem 409, nunca 500;
  - profissionais diferentes no mesmo horário convivem;
  - cancelar libera o horário;
  - remarcar para um horário ocupado dá 409.
- **Regras do agendamento:** profissional não habilitado, item arquivado e fora do expediente (na hora da unidade) dão 400. A duração vem do serviço. Transições inválidas são recusadas, e `attended` só sai pelo atendimento.
- **Atendimento:**
  - registro idempotente;
  - registro concorrente resulta em um só;
  - agendamento e atendimento na mesma transação, com rollback testado.
- **RBAC:**
  - recepção marca e lê a agenda, mas não lê atendimento, nem pela API (403), e a agenda omite o vínculo;
  - `Profissional` lê a agenda e registra atendimento, mas não marca (403) nem lê o CRM;
  - Guest não acessa nada;
  - 403 sem a chave, 404 só no caso residual.
- **Regra da liberação:**
  - contato liberado para IA vira paciente: no commit, a porta o restringe para IA, a linha da liberação some com trilha, e cada ponto de checagem da IA recusa (§6.3, itens 1 a 5);
  - propostas pendentes ficam ocultas na hora e expiradas depois do commit;
  - conceder liberação a um paciente dá 409;
  - a bateria do §6.6 roda de novo com dados do vertical.
- **Exclusão de contato com paciente:** 409, sem efeito colateral nenhum.
- **Fronteira:** nenhum conteúdo S em entidade do Core nem na auditoria; webhooks continuam sem eventos de contato.
- **E2E:**
  - a recepção agenda e vê o conflito recusado;
  - o `Profissional` registra o atendimento;
  - a recepção não vê o atendimento;
  - workspace sem o Clinics, nada aparece.

#### Decisões que dependem de validação (H1–H7) ou de bloqueio (B1–B4)

| Ponto do plano                                                                         | Depende de    | Enquanto não houver validação                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estados e transições da agenda; se o atendimento exige chegada antes                   | **H1**        | Os estados do §4; atendimento aceito a partir de `scheduled`, `confirmed` ou `arrived`                                                                                                                                             |
| Duração fixa pelo serviço; profissional habilitado obrigatório; expediente obrigatório | **H4**        | Como proposto; se H4 cair, a agenda passa a slot livre ou duração variável                                                                                                                                                         |
| Sala na agenda                                                                         | **H5 / D2**   | Sem sala; o EXCLUDE é só por profissional                                                                                                                                                                                          |
| Pacote, consumo de sessão, pago/em aberto                                              | **H2 / D1**   | Fora da F2 (F3)                                                                                                                                                                                                                    |
| Retorno calculado                                                                      | **H3**        | Fora da F2 (F3)                                                                                                                                                                                                                    |
| Faltas, conversão e recuperados como métricas                                          | **H6**        | A F2 registra `no_show`; a apuração fica na F3                                                                                                                                                                                     |
| Nenhum texto clínico, prontuário nem foto                                              | **H7** (e §7) | Nenhum campo livre em paciente, agenda ou atendimento                                                                                                                                                                              |
| `Profissional` vê todos os agendamentos e atendimentos                                 | **D8**        | Vê todos (§5.3); "minha agenda" é só filtro                                                                                                                                                                                        |
| Uma pessoa que é recepção **e** profissional                                           | **D7 / B4**   | Um papel por membro; o vínculo profissional–conta não muda papel                                                                                                                                                                   |
| Texto clínico escrito pela equipe em notas, tarefas e conversas do Core                | **B1**        | Continua bloqueando dados reais; a F2 não o resolve                                                                                                                                                                                |
| Regra "restrito por padrão" provada                                                    | **B2**        | **Só é levantado** depois da bateria do §6.6 verde também com pacientes, **da prova de concorrência do item 2** e dos **passes de `reviewer` e `security`** sobre essa entrega, com registro neste ADR. Testes passando não bastam |
| Exclusão e retenção de dado S                                                          | **B3 / D5**   | Só a recusa com 409; nenhuma exclusão nem anonimização                                                                                                                                                                             |
| Montar a equipe pela interface                                                         | **B4**        | Convites e troca de papel só pela API do Core                                                                                                                                                                                      |

**O que esta proposta não muda:**

- **Sem dados reais nem piloto clínico** enquanto B1–B4 estiverem abertos. A validação de H1–H7 com alguém de uma clínica continua pendente (D6); a revisão do PO não a substitui.
- **O Clinics continua desativado em staging.**

### Adendo 3 (2026-10-19) — F2.1: paciente, a regra da liberação e a tela de liberação

Implementa os itens 1, 2, 3, 6 e 8 do adendo 2. A condição de concorrência do item 2 foi cumprida **por trava**, como descreve o adendo 5 do ADR-047. A alternativa de expirar na mesma transação não foi necessária. Todos os testes usam dados fictícios.

1. **`ClinicsPatient` (classe S):**
   - campos `workspaceId`, `contactId`, `createdByMembershipId` e `createdAt`;
   - FKs compostas `NO ACTION` para `Contact` e `Membership`, e cascata a partir do `Workspace`;
   - nenhum campo de texto;
   - migration aditiva `20261020000000_clinics_patient`, com `lock_timeout`;
   - entra em `CLINICS_MODELS` e, portanto, na checagem de presença da porta.
2. **API do paciente** (atrás do `ClinicsActiveGuard`):
   - `POST /api/clinics/patients` exige `clinics:schedule:write` + `contacts:read`. É idempotente: repetir devolve o perfil existente, sem nova trilha. Contato inexistente ou de outro workspace dá 404.
   - `GET /api/clinics/patients` exige `clinics:schedule:read` e traz o nome do contato. O papel `Profissional` lê por aqui (§5.2: vê o paciente pela clínica, não pelo CRM).
   - O `contactId` sai **só para quem tem `contacts:read`**. O servidor omite o campo para os demais (autorização de campo, SECURITY §4). Sem essa chave, o filtro `contactIds` dá 403: sondar ids refaria o vínculo que a omissão esconde.
   - Filtro opcional `contactIds` (até 50 ids). A tela de liberação o usa para conferir só os resultados da busca, sem baixar a lista inteira, que é classe S.
   - O teto de 500 sem paginação é dívida; o gatilho é a tela de pacientes da F2.3.
   - Não há tela de paciente na F2.1: o perfil nasce só pela API.
3. **Criar paciente, numa transação só:**
   - trava a linha do contato;
   - cria o perfil e o audita (`clinics.patient.created`, `after: {contactId}`);
   - apaga cada liberação do contato e audita cada uma (`clinics.ai_release.revoked_by_patient`, `before: {contactId, consumer, reason}`).
   - Depois do commit, `expireContentFor` expira o conteúdo de IA do contato. É limpeza complementar: se falhar, só o nome do erro vai para o log.
4. **Porta do E6:** paciente é restrito para `ai` **com ou sem** liberação. Há teste com uma liberação inserida por fora do produto depois do paciente. Liberações e pacientes são lidos em paralelo.
5. **Liberação:**
   - conceder e revogar travam a linha do contato;
   - conceder a paciente dá 409: "Contato é paciente da clínica: não pode ser liberado para IA";
   - `GET /api/clinics/ai-releases` passa a exigir também `contacts:read`, porque traz o nome do contato. Há teste com um papel que tem só as chaves do Clinics;
   - o 409 da concessão revela a quem tem `clinics:restriction:manage` que o contato é paciente. É aceito: gerenciar a restrição implica conhecer esse status. Hoje só Owner e Admin têm a chave, e os dois leem a agenda;
   - a lista agora pagina por cursor keyset (`createdAt`, `id`), com `limit` de 1 a 100 (padrão 50). A dívida do teto de 500 tinha o gatilho "antes da tela de liberação" e foi paga aqui. Não há índice dedicado ao cursor; com o volume de liberações por workspace, ele não faz diferença.
6. **Aprovação no Core:** exatamente como no adendo 5 do ADR-047.
7. **Exclusão de contato que é paciente:** 409 pela FK, com a mensagem genérica do Core (item 3 do adendo 2). O teste confere que notas, auditoria, outbox e cota ficam iguais.
8. **Tela "Liberação para IA"** (`/clinics/ai-releases`):
   - **Acesso:** a entrada na lateral exige `clinics:restriction:manage` e só aparece com o status confirmado como ativo. A página exige também `contacts:read`; sem as duas permissões, só explica e nada consulta.
   - **Lista:** nome, motivo e data, com "Carregar mais" seguindo o cursor.
   - **Revogar:** sem confirmação, porque revogar torna o contato mais restrito.
   - **Conceder:** busca na lista de contatos do Core (`/api/contacts?search=`, a partir de 2 letras) e motivo da lista fechada.
   - **Paciente:** aparece como "não liberável", com a opção desabilitada, para quem tem `clinics:schedule:read`. A conferência pede só os contatos da busca, e as opções ficam desabilitadas até ela voltar. Para quem não tem a chave, a tela não consulta pacientes e mostra o 409 do servidor.
   - **Busca nova limpa a escolha:** não é possível enviar um contato que sumiu da lista.
   - **Navegação:** o grupo "Clínica" passa a depender só do status ativo, e cada item leva a permissão da sua rota. O shell e a busca escondem o que a pessoa não pode abrir. Antes, o grupo inteiro dependia de `clinics:catalog:read`. Uma **recarga** do status que falha depois de uma confirmação esconde o grupo de novo (falha fechada, adendo 4 do ADR-047), com teste.
9. **Medição da presença (item 8):** feita localmente, no `veyra_test`, com um workspace sem o Clinics (o caso comum) e oito modelos.

   | Consulta                                   | p50          | p95          |
   | ------------------------------------------ | ------------ | ------------ |
   | Sequencial                                 | 1,71–1,80 ms | 2,20–2,40 ms |
   | Paralela (`Promise.all`, client protegido) | 0,84 ms      | 1,00–1,06 ms |

   Adotada a forma paralela. A dívida segue aberta: continuam sendo N consultas por checagem, ainda longe do gatilho de 20 ms.

10. **Prova de concorrência** (`clinics-patients.integration-spec.ts`). Uma conexão externa trava a linha do contato e insere o paciente sem comitar. A aprovação de mensagem e a de tarefa ficam comprovadamente bloqueadas (`esperarBloqueadosPor`, que falha se a aprovação responder antes). Depois do commit, as duas recusam com 400 e expiram a proposta, sem mensagem, despacho, tarefa nem reserva. Na ordem inversa, aprovação primeiro e paciente depois, o despacho reconfere e não envia (`failed_permanent`, `content_restricted`). Outro teste prova que criar paciente, conceder e revogar esperam a trava do contato. Um terceiro cobre a porta **indisponível só na reconferência sob a trava**: a falha é injetada depois de a aprovação tomar a trava. As duas aprovações respondem 503, a proposta segue pendente, nada é criado e a reserva de envio volta. Com a porta de volta, a mesma proposta é aprovada. **Quatro mutações derrubaram os testes:**
    - sem a trava na aprovação, ela responde 201 antes do commit;
    - sem a reconferência sob trava, ela responde 201 depois do commit, e o caso indisponível também passa a aprovar;
    - sem devolver a reserva no desfecho indisponível, sobra uma reserva;
    - sem a trava na criação do paciente, a criação não espera.
11. **Bateria do §6.6 com paciente:** na suíte de restrição, um contato liberado que vira paciente é recusado em toda a superfície de IA. O conteúdo gerado enquanto estava liberado deixa de ser devolvido, e nada dele sai por webhook.
12. **Achado fora do escopo (bug pré-existente):** `PrismaPromptVersionRepository.ensure` faz busca e criação sem tratar P2002. Os dois primeiros usos simultâneos de uma capacidade, com a versão do prompt ainda inexistente, fazem um deles receber 409 (`PromptVersion_capability_version_key`). Reproduz isolado no teste "duas gerações SIMULTÂNEAS" do `reply-suggestion`, também no `HEAD` sem a F2.1. Fica registrado como dívida; a correção será proposta à parte. **Corrigido depois, em entrega própria:** o `ensure` reconhece só esse unique, relê a versão vencedora e confere o hash. A prova trava a tabela até as duas primeiras gerações pararem no INSERT, e mutações derrubam os testes.
13. **Revisão (`reviewer` e `security`, 2026-10-19):** os dois aprovaram com ressalvas, sem bloqueante, P0 nem achado alto. Corrigido antes do commit:
    - a lateral escondendo o Clinics quando a recarga do status falha;
    - o teste do desfecho indisponível sob a trava;
    - os testes de `contacts:read`;
    - a trava com `workspaceId` explícito;
    - o `contactId` omitido para quem não lê contatos, e o filtro por contatos na lista de pacientes;
    - o log de reserva só com o nome do erro;
    - o cursor validado como UUID;
    - a checagem rápida da tarefa olhando os mesmos contatos da guarda;
    - a busca nova limpando a escolha;
    - a asserção do motivo no e2e;
    - comentários.

    Registrado como limite ou dívida: a conexão extra da reconferência e as janelas (a), (b) e (c) do item 7 do adendo 5 do ADR-047. Também o lote de `updateMany` de contatos em `companies.service.ts`, que não segue ordem de id e pode, raramente, entrar em deadlock com uma aprovação de dois contatos. O Postgres aborta um dos lados.

14. **Bateria final (2026-10-19, logs `b12-*`):** verde.
    - lint, format e build passaram;
    - testes: 200 de unidade, 30 do web, 545/545 de integração em duas rodadas seguidas e 37 de e2e;
    - migrations: sem drift, e o banco montado do zero não tem diferença;
    - `check:fk` limpo.

    Numa bateria anterior, um e2e anterior à F2.1 falhou por seletor ambíguo: o link "Inbox" da lateral e o cartão da tela Hoje de um contato "Cliente Inbox…". Não reproduziu em 7 execuções. Os seletores foram escopados à navegação, num commit só de teste.

15. **Bloqueios:** os critérios do B2 estão **atendidos**:
    - a bateria do §6.6 está verde também com pacientes;
    - a prova de concorrência do item 2 existe, com mutações;
    - os passes de `reviewer` e `security` aprovaram, inclusive o delta;
    - a bateria completa está verde.

    O `security` confirma essa leitura. **O levantamento do B2 fica proposto à revisão e só vale com a decisão dela, registrada aqui.** B1, B3 e B4 seguem bloqueando dados reais e piloto, e o Clinics segue desativado em staging.

16. **Decisão da revisão (2026-10-19): o B2 NÃO foi levantado.** Os limites do item 7 do adendo 5 do ADR-047 podem permitir processamento ou envio depois que a restrição deveria valer:
    - a geração já em andamento;
    - ativar e desativar o vertical;
    - o despacho que confere só o contato atual.

    A revisão pediu que esses casos sejam fechados com garantia e testes. O plano está no adendo 6 do ADR-047, proposto e em revisão. O B2 só volta para decisão com a garantia implementada, a bateria completa verde e os passes de segurança. Até lá, o Clinics fica desativado em staging e sem dados reais.

    Na revisão do adendo 6 (2026-10-20), quatro das cinco decisões foram aprovadas. O residual da sessão de guarda **não** foi aceito como prova e ficou em aberto, então o B2 segue fechado também por ele.

### Adendo 4 (2026-10-20) — F2.2: agenda e registro de atendimento na API

Implementa os itens 4 e 5 do adendo 2, só na API. As telas e o e2e ficam para a F2.3. A revisão de 2026-10-20 liberou o desenvolvimento com **dados fictícios apenas**. O Clinics segue desativado em staging, e o B2 segue fechado (adendo 3, item 16; ADR-047 adendo 6).

1. **`ClinicsAppointment` (classe S).**
   - **Campos:** paciente, profissional, serviço, unidade, `startsAt` e `endsAt` (`timestamptz(3)`), status, motivo de cancelamento, quem criou e datas. Nenhum campo de texto.
   - **FKs compostas `NO ACTION`:** para paciente, profissional, serviço, unidade e a membership de quem criou. Nada do catálogo é apagado (só arquivado), e excluir o workspace leva tudo em cascata.
   - **No banco:** `CHECK ("endsAt" > "startsAt")` e o EXCLUDE do item 4 do adendo 2. O EXCLUDE recebe `workspaceId` e `professionalId` com `=` e `tstzrange("startsAt", "endsAt", '[)')` com `&&`, e vale **só** para os estados ativos (`scheduled`, `confirmed`, `arrived`, `attended`).
   - **Violação de sobreposição** (23P01 nessa constraint): o serviço a converte em 409, "horário já ocupado para este profissional". Não há pré-checagem: o banco é a única fonte da verdade.
   - **`startsAt` e `endsAt` não vêm de relógio** (ADR-049): são o horário escolhido, convertido da hora local da unidade.
2. **Motivo de cancelamento, por lista fechada:** `patient_request`, `clinic_request`, `professional_unavailable` e `scheduling_error`. Sem "outro" e sem texto.
3. **Hora local, fuso e mudança de horário.** A conversão é uma função pura, sem dependência nova, que usa o `Intl` do runtime. Para uma data e hora locais no fuso da unidade, ela procura os instantes cujo horário local é exatamente aquele:
   - **nenhum instante:** a hora não existe (é o "pulo" da mudança de horário). Resposta 400: "horário inexistente nesse dia por mudança de fuso";
   - **dois instantes:** a hora é ambígua (é a hora que se repete). Resposta 400, pedindo `utcOffset` (por exemplo, `-03:00`). Com ele, vale o instante desse deslocamento; um deslocamento que não corresponde a nenhum dos dois dá 400;
   - **um instante:** vale. Um `utcOffset` informado precisa bater com ele.
   - **Granularidade:** a hora é aceita em passos de 5 minutos, como as durações do catálogo.
4. **Expediente.** O início e o fim **locais** do agendamento precisam estar no mesmo dia local, dentro de um mesmo intervalo do profissional na unidade:
   - o dia da semana é o da data local;
   - o fim local vem do instante `endsAt` convertido de volta, e meia-noite do dia seguinte conta como minuto 1440.
   - Quem atravessa uma mudança de horário e não cabe recebe 400. Por exemplo: em Nova York, 01:30 + 60 min no domingo da primavera termina às 03:30 locais e não cabe num intervalo que vai até as 03:00.
   - **Leituras de borda, aceitas como estão:**
     - **na hora que se repete,** um atendimento pode terminar numa hora local anterior à de início (01:50 −04:00 + 30 min termina às 01:20 −05:00). Ele é aceito, porque o fim é lido na segunda ocorrência da hora;
     - **num dia sem meia-noite** (onde a mudança é às 00:00), um fim às 24:00 vira 01:00 do dia seguinte e é recusado.
5. **Regras de agendar e remarcar**, conferidas no serviço:
   - paciente existente;
   - profissional, serviço e unidade ativos;
   - profissional habilitado para o serviço;
   - horário dentro do expediente;
   - `endsAt = startsAt + durationMin` do serviço **no momento do agendamento**.

   Na **remarcação**:
   - conserva a duração registrada (`endsAt − startsAt`), e só a troca de serviço recalcula pela duração atual do novo serviço;
   - vale a partir de `scheduled` ou `confirmed`;
   - o agendamento volta a `scheduled`, porque a confirmação era do horário antigo.

   Mudar a duração de um serviço **não altera** agendamentos existentes.

6. **Transições** (`POST /api/clinics/appointments/:id/status`, com `{ to, cancelReason? }`):
   - `scheduled → confirmed → arrived`;
   - `canceled` (motivo obrigatório) e `no_show` a partir de `scheduled` ou `confirmed`;
   - `attended` **só** pelo registro de atendimento.

   Cada transição trava a linha do agendamento, lê o estado e responde 409 se a origem não for permitida; a escrita é condicionada ao estado lido. Cancelar e marcar falta liberam o horário, porque saem do EXCLUDE.

7. **Registro de atendimento (`ClinicsAttendance`, classe S).**
   - É 1:1 com o agendamento (`@@unique([workspaceId, appointmentId])`), com o profissional que executou (o do agendamento, no MVP), `completedAt` e quem registrou.
   - Exige `clinics:care:write` + `clinics:schedule:read` e é aceito a partir de `scheduled`, `confirmed` ou `arrived` (H1).
   - **Na mesma transação**, o agendamento vai a `attended`.
   - **Repetir** devolve o registro existente.
   - **Duas chamadas simultâneas** resultam em um só registro: a perdedora relê o vencedor. Teste de rollback: se a transição falhar, o registro não fica.
   - **Repetir devolve o registro a quem tem `clinics:care:write`.** Nenhum papel atual tem essa chave sem `clinics:care:read`.
8. **Rotas** (atrás do `ClinicsActiveGuard`, com 403 sem a chave e 404 só no caso residual):

   | Rota                                                                                                                              | Exige                                          |
   | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
   | `GET /api/clinics/appointments?date=AAAA-MM-DD[&unitId=][&professionalId=]` (o dia local da unidade; sem `unitId`, a única ativa) | `clinics:schedule:read`                        |
   | `POST /api/clinics/appointments` (`unitId` opcional, pela mesma regra)                                                            | `clinics:schedule:write`                       |
   | `POST /api/clinics/appointments/:id/reschedule`                                                                                   | `clinics:schedule:write`                       |
   | `POST /api/clinics/appointments/:id/status`                                                                                       | `clinics:schedule:write`                       |
   | `POST /api/clinics/appointments/:id/attendance`                                                                                   | `clinics:care:write` + `clinics:schedule:read` |
   | `GET /api/clinics/appointments/:id/attendance`                                                                                    | `clinics:care:read`                            |
   - **O que a agenda mostra:** o paciente aparece só pelo nome (§5.2), além dos horários locais e dos instantes.
   - **Autorização de campo** (SECURITY §4): o vínculo com o atendimento (`attendanceId`) é **omitido no servidor** para quem não tem `clinics:care:read`.
   - **Teto:** um dia de uma unidade. São no máximo 500 linhas, sem paginação, e o teto entra na dívida.

9. **Mudar o fuso da unidade** com agendamentos ativos futuros responde 409 (item 4 do adendo 2).
   - **"Futuro"** se compara com o relógio da aplicação. O início do agendamento é um horário escolhido por uma pessoa, não um agendamento de fila, então o ADR-049 não se aplica, e alguns segundos de desvio não mudam a decisão.
   - **Corrida com quem agenda:** agendar e remarcar travam a linha da unidade na própria transação, e a mudança de fuso trava a mesma linha antes de conferir. O fuso é relido **depois** da trava. Sem isso, um agendamento calculado com o fuso antigo poderia comitar depois da mudança.
   - **Ordem das travas e ausência de ciclo:** a ordem é unidade → agendamento. O atendimento e as transições travam só o agendamento. Toda transação trava no máximo **uma** unidade, porque a remarcação não muda a unidade. Por isso não há ciclo **entre as travas de linha**.
   - **Limite com mais de uma unidade:** a espera do EXCLUDE pode, sim, fechar um ciclo entre agendamentos do **mesmo profissional em unidades diferentes**. Exemplo: T1 remarca A (U1) para um horário que C ocuparia, enquanto T2 cria C (U2) num horário que A ainda ocupa. O resultado seria um deadlock (40P01), que hoje responderia 500. Isso não acontece agora, porque há uma unidade por workspace e não existe API para criar outra. Fica como dívida com gatilho "segunda unidade".
   - **Custo aceito:** a trava serializa as escritas de agenda de uma mesma unidade. O teste de "N simultâneos" prova a sobreposição barrada pelo banco virando 409 em série, não inserções de fato paralelas. Para o volume de uma clínica, é aceitável.
10. **Auditoria e fronteira.**
    - **Allowlists só com ids, status, instantes e motivo:**
      - agendamento: `patientId`, `professionalId`, `serviceId`, `unitId`, `startsAt`, `endsAt`, `status`, `cancelReason`;
      - atendimento: `appointmentId`, `professionalId`, `completedAt`.
    - **Nada sai do vertical:** nenhuma entidade do Core (tarefa, atividade, notificação) nem evento de outbox. Há teste.
    - **Os dois modelos entram em `CLINICS_MODELS`** e, portanto, na checagem de presença da porta do E6.
11. **Testes, todos com dados fictícios:**
    - **Isolamento:** P0 e FKs compostas recusando paciente, profissional, serviço, unidade e agendamento de outro workspace.
    - **Concorrência:**
      - N agendamentos simultâneos no mesmo horário e profissional → exatamente um, os outros 409;
      - profissionais diferentes convivem;
      - cancelar libera o horário;
      - remarcar para um horário ocupado dá 409.
    - **Regras e transições:** as regras do item 5; duração registrada; todas as transições válidas e inválidas; `attended` só pelo atendimento.
    - **Atendimento:** idempotente, concorrente e com rollback.
    - **RBAC:**
      - a recepção marca e lê, mas recebe 403 no atendimento, e a agenda omite o vínculo;
      - o `Profissional` lê a agenda e registra atendimento, mas recebe 403 ao marcar;
      - Guest e workspace sem o Clinics recebem 403.
    - **Fuso:** testes com `America/New_York` cobrindo o pulo, a repetição com e sem `utcOffset`, o expediente atravessando a mudança e a listagem do dia; mais o fuso da unidade recusado com agendamento futuro.
    - **Fronteira:** nada S no Core nem na auditoria, e presença com os modelos novos.
12. **Implementação (2026-10-20).**
    - **Migration:** `20261020020000_clinics_schedule` é aditiva, com `lock_timeout`, CHECK e o EXCLUDE parcial.
    - **Conversão de hora local:** `schedule/local-time.ts`, testada com o pulo e a repetição de Nova York e com o dia sem meia-noite do Brasil em 2018.
    - **Suíte:** `clinics-schedule.integration-spec.ts`, com 34 testes, e a de restrição com a presença dos dois modelos. A suíte cobre:
      - a matriz inteira de transições, a partir dos seis estados;
      - as FKs cruzadas uma a uma;
      - os ids de A enviados por B no corpo e na consulta;
      - o 404 residual;
      - duas corridas determinísticas: a mudança de fuso e a transição de estado.
    - **Datas:** os testes de mudança de horário usam 2025 (passado, base de fusos fixa). O teste de "futuro" calcula a própria data. O contrato aceita anos de 2000 a 2100, porque antes dos fusos padronizados o deslocamento tem segundos.
    - **Testes estáticos:** paridade dos enums novos entre contrato e banco, e o vertical sem escrita no Core nem em quem publica eventos.
    - **Presença com dez modelos:** p50 de 0,92–0,95 ms e p95 de 1,05–1,09 ms. Com oito, o p95 era de 1,00–1,06 ms.
    - **A transição trava antes de ler,** como a remarcação, e só escreve a partir do estado lido. Assim a trilha registra o estado que de fato substituiu; o defeito foi apontado na revisão.
    - **A janela da lista do dia** é justa ao dia local, com folga de 3 h. Assim o teto de 500 vale para o dia pedido, não para uma janela UTC de 52 h; também apontado na revisão.
    - **Defeito achado por teste antes do commit:** agendar e remarcar liam o fuso da unidade **antes** de travar a linha dela. Uma mudança de fuso comitada durante a espera fazia o horário ser calculado com o fuso antigo. Agora a trava devolve a unidade relida depois de travar. O teste determinístico segura a linha numa conexão externa, muda o fuso e comita, e o agendamento sai no fuso novo.
    - **Mutações que derrubam os testes:**
      - sem a tradução do 23P01 em "horário ocupado";
      - sem a trava da unidade;
      - sem a omissão do vínculo com o atendimento;
      - sem a checagem de expediente;
      - recalculando a duração na remarcação sem troca de serviço;
      - lendo antes de travar na transição: a trilha volta a registrar `scheduled`.

## ADR-049 — Relógio de agendamento: quem compara define o relógio, e filas e leases usam o do banco

**Status:** aceito (plano aprovado pela revisão de 2026-10-19; a entrega segue para revisão) · **Data:** 2026-10-19

**Contexto.** A falha intermitente da integração foi finalmente capturada pelo diagnóstico do outbox:

- o relógio do Node estava **19.447 ms à frente** do Postgres;
- os eventos novos estavam com `nextRetryAt − now() ≈ +19,4 s`;
- não havia sessão de outro processo no banco.

O relógio da VM do Docker atrasa sob carga. O mesmo vale para app e banco em hosts diferentes.

O inventário de todas as colunas de data e hora (2026-10-19) mostrou o seguinte:

- **O Prisma 7 preenche `@default(now())` e `@updatedAt` no cliente**, com o relógio do Node. O `DEFAULT CURRENT_TIMESTAMP` das migrations nunca é usado pela aplicação.
- **Há dois pares mistos Node × Postgres em produção:**
  1. **`OutboxEvent.nextRetryAt` na criação.** O Node escreve e o claim compara com `"nextRetryAt" <= now()`. Com o Node adiantado, todo evento novo fica invisível pelo tamanho do desvio. Isso atrasa webhooks, automações, envios e expurgos.
  2. **`MessageDispatch.updatedAt`.** O Prisma escreve com o Node, e a varredura `reapUnretriable` compara com `now() - 15 min`. Com o Node atrasado, um despacho que aguarda nova tentativa é enterrado como `no_retrier` antes da hora.
- **Um par com relógio externo:** `Conversation.lastInboundAt` é `min(Meta, Node)` e é comparado no Node para a janela de 24 h. Quem decide de fato é a Meta.
- **Um amplificador latente:** as colunas são `TIMESTAMP(3)` sem fuso, e nada fixa o fuso da sessão do banco. Fora de UTC, cada par misto passaria a errar pelo deslocamento do fuso, em horas.
- **Testes que comparam um valor gravado pelo banco com `Date.now()`, ou um valor do Node com folga de ±1 s comparado pelo banco.** Eles quebram com o mesmo desvio de VM.
- **Pares Node × Node entre instâncias:** lease de idempotência de 60 s, TTL da reserva de quota, `exp` do JWT e virada do mês do contador. Ficam seguros enquanto os relógios das instâncias concordam.

**Decisão.**

1. **Regra.** Todo instante que agenda ou decide algo é **escrito e comparado pelo mesmo relógio**. Se a comparação é em SQL com `now()`, quem escreve é o banco. Se a comparação é no Node, quem escreve é o Node. Misturar é proibido.
2. **Filas, leases e varreduras usam o relógio do banco**, na escrita e na comparação: outbox, despacho do WhatsApp, coleta de mídia e varredura de arquivos.
   - **`OutboxEvent.nextRetryAt`** nasce pelo DEFAULT do banco (`@default(dbgenerated("transaction_timestamp()"))`): o Prisma deixa de enviar o valor. As retentativas já eram agendadas com `now()` em SQL.
   - **Por que `transaction_timestamp()` e não `CURRENT_TIMESTAMP`:** é o mesmo instante de `now()`, o início da transação. Escrito como `CURRENT_TIMESTAMP`, o Prisma o leria como o `now()` dele, que é preenchido no cliente, e acusaria drift para sempre.
   - **`MessageDispatch.updatedAt`** passa a ser mantido pelo banco:
     - o DEFAULT do banco cobre a criação, e o `@updatedAt` sai do schema;
     - um trigger `BEFORE UPDATE` grava `now()` quando o valor novo da coluna é **igual** ao antigo, que é o caso de quem não a define;
     - quem grava um valor diferente tem o valor respeitado. Em produção, só as varreduras em SQL fazem isso, com `now()`; nos testes, o envelhecimento das linhas;
     - um teste estático proíbe o código de produção de escrever essa coluna, ou o `nextRetryAt`, pelo Prisma (inclusive `*AndReturn`) ou por SQL cru com valor de fora do banco.
3. **A aplicação fixa o fuso da sessão em UTC.**
   - Todo `PrismaClient` do projeto (aplicação, CLIs e scripts) usa `prismaAdapter`, que põe `-c TimeZone=UTC` **na própria URL**, somado a um `options` que ela já traga. No `pg`, parâmetro da URL tem precedência sobre o config, então a fixação só no config seria descartada em silêncio por uma `DATABASE_URL` com `?options=`. O último `-c` vence. Com colunas sem fuso, isso deixa `now()`, o DEFAULT e a leitura pelo adapter (que interpreta como UTC) no mesmo referencial.
   - **No boot, a aplicação confere `SHOW TimeZone`.** Com o banco alcançável e fora de UTC, recusa subir (falha fechada): é o caso de um pooler que descarte parâmetros de sessão, como o PgBouncer em modo transação. Com o banco indisponível ou inexistente, só registra e sobe, porque a conexão do Prisma é preguiçosa e o boot nunca dependeu do banco. A fixação vai em cada conexão nova.
   - **Sem `new URL()` na mesclagem.** O erro dele carrega a URL inteira, senha incluída, e iria para o log com uma `DATABASE_URL` mal formada; o `pg` redige a sua de propósito. Ele também recusa formatos que o `pg` aceita, como o de socket. A mesclagem toca só o parâmetro `options`, e um erro dela não leva a entrada nem `cause`. O aviso do boot registra o nome e o código do erro, nunca a URL.
   - **Residual:** se o banco estiver fora no boot **e** um pooler descartar parâmetros de sessão, a sessão fica no fuso padrão do servidor sem aviso até a próxima subida com o banco alcançável. Hoje não há pooler no caminho, e em staging o `api` só sobe com o `db` saudável.
   - **Por que a tolerância:** a primeira versão desta checagem era estrita e derrubou o E2E do CI no commit `3e6c14e`. O Playwright sobe a API **antes** do `globalSetup` que cria o banco `veyra_e2e`, e num CI limpo o banco ainda não existia. Localmente passava porque o banco sobrava de execuções anteriores. Em staging, o `api` só sobe com o `db` saudável (`depends_on`).
4. **A janela de 24 h do WhatsApp (relógio da Meta) não muda.** A autoridade é a Meta. O ajuste `min(Meta, Node)` já impede uma janela "do futuro", e o caso residual (Node atrasado mais do que a latência de entrega) termina numa recusa permanente da Meta, sem envio indevido.
5. **Node × Node entre instâncias fica fora desta correção.** Com uma única instância da API, ele não existe. Fica registrado como dívida, com o gatilho "segunda instância da API".
6. **Testes com desvio artificial.** O relógio do Node é deslocado no processo de teste, pela substituição de `Date`, nos dois sentidos. Cada par corrigido é exercitado pelo caminho real, com mutação que traz o defeito de volta. Os testes frágeis passam a usar o relógio do banco.

**Consequências.**

- Uma migration aditiva com a função e o trigger do `MessageDispatch`, com `lock_timeout`, como a do outbox. Nenhum dado muda. Ela trava `MessageDispatch` antes de `OutboxEvent`, na mesma ordem da aplicação.
- **Deploy: a migration roda ANTES do código novo.** Sem o DEFAULT, o NOT NULL do `updatedAt` do despacho recusaria todo envio. O código antigo funciona com a migration aplicada, porque manda os valores explícitos e o trigger os respeita (`docs/DEPLOY_STAGING.md` §4).
- **Premissa sobre dados existentes:** o padrão do servidor de staging (`postgres:17-alpine`, sem `TZ`) é UTC, então fixar a sessão não reinterpreta nada já gravado. Em outro ambiente, confira `SHOW timezone` antes do primeiro deploy: fora de UTC, os instantes gravados pelo banco mudariam de sentido pelo deslocamento do fuso.
- O `updatedAt` do despacho mostra a hora do banco.
- `clock_timestamp()` não é usado: `now()` é o início da transação, o mesmo referencial dos claims.

**Alternativas.**

- **Varredura do despacho com corte calculado no Node.** Rejeitada: poria uma fila no relógio do Node e a exporia ao desvio entre instâncias.
- **Trigger também no outbox.** Desnecessário: `nextRetryAt` só é agendado pelo Node na criação, e o DEFAULT resolve.
- **Tolerância (folga de N segundos) nos claims.** Rejeitada: esconde o desvio sem eliminar o par misto.

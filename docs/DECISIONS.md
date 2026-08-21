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
**Decisão:** `AiRun.result` guarda a saída **já validada** pelo Zod da capacidade — nunca o prompt, o corpo bruto da mensagem ou segredo. O run também grava o **alvo** (`conversationId`/`contactId`) em colunas FK compostas, e a interface relê o último resultado por alvo. O resultado é **conteúdo derivado** e por isso é servido só pelo endpoint do alvo, com a permissão do domínio (`conversations:read`); a visão de custo (`workspace:manage`) devolve metadados **sem** o resultado — quem administra custo não é necessariamente quem pode ler conversas.
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

**Consequências:** um workspace sem assinatura ativa consegue enviar até o teto do plano padrão, e não mais. Preço: existe um caminho em que a operação é limitada por um estado administrativo — por isso o alerta, para que a causa seja tratada em vez de virar mistério de suporte. O log é o canal de alerta que temos hoje; alerta com destinatário (e-mail/on-call) fica registrado como dívida, porque não existe infraestrutura de alerta no projeto ainda.

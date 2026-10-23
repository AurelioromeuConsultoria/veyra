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
   - **Migration.** Usa `lock_timeout` de 5 s: o `ADD COLUMN` só mexe em metadados, mas pede lock exclusivo na tabela mais escrita do sistema. Se estourar, o runbook (DEPLOY_STAGING §4) manda `prisma migrate resolve --rolled-back` antes de repetir. _(Procedimento corrigido em 2026-10-21: o `migrate deploy` não aplica a migration numa transação, e o runbook passou a exigir a prova do estado, pelo inventário, antes do `resolve`. Ver ADR-048 adendo 7, "Ajustes pedidos antes da liberação".)_
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

### Adendo 6 (2026-10-19, APROVADO PARA IMPLEMENTAÇÃO em 2026-10-20, junto com o adendo 7, sob o critério G′) — fronteira da garantia: nenhum uso externo começa depois de uma mudança de restrição

**Situação em 2026-10-20:** o critério deixou de ser G e passou a ser **G′**, com o texto do adendo 7 aprovado. A implementação deste adendo, com os acréscimos do adendo 7, está autorizada. O B2 continua fechado (adendo 7, "Aprovação").

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
- **Operações começadas antes de t** podem terminar depois. O resultado delas é tratado como conteúdo restrito: fica oculto na leitura, é expirado, não vira ação, e o desfecho incerto **nunca** é retentado dentro do uso (a nova tentativa é um uso novo, que passa pela guarda).
- **Consequência direta:** M não pode comitar enquanto existir uma operação **autorizada** que ainda possa começar. A prova disso **não usa prazo**. Usa uma trava de banco mantida por uma **sessão viva** durante toda a janela em que a operação pode começar, e M precisa da trava em modo conflitante.

#### 3. Mecanismo: uso externo sob trava (`ContentUseGuard`, Core)

**3.1. Travas consultivas de restrição, separadas das travas de linha.** O adendo 5 travava a linha do contato com `updateMany` de `updatedAt`. Para usos que duram segundos, isso bloquearia edições comuns do contato e reescreveria o `updatedAt` a cada leitura da IA. A proposta é trocar esse mecanismo por **travas consultivas de chave única de 64 bits**. Esse espaço de chaves não colide com as travas existentes, que usam duas chaves de 32 bits. São duas famílias:

- **workspace:** `hashtextextended('veyra.restriction.ws:' || workspaceId, 0)`;
- **contato:** `hashtextextended('veyra.restriction.contact:' || contactId, 0)`.

Uma colisão de hash só causa espera a mais, nunca liberação indevida. A primitiva `lockContactsForRestriction` passa a pegar essas travas em vez de tocar a linha. Ela é a única peça do Core com SQL próprio para isso, registrada como exceção ao §3.3 com a justificativa "coordenação de restrição". _(Alterado pelo adendo 7, seção 3.8: as outras peças de SQL próprio da coordenação estão listadas lá.)_

**3.2. Ordem global das travas (sem exceção):**

1. Trava de restrição do **workspace**: compartilhada para usos, aprovações e mudanças por contato; **exclusiva** para mudanças do workspace inteiro.
2. Travas de restrição dos **contatos**, em **ordem crescente de id**, sem repetição: compartilhadas para usos e aprovações, exclusivas para mudanças.
3. Travas de **entidade** que determinam a quem um conteúdo pertence (deal e tarefa, item 6), em ordem crescente de id.
4. Linhas próprias da operação (proposta, dispatch, evento do outbox).

Nenhum caminho pega um nível depois de um nível posterior. A trava tentada de ativação (`clinics_activation`) fica **antes** do nível 1, porque é exclusão mútua entre CLIs.

Os lotes que hoje travam contatos fora de ordem (`companies.service.ts`, remoção de empresa) passam a travar em ordem de id. Isso paga a dívida registrada.

**3.3. Sessões de guarda num pool próprio.** Um uso segura a trava durante a chamada externa. Para não disputar o pool do Prisma, a guarda usa um **pool dedicado** (`pg`, `application_name = veyra-guard`), com tamanho configurável (padrão 5) e keepalive TCP ligado. Cada sessão de guarda: _(Alterado pelo adendo 7, seções 3.1 e 3.2: a guarda é uma transação do Prisma sobre este pool, o registro usa um segundo pool, e a guarda pega uma trava própria do uso.)_

1. `BEGIN`.
2. `SET LOCAL idle_in_transaction_session_timeout = 0` (a sessão fica ociosa em transação durante a chamada, e um padrão do servidor não pode derrubá-la no meio) e `SET LOCAL lock_timeout = '5s'`. _(Alterado pelo adendo 7, seção 3.1: o prazo passa a ser o do tipo mais 30 s, com `statement_timeout` e keepalive curtos, para uma guarda congelada não segurar M sem limite.)_
3. Pega as travas compartilhadas dos níveis 1 a 3, na ordem.
4. **Reconfere a porta.** É uma consulta nova, feita depois das travas, que enxerga qualquer mudança já comitada.
5. Faz uma **prova de vida** da própria sessão (`SELECT 1` nela): as travas existem neste instante.
6. **Inicia a operação externa**, sem I/O entre a prova de vida e o início.
7. Espera o desfecho dentro do prazo absoluto (item 4).
8. **Persiste o resultado ainda sob a trava**: run, proposta, desfecho do dispatch ou da entrega.
9. `COMMIT`, que solta as travas.

_(Alterado pelo adendo 7, seção 3.2: trava própria do uso, registro durável antes da prova de vida e estado final escrito antes do `COMMIT`.)_

**Fronteira de módulos.** A IA usa a guarda por uma porta, `run(escopo, operação)`. A operação é a chamada ao provedor mais a persistência do resultado. O módulo `intelligence` continua sem tocar o Prisma, e a guarda fica no Core, ao lado da porta do E6.

**3.4. Por que isso fecha G.** Uma mudança M precisa da trava exclusiva do contato (ou do workspace), que conflita com a compartilhada do uso.

- **Uso autorizado antes de M:** M espera o uso soltar. Quando ele solta, já começou, terminou ou foi abortado, e o resultado está persistido. Então M comita, e a expiração depois do commit alcança esse resultado. Isso elimina o resíduo do limite (a).
- **Uso que tenta começar depois de M pegar a trava:** espera, reconfere depois do commit de M e é recusado.

O prazo nunca entra na prova: só a trava, mantida pela sessão viva.

**3.5. O único caso que a trava não cobre: a sessão de guarda morrer.** Se a sessão morrer, o Postgres solta as travas; isso acontece com reinício do banco ou conexão derrubada.

- **Prevenção:** a prova de vida (passo 5) fica imediatamente antes do início. Para M comitar indevidamente, a sessão teria de morrer, e M pegar a trava e comitar, dentro do intervalo, sem I/O, entre a resposta da prova de vida e o início da requisição. _(Alterado pelo adendo 7, seção 3.2: a prova de vida passa a ser o passo 6.)_
- **Detecção garantida:** se o `COMMIT` da guarda falhar, o uso é marcado `guard_lost`: _(Texto original, superado: o `COMMIT` não garante detecção, porque um processo que morre nunca chega a ele. `guard_lost` passa a ser `in_doubt`, e o evento, `content_use.in_doubt`; ver o adendo 7, seções 3.3 e 3.6.)_
  - o resultado da IA é descartado (não é persistido) e a reserva é cobrada;
  - o desfecho do envio fica como está;
  - um evento de auditoria `content_use.guard_lost`, só com ids, abre o incidente.
- **A revisão decide** se aceita esse residual, com detecção garantida, ou se pede outra forma de prevenção. _(Texto original, superado: o `COMMIT` não garante detecção; ver o adendo 7, seção 3.)_
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

**Antes de começar:** recusa na reconferência, porta indisponível, guarda sem conexão disponível, trava não obtida ou prova de vida falha. Nada começou: _(Alterado pelo adendo 7, seção 3.2: depois do registro, a reserva só volta se a transição para `aborted` afetou a linha.)_

- a **reserva volta inteira**;
- a proposta continua pendente (503) ou é expirada (restrito).

**Começou e terminou com resposta:** cobra o consumo real, como hoje.

**Começou e ficou incerto** (prazo estourado, conexão caída, erro depois do início, ou `guard_lost`): _(Alterado pelo adendo 7, seções 3.2 e 3.6: o prazo estourado com a guarda viva termina `concluded`; `guard_lost` passa a ser `in_doubt`, e são duas as reservas da IA.)_

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

- esperam os usos e as aprovações em andamento no workspace; _(Alterado pelo adendo 7, seção 3.3: e marcam `in_doubt` todo uso órfão do workspace.)_
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

O envio de mensagem da IA guarda os passos 3.3.3 a 3.3.9 em volta do envio. Os passos de política, consentimento e reserva continuam antes da guarda. _(Alterado pelo adendo 7, seção 3.2: a numeração dos passos muda com o registro.)_

#### 8. Custos aceitos

- **Uma sessão do pool de guarda por operação externa em andamento.** Com o pool cheio, a operação espera (no máximo 5 s) e depois segue o caminho de "não começou". O tamanho do pool limita as operações externas simultâneas **por instância**; é um parâmetro operacional. _(Alterado pelo adendo 7, seção 3.1: e uma conexão curta do pool de registro.)_
- **Uma mudança por contato pode esperar** até o fim de uma geração de IA em andamento (no máximo 60 s mais a persistência). Na prática, espera até 10 s e responde 409 para tentar de novo. _(Alterado pelo adendo 7, seção 3.1: com uma guarda congelada, o limite real é o prazo do tipo, mais a margem, mais a detecção do keepalive.)_
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
3. **Sessão de guarda morta antes da prova de vida.** O teste mata a sessão (`pg_terminate_backend`) por um ponto de teste. O uso não começa, responde 503 e devolve a reserva. _(Alterado pelo adendo 7, seção 4: o uso termina `aborted` ou `in_doubt`, conforme o registro tenha comitado.)_
4. **Sessão de guarda morta durante a chamada.** O `COMMIT` falha, o caso vira `guard_lost` com auditoria, e a reserva é cobrada. _(Alterado pelo adendo 7, seções 3.3 e 3.6: vira `in_doubt` com `detectedBy: commit`.)_
5. **Prazo estourado.** Desfecho incerto, reserva cobrada pelo teto, sem retentativa. A trava é solta, e a mudança que esperava comita.
6. **Pool de guarda esgotado.** O uso não começa (503 ou nova tentativa), sem chamar o transporte. _(Alterado pelo adendo 7, seção 3.1: vale para os dois pools, e há teste de N usos simultâneos acima do tamanho do pool.)_
7. **Aprovação contra ativação.** A ativação primeiro faz a tarefa não nascer. A aprovação primeiro faz a ativação esperar.
8. **Webhook contra troca de contato do deal**, com a mesma bateria.
9. **Ordem das travas:**
   - um teste estático garante que toda aquisição passa por uma única primitiva ordenada;
   - um cenário com mudança por contato, ativação, aprovação e uso concorrentes termina sem deadlock.
10. **Mutações:**
    - sem a trava no uso, os testes do cenário 2 caem;
    - sem a prova de vida, cai o cenário 3; _(Alterado pelo adendo 7, seção 4: as mutações das peças novas estão listadas lá.)_
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

1. Aceitar o residual do item 3.5 (sessão de guarda morta no intervalo sem I/O), com detecção garantida e incidente auditado. _(Texto original, superado: ver o adendo 7.)_
2. Prazos: 60 s para a IA (sem retentativa do SDK), 20 s para a Meta e 10 s por destino de webhook. Tamanho do pool de guarda: 5. _(Alterado pelo adendo 7, seção 3.1: mais o pool de registro.)_
3. Mudanças interativas: esperar até 10 s e responder 409, em vez de esperar o fim da geração.
4. Religação de conversa: regra mais teste estático (recomendado), ou fotografia no dispatch.
5. A troca de contato de deal ou de tarefa entra no protocolo como mudança de pertencimento.

**Decisões da revisão (2026-10-20).** O adendo **continua proposto**, e isto não autoriza implementar nem levantar o B2.

1. **Residual da sessão de guarda: NÃO aceito.** Fica como decisão em aberto (item 3.5). Antes de implementar, o plano precisa trazer uma garantia que impeça a chamada (não só que a detecte), ou um critério revisto para aprovação.
2. **Prazos: aprovados.** São absolutos: 60 s para a IA, 20 s para a Meta e 10 s por destino de webhook. As tentativas automáticas do SDK ficam desligadas, e cada nova tentativa passa pela guarda de novo.
3. **Espera: aprovada.** Mudanças interativas por contato esperam até 10 s e respondem 409, sem efeito colateral quando o prazo estoura. A CLI de ativar e desativar espera até 90 s.
4. **Religação de conversa: aprovada a regra.** O vínculo continua imutável, fixado por teste. Se a religação surgir, ela entra no protocolo e protege o contato antigo, o novo e a conversa.
5. **Troca de contato de deal ou tarefa: aprovada como mudança de titularidade do conteúdo.** Protege os contatos antigo e novo e a entidade, na ordem de travas do item 3.2.

### Adendo 7 (2026-10-20, APROVADO — texto aprovado e implementação autorizada sob G′; o B2 continua fechado) — o residual da guarda: o que se pode garantir e o que precisa ser decidido

**Situação:** responde à decisão da revisão sobre o adendo 6, que não aceitou o residual da sessão de guarda como prova de G.

**Aprovação (revisão de 2026-10-20, depois da quarta rodada do `reviewer`).** O texto foi aprovado, e a implementação dos adendos 6 e 7 está autorizada **sob G′**.

- **O que a aprovação aceita, explicitamente:** na perda da guarda, uma chamada autorizada antes da restrição pode começar depois dela. O registro durável, a reconciliação e o descarte posterior permitem **tratar** esse caso; não desfazem o envio externo.
- **Critérios obrigatórios da implementação:**
  - o registro é confirmado (comitado) antes da chamada, e uma falha de registro impede o envio;
  - a reconciliação se apoia em **prova de encerramento da guarda**, nunca só em prazo vencido;
  - resultados, auditoria e reservas ficam consistentes, inclusive com reinício, conclusão tardia e dois detectores concorrentes;
  - testes determinísticos dessas falhas e revisão final de segurança.
- **O B2 não está resolvido.** Ele só volta para decisão depois da implementação validada: critérios acima, bateria completa verde e passes de `reviewer` e `security`. Até lá, o Clinics continua desativado em staging, sem dados reais.

**Decisão da revisão (2026-10-20).** A revisão aceitou a **mudança de direção para uma autorização coordenada com a restrição** (G′), mas pediu três ajustes no texto antes da implementação:

1. explicitar a consequência no cenário de perda da guarda;
2. retirar "sempre detectado" como garantia do `COMMIT`, e prever registro durável antes da chamada e reconciliação dos usos sem conclusão, inclusive depois de reinício;
3. ajustar o item (c), distinguindo o que ainda pode ser recusado do que já saiu.

Pediu também que o texto não afirme que G estrita é impossível em qualquer desenho. **Não aprovou** a proibição geral de liberações para IA. O B2 continua bloqueado até a implementação do critério revisado, seus testes e os passes finais.

**Esta versão** incorpora os três ajustes e quatro revisões do `reviewer` sobre a redação deles.

A primeira apontou:

- a ordem do registro contra a guarda de transação única;
- a varredura marcando usos vivos;
- a mudança do workspace inteiro;
- a durabilidade do registro;
- o mapeamento com o adendo 6.

A segunda apontou:

- a prova de que a guarda acabou, que falhava no webhook sem contato e sofria inanição: agora há uma trava própria por uso;
- a espera circular de pegar duas conexões do mesmo pool: agora há um pool de registro;
- os `in_doubt` falsos quando o processo decide o desfecho: agora o estado final é escrito antes do `COMMIT`;
- a numeração dos passos;
- os ponteiros no adendo 6;
- a exceção ao §3.3.

A terceira apontou:

- **por qual conexão a persistência roda:** agora é a transação da guarda, por um PrismaClient filtrado sobre o pool de guarda;
- **o registro de origem que ainda não existe na hora do registro:** agora há ids pré-gerados e as duas reservas da IA;
- **o commit ambíguo do registro:** agora há uma lápide com `ON CONFLICT`;
- **a prova de vida que falha depois do registro;**
- **a exceção cross-workspace da reconciliação,** o índice e a retenção;
- **a guarda congelada sem limite:** agora há prazos de sessão.

A quarta apontou:

- o prazo da transação da guarda, que precisa somar todas as esperas de antes da chamada;
- os metadados mínimos do run no registro;
- a ordem "uso primeiro" restrita a quem está fora da guarda viva;
- as reservas cobradas pelo teto quando a persistência falha;
- a lista completa do SQL próprio;
- a numeração;
- os desfechos da trava do uso e da lápide.

Volta para aprovação do texto antes do código.

#### 1. O conflito de G estrita

G pede: se M comita em t, nenhuma operação externa com conteúdo do contato **começa** depois de t.

**"Começar" é uma ação local do processo** (escrever a requisição no socket) e acontece **depois** da última interação dele com o banco:

- **Toda coordenação feita no banco** (trava, lease, permissão durável, confirmação) termina num instante t₀ em que o processo ainda não começou. Entre t₀ e o início existe sempre um intervalo, ainda que sem I/O.
- **Se o processo for suspenso nesse intervalo**, o banco não distingue "suspenso e ainda vai começar" de "morto". Uma suspensão longa pode vir de pausa da VM, de coleta de lixo ou de congelamento do contêiner. Este projeto já mediu uma: a VM do Docker atrasou 19 s (ADR-049).
- **Prazo e relógio local não fecham o intervalo.** O teste "comece em até W depois da confirmação" é ele próprio uma verificação seguida de ação. E numa pausa de VM, o relógio monotônico do processo também para.

**O que isso mostra é um conflito, não uma impossibilidade.** G estrita e "a mudança de restrição sempre prossegue em tempo limitado" não valem juntas enquanto houver um uso autorizado cujo resultado é desconhecido. Há desenhos que satisfazem G, e cada um paga com uma destas três coisas: a disponibilidade da restrição, algo fora do nosso processo ou funcionalidade.

- **M espera até o destino de todo uso autorizado ser conhecido:** a conclusão do uso, ou uma prova externa de que o processo não vai mais começar (por exemplo, a instância reiniciou ou o orquestrador confirmou que o contêiner foi parado). Com o registro da seção 3, essa espera só acontece no caso raro de perda da guarda (seção 5, opção 3).
- **Cerca no receptor:** o destino recusa uma requisição com token vencido. O provedor de IA e a Meta não oferecem isso, e os webhooks vão para endpoints dos clientes. Um proxy de saída nosso é outro processo, com o mesmo intervalo.
- **Não autorizar uso externo** do conteúdo de contatos que possam ficar restritos. Para a IA, é o que a opção 2 da seção 5 faz.

#### 2. G′: autorização coordenada com a restrição

> **G′.** Se M comita em t:
>
> - (a) nenhuma operação externa com conteúdo do contato é **autorizada** depois de t;
> - (b) toda operação autorizada antes de t **termina** antes de M comitar, é **abortada** antes de começar, ou, se a guarda dela se perdeu, fica **registrada como uso em dúvida** e vira incidente auditado. O registro sobrevive à morte do processo e ao reinício, dentro da premissa de durabilidade da seção 3.5;
> - (c) **o que ainda não saiu é recusado:** toda nova leitura, aprovação ou envio depois de t reconfere a restrição. **O que já saiu não pode ser recolhido:** o conteúdo já enviado e o que o destino guarda dele. Isso vale para o prompt ao provedor de IA, para a mensagem à Meta (e, por ela, ao paciente) e para o webhook ao endpoint do cliente. **A nossa cópia** da resposta, essa sim, é descartada se chegar depois de t: não é persistida como legível, nem aprovada, nem enviada adiante.

O mecanismo é o do adendo 6, com os acréscimos da seção 3:

- trava mantida por sessão viva;
- reconferência e prova de vida;
- prazos absolutos, sem retentativa do SDK;
- resultado persistido sob a trava.

**A consequência, explícita: esta é a diferença concreta entre G′ e G.** No cenário de perda da guarda, uma chamada autorizada **antes** da restrição pode **começar depois dela**. O conteúdo do contato chega ao destino quando a restrição já vale: o provedor de IA; a Meta e, por ela, o paciente; ou o endpoint do cliente, no webhook. Descartar o resultado protege o que o Veyra faz a seguir, mas **não desfaz** o conteúdo já enviado. Nesse caso, G′ oferece só três coisas:

- o caso não passa despercebido;
- fica registrado com o contato, o uso e o destino;
- vira incidente para resposta.

#### 3. Detecção recuperável: registro durável antes da chamada e reconciliação

**O `COMMIT` da guarda não é garantia de detecção.** Se o processo morre depois de começar a chamada, ou no intervalo sem I/O, ele nunca executa esse passo nem registra nada. A detecção precisa de três coisas:

- um registro que já exista **antes** da chamada;
- uma prova de que a guarda de um uso acabou, que valha para **todo** uso, com ou sem contato;
- detectores que só marquem um uso quando tiverem essa prova.

**3.1. A transação da guarda e os dois pools.**

- **A guarda é uma transação do Prisma sobre o pool de guarda.** A guarda do adendo 6 é uma transação única, em que o `COMMIT` solta as travas. A persistência do resultado precisa acontecer **dentro dela**. Se fosse por outra conexão, uma guarda que morre no meio da chamada deixaria M comitar e, depois, o resultado legível comitaria depois de t, contra G′(c).
  - Por isso a guarda é uma **transação interativa de um segundo PrismaClient**: o mesmo cliente filtrado por tenant (`prisma.db`), com `PrismaPg` sobre o pool de guarda.
  - **O prazo dela cobre tudo, e não só a chamada.** O `timeout` da transação interativa conta desde o `BEGIN` e desfaz pelo próprio processo, soltando as travas. Por isso ele é a soma explícita dos prazos internos, mais uma margem:
    - a espera das travas (`lock_timeout` de 5 s);
    - o registro (2 s para a conexão e 2 s de instrução) e a lápide;
    - a prova de vida;
    - o prazo do tipo;
    - a persistência (`statement_timeout`).

    O `maxWait` é de 5 s, a espera pelo pool cheio. Com um prazo menor, a guarda soltaria as travas no meio da chamada (no webhook, durante o DNS ou o TCP) sob carga normal, sem pausa de VM nenhuma.

  - Persistência, run, proposta, acerto da quota e auditoria passam pelo cliente dessa transação.
  - As travas e os `SET LOCAL` são as únicas instruções em SQL próprio, na exceção da seção 3.8.
  - O isolamento é `READ COMMITTED`, explícito: em `REPEATABLE READ`, a transição do passo 10 não enxergaria o registro, comitado depois do início da transação.
- **O pool de registro dá conexões curtas,** que não seguram trava nenhuma: cada uma faz uma transação curta e comitada (o registro do passo 5, ou a transição do passo 6) e volta.
  - **Esperar esse pool segurando as travas da guarda não gera espera circular,** porque quem ocupa uma conexão de registro a solta em milissegundos, sem depender de guarda nenhuma.
  - Pegar as duas conexões do mesmo pool, uma de cada vez, geraria espera circular: com o pool cheio de guardas esperando a segunda conexão, nenhuma começaria.
- **Prazos de sessão: uma guarda congelada não segura M para sempre.** O adendo 6 desligava `idle_in_transaction_session_timeout`. Com o processo da guarda congelado (pausa de VM, `docker pause`) ou o host sumido, M ficaria em 409 enquanto durasse o congelamento, ou até o keepalive padrão derrubar a conexão (cerca de 2 h). Agora:
  - `SET LOCAL idle_in_transaction_session_timeout` = o prazo do tipo + uma margem de 30 s;
  - `statement_timeout` na persistência;
  - keepalive TCP e `tcp_user_timeout` curtos na sessão.

  Uma guarda congelada além disso é derrubada pelo servidor. Isso é perda da guarda: as travas soltam, M segue, e o uso vira `in_doubt` (seção 3.3). **Sob G′ isso é seguro.** O limite real da espera de M passa a ser o prazo do tipo + a margem + a detecção do keepalive, da ordem de 2 min no pior caso.

**3.2. Ordem dos passos.** Antes de qualquer trava, o uso ganha **ids gerados na aplicação**:

- o do próprio uso, e com ele uma **trava própria do uso**: `hashtextextended('veyra.content_use:' || useId, 0)`;
- os do registro de origem que ainda não existe na hora do registro: o run da IA e a entrega do webhook (evento, webhook e tentativa). Assim o fluxo do ADR-031, em que o run nasce depois da chamada, não muda.

**A transação da guarda começa com os passos 1 a 4 do adendo 6, com três acréscimos:**

- `BEGIN` (`READ COMMITTED`) e os `SET LOCAL`, agora com os prazos da seção 3.1;
- a **trava própria do uso, exclusiva e tentada** (`pg_try_advisory_xact_lock`). O id é novo, então na prática ela sempre é obtida; como a chave de 64 bits divide o espaço com as travas de restrição, uma colisão é possível, e a tentativa que falha é tratada como "não começou". **Ninguém espera por ela, só a tenta**, por isso ela fica fora da ordem de deadlock. Ela é a prova de vida da guarda: alguém só a obtém quando a transação da guarda acabou;
- as travas dos níveis 1 a 3, compartilhadas, na ordem do 3.2 do adendo 6. Elas valem **mesmo com zero contatos**: o webhook de um deal ou tarefa sem contato segura o workspace e a entidade. Hoje o código pula a porta quando não há contato (`webhooks.service.ts`), e isso muda;
- a **reconferência**;
- um `SAVEPOINT`.

**Depois disso, os passos 5 a 8 do adendo 6 passam a 6 a 9, e o 9 (`COMMIT`) passa a 11. Os passos 5, 10 e 12 são novos:**

5. **Registro.** Numa conexão do pool de registro, obtida em até 2 s, numa transação própria com `SET LOCAL synchronous_commit = on` e `statement_timeout` de 2 s, nasce e **comita** o uso `authorized`. Os campos:
   - o id do uso;
   - workspace;
   - o **conjunto inteiro de travas** (contatos e entidades);
   - o tipo (geração de IA, despacho para a Meta ou entrega de webhook), com os ids do registro de origem (o run e a entrega pré-gerados, ou o despacho, que já existe);
   - na IA, os **metadados mínimos para criar o run** se o processo morrer: capacidade, modelo, versão do prompt, alvo, quem disparou e a descrição do contexto (só ids, dentro da minimização). Sem isso, o detector não conseguiria criar o run sem afrouxar o schema, e o §3.10 do CLAUDE.md exige esses dados em todo run;
   - as **reservas**: as duas da IA (`ai_runs` e `ai_cost_cents`) ou a quota do envio;
   - o id da instância;
   - `authorizedAt` e `deadlineAt`, pelo relógio do banco (ADR-049).

   **Se o registro falhar ou estourar o prazo, o uso não começa.** A conexão de registro é **destruída**, não devolvida ao pool. Ainda sob as travas, a guarda grava uma **lápide**:

   ```sql
   INSERT … VALUES ($id, …, 'aborted')
   ON CONFLICT (id) DO UPDATE SET status = 'aborted' WHERE content_use.status = 'authorized'
   ```

   - O índice único faz esse `INSERT` **esperar** um registro ainda em andamento (o caso do commit ambíguo, em que o cliente desistiu e o servidor ainda comitava).
   - Um registro que chegue depois da lápide falha por unicidade.
   - A guarda comita, e só então as reservas voltam.
   - **Se a própria lápide falhar** (`lock_timeout` estourado, sessão morta), o uso pode ficar `authorized`, e a reconciliação o marcará `in_doubt`, cobrado pelo teto, sem ter começado. É um falso positivo aceito sob G′, e fica declarado.

6. **Prova de vida** da sessão de guarda. **Se ela falhar,** o uso não começa. Numa transação curta do pool de registro, a transição condicional `authorized → aborted` é tentada, e as reservas voltam **na mesma transação**:
   - se afetou a linha, as reservas voltam;
   - se não afetou, M já marcou o uso `in_doubt`, e as reservas ficam cobradas pelo teto.
7. **Início** da operação externa, sem I/O entre a prova de vida e o início.
8. **Desfecho** dentro do prazo absoluto.
9. **Persistência,** sob o `SAVEPOINT`, pelo cliente da transação da guarda. **Se ela falhar,** volta-se ao `SAVEPOINT`, o que também desfaz o acerto da quota. O resultado é descartado, o run ou despacho fica `unknown_after_dispatch`, e as reservas são **cobradas pelo teto, na transação da guarda**. Sem isso, a varredura de reservas devolveria a reserva de uma chamada que aconteceu.
10. **O uso vira `concluded`,** em qualquer caso, por transição condicional, na transação da guarda. Isso vale também para o prazo estourado com a guarda viva: começou e terminou sob a trava, sem dúvida sobre a guarda.
11. **`COMMIT`,** que solta as travas.
12. **Se o `COMMIT` falhar,** ele pode ter comitado ou não. Noutra conexão, a decisão é tomada pela **transição condicional** `authorized → in_doubt` (`detectedBy: commit`), que espera a trava de linha de um `COMMIT` ainda em andamento, e não por um `SELECT`:
    - se afetou a linha, é perda da guarda;
    - se não afetou, o uso já está `concluded` (comitou) ou `in_doubt` (outro detector chegou antes);
    - se o uso não existe, vira `in_doubt` com `missing_record`.

**Por que essa ordem:**

- **Registro depois das travas e da reconferência.** Antes, M poderia marcar como em dúvida um uso que ainda seria recusado, e o incidente seria falso.
- **Registro antes da prova de vida.** Depois dela, seria I/O entre a prova e o início, contra o passo 7.
- **Morte do processo entre o registro e o início** gera um `in_doubt` que, de fato, não começou. Isso é aceito: `in_doubt` quer dizer "pode ter começado".
- **Só a perda da guarda deixa um uso `authorized` depois que as travas soltam.** Ela vem da sessão morta, derrubada pelos prazos da seção 3.1, ou do processo morto. Todo desfecho que o processo vivo decide é escrito por ele: `aborted` nos passos 5 e 6, `concluded` no passo 10.
- **Um teste fixa a ordem dos passos.**

**Alternativa rejeitada: travas de sessão (`pg_advisory_lock_shared`) com transações curtas,** em que o commit do registro seria a própria prova de vida. Exige destravar explicitamente e limpar a conexão ao devolvê-la ao pool, e uma trava esquecida bloquearia M para sempre.

**3.3. Estados, transições e quem marca `in_doubt`.**

**Estados.** Um uso nasce `authorized` e termina em um destes estados finais: `concluded`, `aborted` (decidido antes de começar) ou `in_doubt`.

- **Toda transição é condicional:** `UPDATE … WHERE status = 'authorized'`.
- **Fora da guarda viva, a linha do uso muda primeiro.** Nos detectores e nos passos 6 e 12, o registro de origem e as reservas só mudam se a transição do uso afetou uma linha. Isso evita cobrança dupla e deadlock entre dois detectores no mesmo órfão. **Dentro da guarda viva** (passos 9 e 10) a ordem é a inversa: a persistência vem antes e o `concluded` depois, porque o `SAVEPOINT` desfaria o `concluded` se a persistência falhasse.
- **Conclusão tardia:** a conclusão que encontra `in_doubt` não sobrescreve o estado. Ela descarta o resultado e registra a tentativa **na auditoria**, que é o indício de que a chamada pode ter começado depois de t. No webhook, isso não pode ser uma linha de `WebhookDelivery`: a unicidade por tentativa a recusaria.

**Detectores.** Só marca `in_doubt` quem tem prova de que a guarda acabou. A marcação mora dentro da primitiva do Core que pega as travas, então um M de vertical nunca toca nas tabelas de run, despacho ou reserva.

- **O próprio processo,** quando o `COMMIT` da guarda falha (passo 12). É o antigo `guard_lost` do adendo 6.
- **A mudança por contato ou por entidade (M).**
  - Com as travas exclusivas dos contatos e, na troca de contato de deal ou tarefa, a da entidade, um uso ainda `authorized` cujo conjunto de travas contém um desses contatos ou entidades é necessariamente órfão, porque uma guarda viva seguraria a trava compartilhada.
  - M o marca na mesma transação. A detecção acontece no instante da mudança.
  - A busca é feita depois das travas, em `READ COMMITTED`, e enxerga todo registro comitado.
- **A mudança do workspace inteiro (ativar e desativar).** Com a trava exclusiva do workspace, todo uso `authorized` do workspace é órfão e é marcado na mesma transação.
- **A reconciliação.**
  - **O prazo só escolhe candidatos** (`deadlineAt` vencido).
  - **Para cada candidato,** numa transação própria, ela tenta **só a trava própria do uso** (`pg_try_advisory_xact_lock`). Consegue se, e somente se, a transação da guarda acabou.
  - **Conseguiu:** marca `in_doubt`, por transição condicional.
  - **Não conseguiu:** a guarda está viva. Ela não marca e tenta de novo na próxima rodada; os prazos de sessão da seção 3.1 limitam quanto isso dura.
  - **O que isso resolve:** nunca marca um uso vivo, com ou sem contato, nem o de outra instância. E não sofre inanição, porque usos vivos do mesmo contato não seguram a trava deste uso.
  - **`deadlineAt`** é `authorizedAt` + o prazo do tipo + uma margem fixa de 30 s. Como é só filtro, a margem não sustenta a garantia.

**3.4. A varredura.** É um job periódico (pg-boss, respeita `DISABLE_JOBS`) mais uma execução assíncrona logo depois da subida.

- A execução da subida não bloqueia o boot, que não depende do banco (ADR-049).
- O limite de tempo da seção 3.7 vale enquanto houver ao menos uma instância com jobs de pé; sem nenhuma, a detecção acontece na próxima subida.
- **Retenção:** o mesmo job expurga os usos `concluded` e `aborted` depois de 30 dias. Os `in_doubt` ficam pela retenção da auditoria. O registro guarda só ids, nunca conteúdo (minimização).

**3.5. Durabilidade.** O registro comita com `synchronous_commit = on`, explícito.

- **Premissa:** um failover do banco não perde transação comitada, o que exige replicação síncrona. Hoje não há réplica. A premissa vai para `docs/DEPLOY_STAGING.md` como condição de qualquer réplica.
- **Fora da premissa:** se o registro se perder e o processo sobreviver, o passo 12 ou a conclusão tratam o uso como `in_doubt` com `missing_record`. Se o processo também morrer, o caso não é detectado. É o limite declarado.

**3.6. Mapeamento com o adendo 6.**

- **`guard_lost` passa a ser este `in_doubt`:** um estado só, qualquer que seja o detector. O evento de auditoria é um só, `content_use.in_doubt`, só com ids, e leva `detectedBy`: `commit`, `change`, `workspace_change`, `reconciliation` ou `missing_record`.
- **Registro de origem.** Quem marca o deixa no estado incerto, na mesma transação, por transição condicional e só se a do uso afetou a linha:
  - **o despacho da mensagem,** que já existe, vai para `unknown_after_dispatch` e nunca é reenviado;
  - **o run da IA** é **criado** com o id pré-gerado e os metadados do registro, já `unknown_after_dispatch`, se ainda não existir. O estado entra em `AiRunStatus` por migration aditiva, se ainda não existir;
  - **a entrega de webhook** é **criada** com o id pré-gerado, como falha incerta, se ainda não existir. A retentativa pelo outbox é um uso novo, que passa pela guarda; depois de uma restrição, é recusada.
- **Reservas** (as do registro).
  - A varredura de reservas **não devolve** reserva ligada a um uso `authorized`.
  - Quem marca `in_doubt` cobra as reservas pelo teto na mesma transação: as duas da IA, ou a quota do envio.
  - Se uma reserva já tiver sido expurgada, a cobrança vai pelo caminho acima do teto (adendo 6 §5).

**3.7. O que a detecção garante.** Todo uso autorizado chega a um estado final — `concluded`, `aborted` ou `in_doubt` — dentro da premissa da seção 3.5, mesmo que o processo morra e não volte:

- quando M ou a mudança do workspace acontecem, no instante delas;
- sem elas, no máximo em `deadlineAt` + o período da varredura depois que a guarda de fato acabou, desde que haja instância com jobs de pé (seção 3.4). Os prazos de sessão da seção 3.1 limitam quanto uma guarda congelada demora a acabar.

**O que ela não garante:** `in_doubt` quer dizer "pode ter começado depois de t", não "começou". O banco não tem como saber.

**3.8. Exceção ao §3.3 do CLAUDE.md, índices e custo.**

**A exceção.** A coordenação de restrição já tinha SQL próprio (`lockContactsForRestriction`, adendo 6 §3.1). Passam a ser SQL próprio também:

- as travas, os `SET LOCAL` e o `SAVEPOINT` da transação da guarda;
- o `INSERT` do registro, a lápide e a transição do passo 6 (com a devolução das reservas), pelas conexões `pg` dos dois pools;
- a transição condicional do passo 12;
- a trava tentada da reconciliação;
- a **busca de candidatos da reconciliação**, que é **cross-workspace por definição**. É um job cross-workspace e usa `prisma.raw`, como o §3.3 permite para esses jobs.

As transições de run, despacho e reserva, inclusive dentro da transação de M, passam pelo cliente filtrado. **Toda escrita** leva `workspaceId` explícito, inclusive a da reconciliação, que escreve por candidato, com o workspace dele. Um teste estático confere as escritas. A única leitura sem workspace é a busca de candidatos, nomeada aqui.

**Índices:**

- `(deadlineAt) WHERE status = 'authorized'`, parcial, para a varredura cross-workspace (o Postgres 17 não tem _skip scan_);
- `(workspaceId, status)` para a busca de M e da mudança do workspace.

**Custo:**

- uma tabela nova, tenant-scoped, com migration aditiva e entrada em `WORKSPACE_MODELS`;
- um segundo PrismaClient sobre o pool de guarda e um pool pequeno a mais, o de registro;
- um commit síncrono a mais por uso externo, antes da chamada;
- uma varredura no relógio do banco, com expurgo.

#### 4. Testes que o critério exige

- **Processo morto depois do registro e antes do envio, com reinício:** a reconciliação marca `in_doubt` e audita, sem M concorrente. O run da IA é criado com o id pré-gerado, como incerto.
- **Guarda perdida com M concorrente:** M marca o órfão na mesma transação, e o resultado tardio é descartado sem sobrescrever o `in_doubt`.
- **Troca de contato de deal sem contato:** M marca o órfão pela trava da entidade.
- **Guarda perdida com ativação ou desativação concorrente:** a mudança do workspace marca todos os órfãos do workspace.
- **Guarda viva com prazo vencido, congelada por menos que os prazos de sessão:** a reconciliação **não** marca, inclusive no webhook **sem contato**, e o uso termina `concluded`.
- **Guarda congelada além dos prazos de sessão:** o servidor derruba a sessão, M segue, e o uso vira `in_doubt`.
- **Órfão com outro uso vivo no mesmo contato:** a reconciliação marca o órfão, sem inanição.
- **Persistência falha com a guarda viva:** o uso termina `concluded`, o run fica `unknown_after_dispatch` e as reservas ficam cobradas pelo teto, sem `in_doubt` falso.
- **A guarda gasta todos os prazos de antes da chamada mais o prazo inteiro do tipo** e termina `concluded`, sem que a transação expire.
- **A persistência roda na conexão da guarda:** com a guarda morta no meio da chamada, nenhum resultado legível comita.
- **Registro com commit ambíguo:** a lápide espera o registro e o uso termina `aborted`. Um registro atrasado falha por unicidade, e as reservas voltam uma vez, sem cobrança.
- **Prova de vida falha depois do registro:**
  - sem M: o uso vira `aborted` e as reservas voltam;
  - com M antes: o uso fica `in_doubt` e as reservas ficam cobradas.
- **`COMMIT` da guarda falha:**
  - a transição condicional afetou a linha: vira `in_doubt`;
  - não afetou: fica `concluded` ou o `in_doubt` de outro detector;
  - o registro não existe: vira `in_doubt` com `missing_record`.
- **Dois detectores no mesmo órfão:** uma só cobrança, sem deadlock.
- **N usos simultâneos, com N ≥ o tamanho de cada pool:** todos começam ou recusam dentro do prazo, sem espera circular.
- **Varredura na subida:** roda sem bloquear o boot e respeita `DISABLE_JOBS`. O expurgo respeita os 30 dias e não toca em `in_doubt`.
- **Reservas:** não são devolvidas enquanto o uso está `authorized`, e as duas da IA são cobradas pelo teto quando ele vira `in_doubt`.
- **Depois de t:** leitura, aprovação e envio novos são recusados.
- **Ordem dos passos:** um teste fixa trava do uso → travas de restrição → reconferência → registro → prova de vida → início, sem I/O entre a prova e o início.
- **Teste estático:** `workspaceId` explícito em toda escrita das peças da seção 3.8.
- **Prova por mutação** de cada peça:
  - registro depois da prova de vida, ou sem registro;
  - sem a trava própria do uso, ou com a reconciliação tentando as travas de contato;
  - persistência fora da transação da guarda;
  - lápide trocada por `UPDATE`;
  - sem a marcação por M, por entidade ou pela mudança do workspace;
  - transição não condicional;
  - origem ou reserva mudando antes da transição do uso, fora da guarda viva;
  - estado final escrito depois do `COMMIT`;
  - sem os prazos de sessão;
  - sem a varredura na subida.

#### 5. Opções para a revisão

1. **G′ como revisado aqui** (recomendado; direção aceita pela revisão), sobre o mecanismo do adendo 6, com a seção 3 e os testes da seção 4.
2. **Reduzir o alcance com a proibição** da liberação de IA em workspace com o Clinics. **Não aprovada pela revisão de 2026-10-20.** Fica como opção a avaliar com alguém da clínica (D6), se a liberação para fornecedores tiver pouco valor real.
3. **G estrita, com a espera restrita aos órfãos.** Com o registro da seção 3, M só precisa esperar quando há um uso órfão nos contatos dela. O órfão se resolve de três jeitos:
   - quando o processo dele conclui;
   - quando a instância dele comprovadamente reiniciou (pelo id da instância no registro);
   - por confirmação da operação.

   Enquanto isso, a mudança fica pendente. Para não autorizar usos novos nesse meio-tempo, ela precisaria ser dividida em "pendente", que já recusa autorizações, e "efetiva".

   **A exposição física é a mesma de G′:** o órfão pode ter começado depois do clique de quem restringiu. O que muda é o instante em que o sistema declara a restrição efetiva. O custo é a restrição pendente, por tempo indeterminado, nos casos de perda da guarda, e uma mudança em dois tempos na interface e nos serviços.

#### 6. Recomendação

**Opção 1.** A opção 3 não reduz o que sai para o destino: ela muda só quando a restrição é declarada, ao custo de pendências sem prazo. Com a aprovação deste texto, o adendo 6 é implementado com os acréscimos da seção 3:

- a guarda como transação do Prisma sobre o pool de guarda, com a persistência dentro dela e prazos de sessão;
- os ids pré-gerados e a trava própria do uso;
- o registro durável no pool de registro, antes da prova de vida, com a lápide;
- o estado final escrito antes do `COMMIT`;
- as transições condicionais, com a linha do uso mudando primeiro;
- a marcação por M (contato e entidade), pela mudança do workspace e pela reconciliação com a trava do uso;
- o mapeamento de `guard_lost`, do run ou despacho e das reservas;
- a retenção dos registros.

O B2 só volta para decisão com o critério implementado, os testes da seção 4, a bateria completa verde e os passes de `security` e `reviewer`.

#### 7. Implementação — G1, a fundação da guarda (2026-10-20)

A implementação foi dividida em quatro subentregas, cada uma com commit, bateria e revisão:

- **G1:** a fundação da guarda, sem consumidor ligado;
- **G2:** as mudanças e as aprovações;
- **G3:** os três usos;
- **G4:** a bateria de cenários uso × mudança, a verificação de transição (despachos anteriores à G3.2, com cobertura limitada) e a revisão final de segurança.

O B2 só volta para decisão depois da G4.

**O que a G1 entrega** (`apps/api/src/content-use/`):

- **Tabela `ContentUse`:** tenant-scoped, com migrations aditivas e entrada em `WORKSPACE_MODELS`. Guarda só ids. No registro, `authorizedAt` e `deadlineAt` vêm do relógio do banco. A lápide e o `missing_record` gravam o `deadlineAt` pelo relógio do Node, mas são estados finais, que nada compara com `now()`.
- **A primitiva única de travas** (`restriction-locks.ts`), na ordem do adendo 6 §3.2. As chaves de contato e de entidade levam o workspace, e a trava própria do uso é só tentada, inclusive pela guarda que a cria.
- **Os dois pools:**
  - **guarda:** um segundo PrismaClient, com o mesmo filtro de tenant do `prisma.db`, keepalive TCP curto e `application_name = veyra-guard`;
  - **registro:** `pg`, com `synchronous_commit = on`, `statement_timeout`, `idle_in_transaction_session_timeout` de dois prazos de instrução e o mesmo keepalive.
- **A guarda** (`ContentUseGuard.executar`), com os passos da seção 3.2:
  - todo prazo de sessão vem antes da primeira trava: `idle_in_transaction_session_timeout` (prazo do tipo + margem), `lock_timeout` por trava e um `statement_timeout` acima do `lock_timeout`;
  - a trava do uso, as travas de restrição e a reconferência com prazo próprio, na transação da guarda;
  - o `SAVEPOINT`, o registro comitado, as duas conferências do orçamento, a prova de vida e o início;
  - a persistência e o `concluded` sob as travas;
  - o passo 12 por transição condicional.
- **Os detectores** (`UsosOrfaos`):
  - M por contato e por entidade, e a mudança do workspace inteiro;
  - o próprio processo, quando o `COMMIT` falha, quando o registro sumiu, ou quando a chamada passou do prazo sem responder;
  - a reconciliação, pela trava do uso.

  Todos usam transição condicional: a linha do uso muda primeiro, e só então vêm as reservas pelo teto, a origem incerta (pelos tratadores que a G3 registra) e o incidente `content_use.in_doubt`.

- **A reconciliação:** roda a cada minuto e uma vez depois da subida, assíncrona e sujeita a `DISABLE_JOBS`. Pagina pelo cursor (`deadlineAt`, `id`), para que guardas vivas com prazo vencido não escondam os órfãos que vêm depois. Cada candidato é examinado no workspace dele, pelo client filtrado, numa transação própria, com `lock_timeout`, `statement_timeout` e prazo de transação explícitos. Um candidato que falha (linha presa além do prazo, tratador de origem com defeito) é contado, registrado no log e deixado para a rodada seguinte, sem parar os que vêm depois.
- **A retenção:** `concluded` e `aborted` saem depois de 30 dias. `in_doubt` fica pela retenção da auditoria e depois sai também. Os dois expurgos comparam o `authorizedAt`.
- **A varredura de reservas:** trava cada reserva antes de contar os usos (`FOR UPDATE SKIP LOCKED`) e não devolve reserva de uso `authorized`. Uma reserva presa por outra transação (um registro em andamento, que a prende com `FOR SHARE` até o commit, ou o acerto da persistência) é pulada e volta na rodada seguinte; esperar por ela seguraria a varredura inteira. Cada reserva tem a sua transação, e a falha de uma não para as outras. O registro recusa se alguma reserva do uso já não existe.
- **O 55P03 vira 409** ("Uso em andamento para este contato; tente de novo em instantes.").

**Desvios do texto aprovado, todos para o lado conservador:**

- **Índice:** `(status, deadlineAt)` no lugar do índice parcial `(deadlineAt) WHERE status = 'authorized'`. O Prisma não modela índice parcial, e ele apareceria como drift. Para a busca da varredura (`status = 'authorized' AND deadlineAt < now()`) o efeito é o mesmo.
- **Só o `INSERT` do registro é SQL próprio** (seção 3.8). A lápide, a transição do passo 6 e a do passo 12 passam pelo client filtrado, com `workspaceId` explícito:
  - a lápide é um `createMany` com `skipDuplicates` (que vira `INSERT … ON CONFLICT DO NOTHING` e espera um registro ainda em andamento pelo índice único), seguido da transição condicional. Um registro que chega depois da lápide esbarra nela pelo índice único (23505);
  - o passo 6 e o passo 12 rodam no pool principal, com prazos explícitos (`prazosDaRecuperacao`): `lock_timeout` igual ao de trava da guarda (5 s na produção), `statement_timeout` acima dele e prazo de transação que cobre a instrução que esperou mais as seguintes. Sem eles valeriam os padrões do Prisma (5 s), iguais à espera de trava.

  Quando eles rodam, a transação da guarda já terminou e não segura trava nenhuma, então não há espera circular.

- **A recuperação nunca lança depois do registro.** Sem conseguir decidir no passo 6 ou no passo 12 (pool cheio, linha presa, prazo), o resultado é `em_duvida`: o uso fica `authorized` e a reconciliação decide pela prova.
- **O passo 6 e o passo 12 reconhecem o que a própria guarda já escreveu.** O `COMMIT` pode chegar ao banco e o cliente ver erro:
  - um `aborted` por prazo já gravado vale como `aborted`, com o motivo `prazo` e sem devolver as reservas de novo, porque elas voltaram no mesmo commit;
  - um `in_doubt` por `overran_deadline` já gravado não vira "conclusão tardia", porque a guarda não estava concluindo;
  - se o `COMMIT` do `overran_deadline` não chegou, o passo 12 marca com o mesmo detector.
- **A reconciliação escreve pelo client filtrado,** no workspace de cada candidato. Fora de `content-use/`, a única outra leitura de `ContentUse` por `raw` é a da varredura de reservas, com `workspaceId` explícito. Dentro, só duas operações usam `raw`, as duas cross-workspace por definição: a busca de candidatos e o expurgo de retenção. Testes estáticos fixam as três pelo nome da função, junto com o registro.
- **O SQL de coordenação vai ao banco reconstruído do modelo.** O Prisma executa o `text` do objeto que recebe, e um objeto forjado poderia trazer as partes de texto de um modelo e o `text` de outro SQL. O filtro confere as partes de texto e exige um parâmetro simples por lacuna (texto ou número; um `Prisma.Sql` como valor seria emendado no texto). Depois, monta um `Prisma.Sql` novo com eles.
- **A reconferência recebe a transação da guarda:** a porta lê sob as travas, com o prazo próprio `reconferenciaMs`. Estourado, o uso não começa (`indisponivel`).
- **Falha de registro:**
  - a lápide e a devolução das reservas acontecem na mesma transação da guarda, sem janela entre as duas;
  - se a própria lápide falhar, nada volta na hora, porque o registro pode ter comitado `authorized`. Nesse caso, a reconciliação cobra pelo teto se o registro existe, e a varredura de reservas devolve se ele não existe.
- **Chamada que passa do prazo:** o sinal aborta no prazo absoluto do tipo. Se a chamada não responder mais 1 s depois, ela ainda pode começar após a restrição. O próprio processo marca o uso `in_doubt` na transação da guarda, com o detector `overran_deadline`, e a resposta tardia é ignorada. É uma migration aditiva, que acrescenta o valor ao enum.
- **Orçamento do prazo da transação** (`orcamentoDaGuarda`, função pura):
  - o trecho comum, até o registro: cada trava com o seu `lock_timeout`, a reconferência e o registro (conexão e instrução);
  - depois, o maior de dois caminhos: o da lápide, ou o da prova de vida (o seu `statement_timeout`), da chamada com a folga de desistência e da persistência;
  - a folga.

  A guarda confere o que resta duas vezes: antes da prova de vida e logo depois dela, só pelo relógio, sem instrução nenhuma entre a prova e o início. Se não bastar, o uso vira `aborted` com o motivo `prazo` na própria transação da guarda, ainda sob as travas, com a devolução das reservas. Soltar as travas antes de escrever deixaria uma mudança achar o uso `authorized` e marcá-lo em dúvida sem ele ter começado.

- **A persistência tem uma janela, não um prazo por instrução.** O `statement_timeout` vale por instrução, e o orçamento conta `persistenciaMs` uma vez. Uma persistência de várias instruções que passe disso (inclusive o caminho de `persistenciaFalhou`) faz a transação expirar, e vale o passo 12: o uso termina `in_doubt`. A G3 dimensiona a persistência de cada uso dentro dessa janela.
- **A reserva já varrida não é cobrada acima do teto pelos detectores.** A varredura pula as reservas de uso `authorized`, e o registro recusa reserva que não existe, então a reserva de um uso que vira `in_doubt` não pode ter sido varrida. Se faltar, fica um aviso no log para investigação. A cobrança acima do teto continua valendo no acerto da persistência, na G3.

  **Contrato da G3:** essa premissa vale só se o consumidor nunca devolver nem acertar reserva fora da guarda. Depois de entregar as reservas a `executar`, o consumidor só as toca dentro de `persistir` ou `persistenciaFalhou`.

- **"Só ids" por formato:** contatos, reservas e ids de origem são uuids, e as entidades são `deal:<uuid>` ou `task:<uuid>`. As chaves de `origem` e dos metadados do run são nomes curtos. Os valores de texto dos metadados são identificadores, sem espaço (versão, modelo, capacidade). `/` vale, para ids de modelo, e `@` só como sufixo de versão numérico (`modelo@2026-10`), então um e-mail não passa. Isso recusa texto livre com espaço e e-mail, mas um dado pessoal de uma palavra só (um nome, um telefone, um CPF) ainda passa no formato. Por isso a G3 fecha, por tipo de uso, as chaves aceitas e o formato ou o catálogo dos valores de cada chave. Um uso recusado pela validação não começa, e as reservas dele voltam na hora.
- **Exceção inesperada no meio da guarda** (um defeito):
  - antes do registro: as reservas voltam;
  - entre o registro e o início: o uso vira `aborted`;
  - depois do início: vale o passo 12.
- **Quando o processo vivo não escreve o desfecho.** Com a guarda viva, todo desfecho é escrito na transação dela. Perdida a guarda, o processo tenta decidir noutra conexão. O uso fica `authorized`, e a decisão passa à reconciliação, em três casos:
  - a lápide falhou depois de um registro ambíguo;
  - o passo 6 ficou sem resposta;
  - o passo 12 ficou sem resposta.
- **`finishedAt`:** é informativo e escrito pelo Node. A retenção compara o `authorizedAt`, que é do banco (ADR-049).

**Testes** (dados fictícios, operação falsa). As falhas são determinísticas: pontos de teste param a guarda onde a falha precisa acontecer, e uma conexão observadora derruba a sessão, segura travas ou confere o banco. Nenhum teste depende de sono fixo para vencer um prazo de banco; os sonos que restam só consomem o orçamento da própria guarda.

- **Integração (47):** cobrem todas as falhas da seção 4 que já se aplicam sem consumidor.
  - **Caminho feliz e ordem:**
    - o registro está comitado e visível de outra conexão no instante do início;
    - a ordem dos passos;
    - a última instrução da sessão da guarda antes do início é a prova de vida (`pg_stat_activity`).
  - **Antes do registro:** reconferência restrita; trava ocupada por mudança; "só ids", com texto livre ou chave inválida recusados antes de qualquer trava.
  - **Registro:**
    - falha de registro e commit ambíguo;
    - registro ainda comitando, com a lápide esperando e prova pelo `pg_xact_status` de que ele comitou;
    - registro atrasado, que esbarra na lápide com 23505;
    - reserva varrida antes do registro;
    - varredura de reservas no meio do registro, que pula a reserva presa sem esperar (`FOR SHARE` × `SKIP LOCKED`).
  - **Lápide que falha:** depois de um registro que comitou (a reconciliação cobra) e depois de um que não comitou (a varredura devolve, uma vez).
  - **Orçamento:**
    - prazo insuficiente antes da prova, com uma mudança esperando, que não acha nada para marcar;
    - prova de vida lenta, recusada pela segunda conferência;
    - o `COMMIT` do `aborted` por prazo que falha, e o que chega ao banco com erro no cliente;
    - fumaça: os prazos internos consumidos quase inteiros (a prova da soma é o teste de unidade).
  - **Prova de vida que falha:** sozinha, ou com M antes.
  - **Persistência:**
    - falha com a guarda viva, por exceção e por erro de banco (o `SAVEPOINT` desfaz o resultado e o acerto da quota);
    - acontece na conexão da guarda.
  - **Depois do início:**
    - `COMMIT` da guarda falha;
    - passo 12 com registro perdido (`missing_record`), com `COMMIT` que comitou mas deu erro no cliente, com linha presa sem resposta, e com falha de outro tipo (sem lançar);
    - chamada que passa do prazo sem responder (`overran_deadline`), inclusive com o `COMMIT` perdido, que chegou ou não chegou ao banco, e com a guarda perdida antes de marcar e M marcando primeiro.
  - **Detecção:**
    - processo morto depois do registro, com a auditoria;
    - guarda viva com prazo vencido, sem contato;
    - guarda congelada além dos prazos de sessão, com a conclusão tardia;
    - órfão com outro uso vivo no mesmo contato; paginação da reconciliação;
    - candidato com a linha presa e candidato com tratador de origem com defeito, sem parar os seguintes;
    - M por contato e por entidade, e a mudança do workspace;
    - dois detectores no mesmo órfão, os dois em voo ao mesmo tempo: uma cobrança, uma origem incerta, um incidente.
  - **Validação:** texto livre, e-mail e chave inválida recusados, com as reservas devolvidas; id de modelo com `/` e `@<versão>` aceito.
  - **Outros:**
    - N usos acima do tamanho dos pools;
    - reserva de uso `authorized` preservada;
    - retenção dos três estados;
    - SQL cru no client protegido, inclusive um objeto forjado e um valor emendado.

  Os testes que dependem de terminar dentro do prazo do registro têm uma janela de cerca de 800 ms (o prazo de instrução do registro nos testes). Se a janela for perdida, o teste falha de forma visível e não passa em silêncio.

- **Unidade e estáticos (16):**
  - a lista fixa de modelos de coordenação (10);
  - a liberação só pelo texto;
  - a reconstrução do SQL;
  - o orçamento contra o pior caso de cada fase, escrito à parte da implementação, em quatro configurações, uma delas com a lápide dominando;
  - a ordem dos prazos da recuperação e da reconciliação com os padrões da produção;
  - o 55P03 → 409;
  - a varredura na subida, que não espera nem derruba;
  - `workspaceId` em toda escrita, salvo as exceções nomeadas;
  - o SQL próprio e o `raw` só nas funções das exceções nomeadas; fora de `content-use/`, em todo o `src`, só a leitura da varredura de reservas;
  - os pools da guarda só dentro de `content-use/`;
  - as chaves de restrição só na primitiva.
- **Mutação:** cada uma das 33 abaixo faz pelo menos um teste falhar, e todas compilam: uma mutação que só quebra a compilação não prova nada, e as duas que caíram assim foram refeitas.
  - **Registro e lápide:**
    - registro que falha sem impedir o envio;
    - registro que não confere as reservas;
    - registro sem `FOR SHARE`;
    - lápide sem a transição condicional;
    - lápide que falha e devolve as reservas;
    - registro perdido sem recriar o uso.
  - **Prova de vida, chamada e persistência:**
    - instrução entre a prova de vida e o início;
    - sem a segunda conferência do orçamento;
    - `aborted` por prazo escrito fora da transação da guarda;
    - guarda que não desiste da chamada no prazo;
    - sem `SAVEPOINT`.
  - **Orçamento:** sem a reconferência, sem a persistência ou sem a prova de vida.
  - **Recuperação:**
    - recuperação que lança;
    - transação de recuperação com o prazo padrão;
    - passo 6 que ignora o `aborted` já gravado;
    - passo 6 que perde o motivo `prazo`;
    - `overran_deadline` com conclusão tardia falsa;
    - `overran_deadline` marcado como `commit`;
    - `pendente` só depois da escrita.
  - **Detecção e reconciliação:**
    - origem incerta antes da transição condicional;
    - reconciliação sem a prova da trava;
    - reconciliação sem isolar o candidato;
    - cursor parado na paginação.
  - **Varredura de reservas:**
    - varredura que devolve reserva de uso `authorized`;
    - varredura sem `FOR UPDATE`;
    - varredura que espera a reserva presa, sem `SKIP LOCKED`.
  - **SQL cru:** o hook que passa adiante o objeto recebido; valor emendado aceito.
  - **"Só ids":** texto livre aceito nos metadados; `@` sem restrição; uso inválido que não devolve as reservas.

  Antes, na primeira rodada da G1, já faziam falhar o teste correspondente: lápide trocada por `UPDATE`, persistência fora da transação da guarda, transição não condicional e ausência dos prazos de sessão.

- **Defeitos que só os testes e as revisões acharam:**
  - Com o `statement_timeout` igual ao `lock_timeout`, o Postgres dispara o 57014 antes do 55P03, e uma trava ocupada deixava de ser reconhecida como "não começou". O prazo de instrução passou a ser o dobro do de trava, e o 57014 na aquisição das travas também conta como trava.
  - O filtro de SQL cru conferia as partes de texto, mas o Prisma executa o `text` do objeto recebido. Agora o SQL é reconstruído.
  - Os passos 6 e 12 usavam os prazos padrão do Prisma e podiam lançar exceção depois do início. Agora têm prazos explícitos e nunca lançam.
  - A reconciliação parava inteira num candidato preso ou com defeito. Agora tem prazos explícitos e isola cada candidato.
  - O `aborted` por prazo era escrito depois de soltar as travas.
  - Um `COMMIT` ambíguo depois do `aborted` por prazo virava `em_duvida`, e depois do `overran_deadline` virava uma conclusão tardia falsa.
  - A varredura de reservas esperava, com o prazo padrão, uma reserva presa por outra transação.
- **Risco aceito:** um registro atrasado com reservas pode entrar em deadlock com a lápide. O registro espera o índice da lápide, e a devolução da lápide espera o `FOR SHARE` do registro. O Postgres desfaz uma das duas, e os dois desfechos ficam consistentes:
  - se cai o registro, a lápide segue, com o `aborted` e as reservas devolvidas;
  - se cai a lápide, o uso fica sem desfecho escrito (`registro_incerto`), o registro comita `authorized` sem a chamada ter começado, e a reconciliação o marca `in_doubt` e cobra pelo teto. É o falso positivo conservador da lápide que falha.

#### 8. Implementação — G2, as mudanças e as aprovações (2026-10-20)

A G1 foi publicada (`8b609de`, quatro jobs do CI verdes). A G2 leva todas as mudanças de restrição e as aprovações para a mesma primitiva de travas, como pede o adendo 6 §6. Os três usos continuam desligados até a G3. O B2 segue fechado.

**A primitiva das mudanças** (`MudancasDeRestricao`, em `apps/api/src/content-use/`). Fora da guarda, ela é o único caminho para as travas de restrição, e a marcação dos usos órfãos mora dentro dela (adendo 7 §3.3). Assim, uma mudança de vertical nunca toca nas tabelas de run, despacho ou reserva. Tem três operações:

- **`porContato`:** a trava do workspace compartilhada; as dos contatos e das entidades exclusivas, na ordem; e, na mesma transação, a marcação `in_doubt` (`change`) dos usos ainda `authorized` desses contatos e entidades.
- **`doWorkspaceInteiro`:** a trava do workspace exclusiva e a marcação (`workspace_change`) de todo uso `authorized` do workspace.
- **`paraAprovacao`:** a trava do workspace e as dos contatos compartilhadas, como um uso.

Cada operação fixa o próprio `lock_timeout`, que vale **por trava**. As mudanças interativas e as aprovações rodam na transação aberta pela própria primitiva (`naTransacaoInterativa`); a CLI usa o prazo dela:

| Tipo                                       | `lock_timeout` | Transação |
| ------------------------------------------ | -------------- | --------- |
| Mudança interativa por contato e aprovação | 10 s           | 30 s      |
| Ativar e desativar (CLI)                   | 90 s           | 120 s     |

Os valores vêm da configuração da guarda, para os testes usarem prazos curtos. Uma troca de tarefa pode esperar até seis travas, e a soma das esperas passaria do prazo da transação. Por isso o prazo vencido (P2028) também vira 409, como o 55P03, e a transação inteira é desfeita.

**Os caminhos:**

- **Criar paciente, conceder e revogar liberação** (Clinics): `porContato` no lugar da trava de linha do adendo 5. Criar paciente e conceder liberação conferem a existência do contato depois das travas: uma exclusão concorrente segura a mesma trava exclusiva, e a resposta é 404.
- **Excluir contato:** `porContato` antes da trava de linha. A trava de linha (`lockAndRead`) continua, no nível 4, para serializar duas exclusões e a cota de contatos.
- **Trocar o contato de deal:** os contatos antigo e novo e a entidade `deal:<id>`. Sob as travas, o deal é relido; se o contato mudou entre a leitura e as travas, a resposta é 409 "tente de novo", sem efeito. O contato novo também é conferido sob a trava exclusiva dele.
- **Trocar o contato ou o deal de tarefa:** os contatos que o evento da tarefa resolve antes e depois da troca (o da tarefa e o do deal dela, a mesma regra de `resolveEventSubjects`) e a entidade `task:<id>`, com a mesma releitura e a mesma conferência do contato e do deal novos.
- **Só o protocolo grava o titular.** O contato do deal e o contato e o deal da tarefa só entram na escrita quando a troca passou pelas travas. Um PATCH que repete o valor de uma leitura velha (o formulário de deal sempre envia o contato) não o grava. Antes, ele desfaria, sem trava nenhuma, uma troca que comitou no meio, e um uso do deal começaria com o conteúdo de volta ao contato antigo. Achado pelas revisões de `security` e `reviewer` da G2.
- **Ativar e desativar:** a trava tentada de ativação vem primeiro (exclusão mútua entre CLIs, antes do nível 1, adendo 6 §3.2), depois `doWorkspaceInteiro`. A desativação passa a expirar o conteúdo de IA do workspace depois do commit, como a ativação já faz. O 55P03 vira uma mensagem clara na CLI, sem efeito.
- **Aprovações** (`executeSendMessage`, `executeCreateTask`): `paraAprovacao` no lugar de `lockContactsForRestriction`. A reconferência continua sob as travas. O claim da proposta continua impedindo dupla execução, e aprovações do mesmo contato deixam de ser seriais entre si.
- **`lockContactsForRestriction` sai do código.** Nenhuma trava de restrição toca mais a linha do contato, e o `updatedAt` deixa de ser reescrito (adendo 6 §8).
- **Remover empresa:** trava as linhas dos contatos da empresa em ordem de id antes do lote (nível 4). Isso paga a dívida registrada, que as aprovações já não podiam mais causar, porque deixaram de travar linhas.

**Desvios do texto aprovado, para o lado conservador:**

- **A troca do deal de uma tarefa também entra no protocolo.** O adendo 6 §6 cita a troca de contato. Mas o evento de tarefa responde também pelo contato do deal dela, então mudar o deal muda a quem o conteúdo pertence.
- **A troca concorrente da mesma entidade responde 409** em vez de tentar de novo. As travas não podem ser pegas fora de ordem depois da releitura, e repetir a transação inteira esconderia uma corrida rara que a pessoa resolve repetindo.
- **As aprovações esperam 10 s**, o prazo das mudanças interativas, e não os 5 s de um uso: são interativas como elas.
- **A marcação na ativação roda numa transação `raw`.** A ativação é rotina administrativa fora de sessão, com `workspaceId` explícito em toda escrita. Os detectores e os tratadores de origem já escrevem com o workspace explícito, e a G3 mantém essa regra.

**Religação de conversa** (adendo 6 §9, regra aprovada): um teste estático fixa que o contrato de atualização da conversa não tem `contactId` e que nenhuma escrita em `Conversation` muda o contato.

**Requisitos que a G2 deixa para a G3:**

- **O uso de tarefa trava também `deal:<dealId>`** (e, em cadeia de automação, a entidade raiz). O evento de tarefa responde pelo contato do deal dela. Um deal sem contato que ganha um contato pega esse contato e `deal:<id>` exclusivos. Se o uso da tarefa só segurasse o workspace e `task:<id>`, a troca não o esperaria, e a marcação por entidade não o alcançaria.
- **Os tratadores de origem escrevem com `workspaceId` explícito em todo `where` e `data`.** A ativação marca os órfãos numa transação `raw`. A G3 testa cada tratador numa transação `raw` com linhas de outro workspace presentes.
- **A validação fechada dos metadados do run** entra antes de ligar qualquer consumidor.
- **Pendência de exibição (nit do `reviewer`, sem efeito na garantia), resolvida na G3.1:** a atividade `task_completed` e a `deal_updated` usavam como alvo o contato do pedido ou da leitura feita antes da transação. Agora relêem a linha travada pela escrita.

**Testes** (dados fictícios; usos falsos sob a guarda real, com a porta real do Clinics na reconferência; quem espera quem é conferido em `pg_locks` e `pg_blocking_pids`, nunca por sono):

- **Integração, `clinics-restriction-changes` (25):**
  - **Uso primeiro**, para cada mudança (revogar, tornar paciente, excluir contato, trocar o contato do deal com o webhook sem contato no escopo, trocar o contato da tarefa, trocar o deal da tarefa, desativar): a mudança comprovadamente espera o uso; o uso termina `concluded` e a mudança comita depois.
  - **Mudança primeiro** (revogar, tornar paciente, excluir contato, trocar o contato do deal, ativar): o uso comprovadamente espera a mudança; depois do commit, ele reconfere e recusa sem chamar.
  - **Órfãos:** marcados pela mudança na mesma transação, pelo contato, pela entidade (deal sem contato) e pelo workspace inteiro; o de outro contato fica.
  - **Espera estourada:** revogar com um uso em andamento dá 55P03 (409 na rota), e a liberação continua; desativar dá a mensagem clara da CLI, e o Clinics continua ativo.
  - **Aprovação × ativação:** com a ativação primeiro, a tarefa não nasce; com a aprovação primeiro, a ativação espera. Duas aprovações do mesmo contato não se esperam, e o claim impede a dupla execução.
  - **Troca concorrente da mesma entidade:** 409, sem efeito. A troca do deal da tarefa, enquanto o contato do deal antigo muda, é vista pela releitura e responde 409.
  - **Só o protocolo grava o titular:** um PATCH de deal ou de tarefa com a leitura velha, enquanto outra troca comita, não a desfaz.
  - **Fumaça da ordem global:** mudança por contato, ativação, aprovação, troca de tarefa e uso concorrentes terminam sem deadlock, cada um com um desfecho previsto (o uso termina; as recusas são espera estourada, restrito ou proposta já revisada). É o único teste com um sono, para soltar o uso no meio; a prova da ordem é a dos testes determinísticos e a regra estática.
- **Adaptados:**
  - os testes do adendo 5 em `clinics-patients` passam a segurar as travas consultivas: a exclusiva do contato, como uma mudança, ou a compartilhada, como um uso;
  - o teste da desativação em `clinics-restriction` passa a exigir a expiração do conteúdo de IA.
- **Estáticos (2):** fora de `content-use/`, ninguém pega as travas sem a primitiva das mudanças, e a trava de linha antiga não existe mais; o contato da conversa não se atualiza (contrato e escritas).
- **Unidade (2):** a transação interativa usa o prazo de 30 s, e o prazo vencido (P2028) vira 409, enquanto outro erro passa como veio.
- **Mutação:** cada uma das 17 abaixo derruba pelo menos um teste, e todas compilam:
  - revogar, tornar paciente, excluir contato, trocar o contato do deal ou da tarefa sem a primitiva;
  - a troca de contato do deal sem a releitura sob as travas, e a da tarefa também;
  - o deal ou a tarefa que gravam o titular da leitura velha;
  - o prazo da transação vencido respondido como 500;
  - a tarefa que ignora a troca de deal;
  - a ativação sem a trava do workspace;
  - a desativação sem expirar o conteúdo de IA;
  - a aprovação sem travas, ou com travas exclusivas;
  - a mudança sem marcar os órfãos;
  - uma escrita que muda o contato da conversa.

  A remoção de empresa em ordem de id não tem teste determinístico: o deadlock que ela evita exige uma corrida exata entre dois lotes. Ela fica coberta pela leitura do código e pelo fim da trava de linha nas aprovações, que era o outro lado da corrida registrada.

#### 9. Implementação — G3, os usos sob a guarda (2026-10-20)

A G2 foi publicada (`9237de8`, quatro jobs do CI verdes). A G3 liga os três usos à guarda da G1, em três partes, cada uma com commit, bateria e revisão: **G3.1** a geração de IA, **G3.2** o envio da mensagem da IA, **G3.3** a entrega de webhook. O B2 segue fechado até a validação final do conjunto (G4).

**Regras comuns às três partes**, exigidas na aprovação da G2:

- **Cada tipo de uso se registra antes de existir.** O módulo do uso registra, no Core, a especificação do tipo: as chaves de `origem` aceitas, as chaves dos metadados do run com o validador de cada valor (lista fechada ou formato estrito) e o tratador de origem. A guarda recusa uso de tipo sem registro e uso com chave ou valor fora da especificação, antes de qualquer trava, e devolve as reservas.
- **Os tratadores de origem escrevem com `workspaceId` explícito em todo `where` e `data`**, porque a ativação os chama numa transação `raw`. Cada tratador tem teste numa transação `raw` com linhas de outro workspace presentes.
- **As reservas só mudam na transação da guarda.** O uso reserva antes de chamar a guarda e entrega as reservas a ela. Daí em diante, só a persistência do uso (na transação da guarda) ou os detectores as acertam. Se a reserva já não existir no acerto, a cobrança vai pelo caminho acima do teto (adendo 6 §5).
- **Os prazos de espera:** 10 s **por trava**, com limite de 30 s para a transação interativa inteira (mudanças e aprovações); 90 s por trava e 120 s de transação na CLI.

**G3.1 — a geração de IA.**

- **A porta.** O módulo `intelligence` continua sem tocar o Prisma (adendo 6 §3.3, "fronteira de módulos"). Ele usa a guarda por uma porta (`AI_USE_GUARD`), entregando o pedido ao provedor e a persistência do resultado. O adaptador em `intelligence-persistence` monta o uso externo, roda a guarda e entrega à persistência um identificador opaco da transação, que só os repositórios aceitam.
- **O run tem id gerado antes da chamada.** O registro do uso leva esse id na origem, com o prompt, a conversa ou o contato e quem pediu. Os metadados do run são a capacidade (lista fechada do catálogo de prompts), o modelo (formato de id de modelo), a versão do prompt (inteiro) e o teto de custo reservado (inteiro, calculado pelo servidor: é o custo que o run em dúvida registra).
- **Duas reservas** (`ai_runs` e o custo máximo do run), feitas antes da guarda. A persistência acerta as duas pelo desfecho: pelo real com resposta, por zero sem provedor configurado (nenhuma chamada saiu) e pelo teto com desfecho incerto.
- **Toda chamada ao provedor passa pela guarda.** O gateway não tem mais a chamada sem guarda: a única saída é `completeUnderGuard`, chamada pela guarda, e um teste estático fixa que o provedor só é chamado ali. O sinal de aborto é obrigatório no cliente do provedor. A chamada sob a guarda não reconfere a porta de novo: a reconferência acontece sob as travas, e uma segunda checagem entre a prova de vida e o início seria I/O no intervalo que a guarda proíbe.
- **`AI_MODEL` é validado na subida** com o mesmo formato que a especificação aceita: fora dele, a aplicação não sobe, em vez de recusar cada geração na hora de usar.
- **O SDK** é criado com `timeout: 60_000` e `maxRetries: 0`, e a chamada recebe o sinal de aborto da guarda (prazo absoluto de 60 s).
- **Persistência na transação da guarda:** o run (com o id pré-gerado), as propostas e o rascunho de resposta. O rascunho concorrente, que já tinha um pendente na conversa, é tratado sem abortar a transação: a inserção usa `ON CONFLICT DO NOTHING`.
- **`AiRunStatus` ganha `unknown_after_dispatch`** (migration aditiva). O tratador de origem da IA cria o run com o id pré-gerado nesse estado, se ainda não existir, quando o uso vira `in_doubt`. A persistência que falha também o deixa assim. O run em dúvida e o de custo incerto registram o **teto cobrado** (o teto vai nos metadados do uso, como inteiro): o histórico de custo fecha com o contador (§3.10 do `CLAUDE.md`).
- **Desfechos para quem pediu:**
  - não começou por restrição: `content_restricted`;
  - porta indisponível: 503, como hoje;
  - registro que falhou: `unavailable`, sem run. Se o registro chegou a comitar, a reconciliação cria o run em dúvida com o id reservado; gravar outro deixaria a mesma tentativa com dois runs;
  - qualquer outro motivo de não começar (trava, sessão, prova de vida, prazo): `unavailable`, com o run registrado como erro `not_started`;
  - em dúvida ou persistência falha: `unavailable`, com o run `unknown_after_dispatch`.

**Testes da G3.1** (dados fictícios; o provedor falso segura a chamada num portão; a porta real do Clinics na reconferência):

- **Integração, `clinics-ai-guard` (11):**
  - caminho feliz: o registro `ai_generation` está comitado antes da chamada, com o id do run na origem; o run, a proposta e o acerto das reservas acontecem na transação da guarda;
  - uso primeiro: revogar a liberação espera a geração, e a limpeza alcança a proposta que comitou antes;
  - mudança primeiro: a geração espera a revogação e recusa sem chamar o provedor, com as reservas devolvidas;
  - a guarda morre durante a chamada: o run fica `unknown_after_dispatch` com o id pré-gerado, a proposta não nasce, e as reservas vão pelo teto;
  - o prazo aborta a chamada pelo sinal; a chamada que ignora o sinal vira `overran_deadline`;
  - sem provedor configurado, o acerto é por zero; a persistência que falha deixa o run incerto; o run em dúvida e o de custo incerto registram o teto cobrado;
  - o registro que falha: nada sai, as reservas voltam, e nenhum run `not_started` é gravado;
  - o rascunho concorrente, com o outro ainda sem commit, espera, vê o conflito e responde `concurrent` sem abortar a transação;
  - o tratador de origem numa transação `raw`, com linhas de outro workspace: só escreve no workspace do uso, anula a referência alheia e não toca no run do outro.
- **Unidade:** as opções do SDK (60 s, sem retentativa); o sinal e as opções chegando à chamada; nenhuma chamada sem chave; só a guarda chama `completeUnderGuard`; o gateway sem chamada fora da guarda; `AI_MODEL` fora do formato não sobe.
- **Adaptados:** o teste da G1 usa a especificação real do tipo e cobre a lista fechada (chave, valor, origem) e o tipo sem registro. As suítes existentes de IA passam inteiras com a geração sob a guarda.
- **Mutação:** cada uma das 14 abaixo derruba pelo menos um teste, e todas compilam:
  - tipo sem registro aceito;
  - chave de origem fora da especificação;
  - metadado sem validador;
  - reservas não acertadas;
  - o caso sem provedor cobrado;
  - a persistência que falha sem deixar o run incerto;
  - o tratador ligando referência alheia;
  - o rascunho concorrente abortando a transação;
  - o SDK com retentativa;
  - o sinal que não chega ao provedor;
  - o registro que falha gravando run;
  - o run em dúvida sem o custo;
  - o custo incerto zerado;
  - o `AI_MODEL` sem a validação de formato.

  A mutação "a chamada reconfere de novo dentro da guarda" deixou de existir: o gateway não tem mais a chamada sem guarda, e a ausência é fixada por teste.

- **Prazo de leitura do proxy:** o nginx de staging passa a 120 s (o orçamento da geração sob a guarda passa de 98 s); registrado no `DEPLOY_STAGING.md`.

**G3.2 — o envio da mensagem de origem da IA** (o rascunho aprovado, **editado ou não**, pela decisão de 2026-10-21 abaixo; a mensagem livre escrita por pessoa não é uso de conteúdo e não muda).

- **Os contatos da aprovação ficam no despacho.** Uma migration aditiva cria `MessageDispatch.approvalContactIds` (uuid[]). A aprovação grava ali os contatos que conferiu: o da proposta e o da conversa naquele instante. Eles são validados na escrita, como a fotografia do outbox: precisam ser contatos do workspace. As travas e a reconferência do envio usam esses contatos **somados** ao contato atual da conversa, e não só ao atual (pedido da aprovação da G3.1). É a alternativa de defesa em profundidade do adendo 6 §9, somada à regra da conversa imutável da G2. A coluna não tem FK, como `ContentUse.contactIds`, e entra na conferência de dados do `check:fk`.
- **A ordem do envio da IA:**
  1. o claim com posse (lease) de 2 min, que cobre a janela inteira da guarda (cerca de 58 s com o prazo de 20 s);
  2. a política, a credencial e a reserva, como hoje;
  3. o **marcador de despacho**, gravado antes da guarda (ver abaixo);
  4. a guarda, com o tipo `ai_message_dispatch`;
  5. dentro dela, o envio pela Meta, com o sinal de aborto da guarda (prazo absoluto de 20 s, conexão incluída).
- **O marcador vem antes da guarda,** e não entre a prova de vida e o início, onde não pode haver I/O. A janela entre o marcador e o envio cresce pela espera das travas e pelo registro. Se o processo morrer nela, o despacho termina `unknown_after_dispatch` sem ter saído: um falso positivo conservador, que nunca duplica a mensagem. Se a guarda não começar, o marcador é limpo (`failed_before_send`), como hoje.
- **Na transação da guarda:** a conclusão do despacho, com fencing pelo `claimToken`, e o acerto da reserva (pelo real, ou acima do teto se ela sumiu).
  - entregue: `sent`;
  - falha comprovadamente antes do envio e transitória: `failed_before_send` e a reserva devolvida;
  - falha definitiva: `failed_permanent` e a reserva devolvida;
  - ambígua, aborto pelo prazo ou exceção depois de começar: `unknown_after_dispatch`, cobrada e **nunca reenviada**.
- **Retentativa só pelo protocolo.** A única nova tentativa é a do outbox, quando a guarda não começou ou a falha foi comprovadamente antes do envio. Cada nova tentativa é um uso novo, que passa pela guarda e reconfere.
- **A especificação `ai_message_dispatch`:** origem `messageId` e `claimToken`; nenhum metadado. O tratador de origem leva o despacho daquele `claimToken`, ainda `sending`, a `unknown_after_dispatch` (`errorCode = 'in_doubt'`), com `workspaceId` explícito. A cobrança fica com o detector (a reserva pelo teto) e a auditoria com o incidente `content_use.in_doubt`.
- **A reserva de um uso registrado é da guarda, e quem chega depois não cobra** (achado P1 da revisão). As varreduras de despachos (`resolveAbandonedInFlight`, `markExhausted`, `reapStaleDispatches`) liquidam a reserva e, se ela sumiu, cobravam acima do teto. Mas ela pode ter sumido porque um detector já a cobrou pelo teto: a varredura comita o despacho incerto, o detector marca o uso e cobra, e a liquidação da varredura chega depois. Eram duas cobranças por uma mensagem. Agora a varredura, achando a reserva sumida **e listada num `ContentUse`**, não cobra: quem a decidiu foi a guarda (acerto na transação dela, ou devolução se não começou) ou o detector (pelo teto). É o mesmo critério da varredura de reservas, que não devolve a reserva de um uso `authorized`. A pergunta é da guarda (`ContentUseGuard.reservaDeUmUso`): fora de `content-use/`, ninguém lê `ContentUse`. A regra estática da G1 pegou a primeira versão desta correção, que lia a tabela direto no serviço de envio. Na ordem inversa, o detector acha a reserva já liquidada e o despacho fora de `sending`: só avisa no log.
- **Exceção antes do início** (achado da revisão de segurança). A guarda só lança antes de começar; a linha do período, antes dela. Nesses casos, o despacho volta a `failed_before_send` com o marcador limpo, a reserva é devolvida e o erro sobe ao outbox, que tenta de novo como um uso novo. Sem isso, a varredura acharia o despacho `sending` com marcador e o cobraria como incerto sem nada ter saído.
- **A recusa pela restrição limpa o marcador.** O marcador da IA é gravado antes da guarda; quando ela não começa por restrição (`failed_permanent`, `content_restricted`), a mensagem comprovadamente não saiu, e o marcador sai junto.
- **O wamid conhecido não se perde** (achado P2 da revisão). Quando a Meta devolve o wamid e a persistência falha, ele vai para o despacho incerto, na mesma transação. Quando a guarda cai depois do envio (desfecho em dúvida), ele vai para o despacho (só se o `externalId` estiver vazio) e, só quando gravou, para a trilha (`message.dispatch_in_doubt`): sem linha atualizada, a guarda comitou `sent` antes de cair, e a trilha não pode dizer "em dúvida". Quando o envio passa do prazo (`overran_deadline`) e a Meta responde depois, o wamid tardio segue o mesmo caminho, pelo próprio envio. É o que permite a quem triar achar a mensagem no provedor e aos recibos de entrega chegarem a ela; o estado continua `unknown_after_dispatch`.
- **Resíduos declarados:**
  - **Registro incerto seguido de retentativa.** Se o registro falha e a lápide também, o registro pode ter comitado `authorized`: a reconciliação cobra a reserva pelo teto, e a nova tentativa do outbox cobra a sua. São duas contabilizações para uma mensagem enviada uma vez. É o falso positivo conservador da G1, ampliado pela retentativa; nunca duplica o envio. **Aceito só nesta etapa, com dados fictícios. NÃO está aprovado como comportamento financeiro para clientes reais** (decisão do usuário, 2026-10-21). É pendência explícita antes do piloto: separar o **consumo interno de quota** (o teto do plano, que pode continuar conservador) da **cobrança monetária** (no máximo uma vez por mensagem enviada). A solução não pode comprometer a prevenção de envio duplicado (`docs/MEMORY/technical-debt.md`, `docs/ROADMAP.md`).
  - **Não começou, e o processo morreu antes de encerrar o despacho** (limite operacional **aceito pelo usuário** em 2026-10-21). A guarda abortou (prazo, prova de vida ou lápide), com o uso `aborted` e a reserva devolvida, e o processo morreu antes do `finish`. Vencida a posse, a varredura marca o despacho `unknown_after_dispatch` e, pela regra acima, não cobra. A mensagem comprovadamente não saiu, mas fica "incerta" e não é retentada. Ela vai para a triagem humana, que **a distingue** de uma entrega realmente desconhecida (ver as decisões abaixo).
  - **Transição.** Despachos da IA aprovados antes do deploy (`approvalContactIds` nulo, ainda `reserved` ou `failed_before_send`) reconferem só o contato atual da conversa. Em staging o Clinics está desativado e os dados são fictícios; a migration vem antes do código.
  - **Rascunho editado:** decidido pelo usuário em 2026-10-21 (abaixo). Deixou de ser resíduo.

**Decisões do usuário sobre a G3.2 (2026-10-21):**

1. **Editar ou aprovar uma sugestão da IA não remove a origem de IA nem a proteção da guarda.** Antes, a revisão de segurança tinha mostrado o problema: um rascunho com qualquer edição, até de um caractere, virava `authorType = 'user'` (ADR-044.8) e saía sem a guarda do envio. Entre a aprovação e o envio (o backoff do outbox chega a horas), o contato podia virar restrito, e um texto quase todo da IA saía mesmo assim. **Regra:** a mensagem nascida da aprovação de uma proposta da IA, editada ou não, continua sujeita às mesmas restrições no despacho, ou seja, à checagem rápida e à guarda `ai_message_dispatch`.
   - **Implementação:** coluna explícita `MessageDispatch.fromAiProposal` (boolean, `false` por padrão), migration aditiva. A aprovação (`executeSendMessage`, pela `writeOutboundWithin` com os contatos da aprovação) a liga nos dois casos. O critério do envio é `authorType = 'ai'` **ou** `fromAiProposal`. O primeiro termo continua valendo para os rascunhos sem edição aprovados antes do deploy.
   - **Por que uma coluna, e não a presença dos contatos da aprovação:** `writeOutboundWithin` grava a lista vazia também na mensagem livre. "Tem fotografia" não distinguiria a aprovação de uma mensagem de pessoa, e a regra ficaria dependente da diferença entre `NULL` e lista vazia.
   - **A autoria não muda:** `authorType` continua `user` no rascunho editado, para exibição, métricas e auditoria (ADR-044.8). A origem é outro fato, e é ela que decide a restrição. O critério do ADR-048 ("mensagem escrita por pessoa é despachada normalmente") vale para a mensagem **livre**, não para o rascunho da IA editado.
   - **Transição, fechada por preenchimento** (sugestão da revisão). Uma segunda migration, só de dados (`20261021090100_message_dispatch_ai_origin_backfill`), liga `fromAiProposal` nos despachos **pendentes** (`reserved`, `failed_before_send`, `sending`). O critério é a trilha registrar a mensagem como criada de proposta da IA: `message.created_from_ai_proposal`, com `entityId = messageId`, no mesmo workspace.
     - O histórico terminal não é reescrito.
     - Conferida contra quatro casos na base de teste: o editado pendente passa a `true`; o terminal, a mensagem livre e a trilha de outro workspace ficam `false`.
     - **Resíduo:** aprovações e envios processados pelo código antigo **entre** a migration e a subida do código novo seguem a regra antiga. O código antigo grava `false` e não lê a coluna. "Migration antes do código", sozinha, **não fecha** essa janela (decisão do usuário, 2026-10-21). O runbook de deploy (`docs/DEPLOY_STAGING.md` §4, "Deploy da guarda de uso externo") exige, nesta ordem:
       1. o **acesso externo bloqueado durante toda a manutenção**, conferido de fora: o domínio do `web` sai, e a API e o `web` param no host, mas o banco continua no ar. `DISABLE_JOBS` não bloqueia requisições nem a geração de IA pela API, e falha de schema não é barreira de manutenção (decisão do usuário, 2026-10-21);
       2. a classificação dos trabalhos em andamento;
       3. a subida do código novo **com os jobs desligados** (`DISABLE_JOBS=true`) e **ainda sem acesso externo**, conferido de novo de fora;
       4. as migrations, com o preenchimento da origem conferido;
       5. só depois, a retomada: os jobs religados e o domínio devolvido.

       O código antigo nunca roda com o schema novo. A primeira versão do runbook mandava parar o recurso pelo painel, o que para também o banco, e rodar as migrations de uma imagem que só existe depois do deploy. A revisão apontou que ela não era executável (P2), e esta ordem a corrige. **Rollback:** voltar a um código sem as proteções não é recuperação. Em falha, a operação permanece em manutenção até definir uma recuperação compatível (`docs/DEPLOY_STAGING.md` §5).

       Em staging, o Clinics está desativado e os dados são fictícios.
2. **A triagem distingue a mensagem comprovadamente não enviada da entrega realmente desconhecida.** A pergunta da guarda passa de "a reserva está num uso?" para **a situação da reserva** (`ContentUseGuard.situacaoDaReserva`), com três respostas:
   - **sem uso:** caminho antigo, cobra acima do teto se a reserva sumiu;
   - **decidida:** o uso concluiu ou ficou em dúvida, e não se cobra de novo;
   - **não começou:** todo uso que a lista está `aborted`, e a guarda provou que a chamada não começou.

   No terceiro caso, a varredura reescreve o despacho que acabou de marcar como incerto: código `not_sent_guard_aborted` e marcador limpo, sem cobrança e sem reenvio. O estado continua `unknown_after_dispatch`, como no limite aceito. A reescrita só toca o despacho com um dos códigos das varreduras (`abandoned_in_flight`, `lease_expired_in_flight`, `retries_exhausted_in_flight`).

   Na caixa de entrada, esse código aparece como **"Não saiu"**, com o motivo "a guarda interrompeu antes do envio, sem cobrança", e não como "Entrega não confirmada". É o que separa o caso, para quem tria, de uma entrega cujo resultado ninguém conhece.

**Exigido para a G4 (aprovação da G3.2, 2026-10-21) — verificação de transição.** Os despachos aprovados antes da G3.2 têm **cobertura limitada**: `approvalContactIds` nulo, e por isso reconferem só o contato atual da conversa. O preenchimento lhes dá a origem de IA, mas não a fotografia da aprovação. A G4 os verifica à parte (contagem no deploy, cenário com a coluna nula na bateria), e nenhum relatório, consulta ou teste os trata como conferidos com a fotografia completa da aprovação.

- **`check:fk`:** a fotografia de `MessageDispatch.approvalContactIds` identifica a linha por `messageId` (o despacho não tem `id`). A bateria pegou a consulta com `e."id"`; a correção foi conferida contra uma linha com contato de outro workspace, que o check acusou.

**Testes da G3.2** (dados fictícios; o transporte falso segura o envio num portão; a porta real do Clinics na reconferência):

- **Integração, `clinics-ai-dispatch-guard` (21):**
  - caminho feliz: os contatos da aprovação ficam no despacho; o uso `ai_message_dispatch` é registrado antes do envio e conclui junto com o despacho;
  - o envio reconfere os contatos da aprovação: revogado um deles, a mensagem não sai, mesmo com o contato da conversa liberado;
  - mudança primeiro: o envio espera a revogação e recusa sem chamar a Meta, com a reserva devolvida e o marcador limpo;
  - uso primeiro: a revogação espera o envio em andamento, que termina `sent`;
  - a guarda morre durante o envio: `unknown_after_dispatch` com o wamid e a trilha, cobrado uma vez, e a reentrega não reenvia;
  - o prazo aborta pelo sinal, e a falha de rede é ambígua; o transporte que lança depois de começar é incerto; nos dois casos `unknown_after_dispatch`, cobrado e sem reenvio;
  - o envio que ignora o sinal vira `overran_deadline`, e o wamid da resposta tardia chega ao despacho incerto e à trilha;
  - a persistência que falha deixa o despacho incerto, com o wamid e a reserva pelo teto;
  - a falha comprovadamente antes do envio e transitória devolve a reserva, e a nova tentativa do outbox é um uso novo, pela guarda;
  - a guarda que lança antes de começar: nada sai, o marcador é limpo, a reserva volta e a nova tentativa do outbox envia;
  - a varredura de despachos comita o despacho incerto e, antes da liquidação dela, a reconciliação marca o uso órfão e cobra pelo teto: a mensagem é cobrada uma vez só (interleaving forçado, determinístico);
  - a escrita recusa contatos da aprovação de outro workspace; a aprovação real grava os contatos que conferiu e a origem de IA;
  - **o rascunho editado mantém a origem de IA** (decisão de 2026-10-21): a autoria é `user`, mas o envio sai sob a guarda; e não sai para um contato que ficou restrito depois da aprovação;
  - a mensagem livre escrita por pessoa continua fora da guarda e sai para contato restrito (ADR-048);
  - **triagem**, pelos três caminhos de varredura (periódica, reentrega do evento, tentativas esgotadas): com o uso `aborted` e o processo morto antes do `finish`, o despacho fica `not_sent_guard_aborted`, sem marcador, sem cobrança e sem envio;
  - o tratador de origem numa transação `raw`, com linhas de outro workspace, só toca o despacho do workspace do uso.
- **Suítes existentes:** envio, rascunho de resposta, restrição e paciente do Clinics passam inteiras com o envio da IA sob a guarda.
- **Web (`dispatch-badge.test.tsx`, 3):** o incerto `not_sent_guard_aborted` aparece como "Não saiu", e não como "Entrega não confirmada"; a entrega desconhecida continua "Entrega não confirmada"; o código só muda o selo do incerto.
- **Mutação:** cada uma das 24 abaixo derruba pelo menos um teste, e todas compilam:
  - a aprovação sem gravar a origem de IA; a origem ligada também na mensagem livre;
  - a restrição e a guarda decididas só pela autoria;
  - o uso `aborted` tratado como decidido; a triagem sem reescrever o despacho; o "não saiu" cobrado; a reentrega sem passar a mensagem à triagem;
  - a varredura cobrando de novo a reserva que a guarda ou o detector decidiu;
  - a exceção antes do início sem limpar o despacho; e sem devolver a reserva;
  - a recusa pela restrição mantendo o marcador;
  - o wamid perdido na persistência que falha; no desfecho em dúvida; e na resposta tardia;
  - só o contato da conversa nas travas;
  - a mensagem da IA sem guarda;
  - o sinal que não chega ao transporte;
  - o ambíguo virando retentativa;
  - o incerto virando retentativa;
  - a persistência que falha com retentativa;
  - o tratador sem `workspaceId`;
  - o tratador mantendo a referência da reserva;
  - a escrita sem validar os contatos;
  - a aprovação sem gravar os contatos.

A G3.2 foi publicada em `6a79708` e `40076a5` (quatro jobs do CI verdes sobre `40076a5`, com a migration de preenchimento).

**G3.3 — a entrega de webhook** (escopo aprovado em 2026-10-21: o webhook sob a guarda, incluindo o deal e a entidade raiz da tarefa, com isolamento por workspace e uma guarda nova a cada tentativa e destino).

- **Um uso por destino e por tentativa** (`webhook_delivery`). Cada webhook inscrito, em cada tentativa do outbox, passa por uma guarda própria, com registro, travas, reconferência e o POST dentro do prazo. Uma retentativa nunca herda a autorização de outra, e um destino nunca herda a de outro.
- **Ids gerados antes da guarda.** O id da entrega (`WebhookDelivery.id`) nasce antes de tudo. A origem do uso é `{deliveryId, webhookId, outboxEventId}`, todos uuids. O número da tentativa vai nos metadados, `{attempt}`, e o validador aceita só inteiro de 1 a 100. Não é `MAX_ATTEMPTS`: um evento cuja posse venceu (worker morto) é reassumido e conta tentativa sem passar por `markFailed`, então o número pode passar dele. Assim o tratador de origem consegue criar a linha, que é única por (workspace, webhook, evento, tentativa).
- **O conjunto de travas** segue a mesma regra de "de quem é o evento" da porta (adendo 2), agora também com as entidades:
  - **contatos:** a fotografia da emissão somada à resolução de agora. A resolução de agora cobre o evento e, em cadeia de automação, o evento raiz;
  - **entidades:**
    - a do evento: `deal:<id>` ou `task:<id>`;
    - o **deal da tarefa** (`deal:<dealId>`);
    - em cadeia, **a entidade raiz** e o deal da tarefa raiz;
  - **com zero contatos** (deal ou tarefa sem contato), as travas do workspace e das entidades valem do mesmo jeito;
  - **com a raiz sumida ou o evento sem id**, o desconhecido (`null`) vai à porta, que o trata como restrito quando o workspace tem dado sensível.
- **A reconferência, sob as travas, resolve de novo** os contatos e as entidades na transação da guarda.
  - Se apareceu contato ou entidade **fora do conjunto travado**, a guarda não começa e a resposta é "indisponível". Isso acontece, por exemplo, quando o deal ganhou um contato ou a tarefa trocou de deal entre a resolução e as travas. A nova tentativa resolve de novo, e o uso nunca segue sem a trava de quem o evento passou a ser.
  - Senão, a porta `webhook` responde com os contatos resolvidos de novo, somados aos da fotografia.
- **O transporte recebe o sinal da guarda.** `safePost` faz a resolução de DNS contra o sinal, e a requisição o leva. O prazo absoluto de **10 s** cobre DNS, TCP, TLS e resposta. O prazo de inatividade do socket continua o mesmo.
- **Persistência na transação da guarda:** a linha de `WebhookDelivery` com o id gerado antes da guarda e o status ou o erro. O desfecho incerto (exceção depois de começar, aborto pelo prazo) vira erro gravado, como hoje.
- **O tratador de origem** cria a entrega com o id gerado antes da guarda, como falha incerta (`error = 'in_doubt'`), se ela ainda não existir: `createMany` com `skipDuplicates` e `workspaceId` explícito, válido também na transação `raw` da ativação.
- **Desfechos no fan-out:**
  - concluído com 2xx: entregue;
  - concluído com falha do destino: retentativa pelo outbox e penalidade de entrega morta, como hoje;
  - não começou por restrição: o evento é suprimido para os destinos restantes, sem entrar no histórico que o cliente vê, como hoje;
  - não começou por outro motivo (porta indisponível, conjunto desatualizado, trava, sessão, registro, prova de vida, prazo): falha **do evento**, sem penalizar o destino. O retry parcial retoma de onde parou, com um uso novo;
  - em dúvida (guarda perdida): o tratador já criou a entrega incerta. Conta como falha do evento, sem penalizar o destino. A nova tentativa é um uso novo, e depois de uma restrição é recusada.
- **Entrega "pelo menos uma vez".** Ao contrário da mensagem da Meta, um webhook incerto é reenviado na próxima tentativa, como hoje. O destino deduplica pelo `x-veyra-delivery` (o id do evento). O que a guarda garante é que nenhuma tentativa, nova ou repetida, sai depois de uma restrição.
- **A checagem rápida antes do fan-out continua**: ela suprime cedo, sem abrir guarda. A garantia está na reconferência sob as travas, por destino. A reconferência entre destinos, que existia, sai do código: a guarda de cada destino a substitui.
- **A guarda vale sempre**, com ou sem vertical. Sem o Clinics, a porta responde "liberado", e o custo é o registro e as travas por destino.
- **Contexto e isolamento.** A entrega roda fora do contexto de requisição (worker cross-workspace). Cada guarda roda num `cls.run` com o workspace **do evento**, porque a guarda exige o contexto e usa o client filtrado. Toda leitura `raw` leva o `workspaceId` explícito.
- **O teste da G1 de "tipo sem registro"** usava `webhook_delivery`, que agora tem registro. Ele passa a simular a ausência da especificação.

**Testes da G3.3** (dados fictícios; o destino falso segura o POST num portão; a porta real do Clinics na reconferência; quem espera quem é conferido em `pg_blocking_pids`):

- **Integração, `clinics-webhook-guard` (15):**
  - caminho feliz com deal sem contato num workspace com o Clinics: o uso trava o workspace e `deal:<id>` com zero contatos, registra antes do POST (o sinal chega ao transporte) e conclui com a entrega, cujo id é o da origem do uso;
  - uso primeiro: trocar o contato do deal espera a entrega e comita depois;
  - mudança primeiro: o deal ganha um contato enquanto a entrega espera as travas. A reconferência o vê fora do conjunto travado: nada sai, ninguém é penalizado, e a nova tentativa é suprimida;
  - a tarefa trava também o deal dela, e a cadeia trava a entidade raiz: nos dois casos, trocar o contato desse deal espera a entrega;
  - uma guarda nova por destino (dois webhooks, dois usos, duas entregas) e por tentativa (`attempt` 1 e 2, dois usos);
  - entre destinos: o deal ganha um contato depois do 1º destino, e a guarda do 2º o vê, sem POST;
  - a guarda morre durante o POST, na última tentativa: o uso fica em dúvida, a entrega nasce incerta com o id gerado antes, e o evento morre sem penalizar o destino;
  - o prazo aborta o POST pelo sinal (falha do destino, gravada sob a guarda); o POST que ignora o sinal vira `overran_deadline`, com a entrega incerta;
  - workspace sem o Clinics: o evento de contato sai sob a guarda, com o contato travado; a ativação do Clinics espera a entrega em andamento, e depois dela o evento de contato é suprimido;
  - isolamento: a entrega presa no workspace B não segura a troca de contato do deal no A;
  - o tratador de origem numa transação `raw`, com linhas de outro workspace, só cria a entrega incerta no workspace do uso, e repetido é idempotente.
- **Unitário (`safe-http`):** o sinal abortado encerra a entrega já na resolução de DNS. **Regra estática** (nit da revisão de segurança, no molde da G3.1): `safePost(` só aparece na própria definição; o transporte injetável só é usado pelo módulo e pelo serviço de webhooks; o serviço o chama uma única vez, dentro do `iniciar` da guarda. Uma reentrega manual ou um "testar webhook" futuro que chamasse o transporte direto quebra o teste.
- **Suítes existentes:** a E6 (restrição no lado do Core) passou a contar a reconferência de cada destino sob a guarda. Antes eram a checagem rápida e a reconferência a partir do 2º destino; agora a restrição no meio do fan-out cai na 3ª consulta (checagem rápida, 1º destino, 2º destino). O teste da G1 de "tipo sem registro" simula a ausência da especificação.
- **Mutação:** cada uma das 11 abaixo derruba pelo menos um teste, e todas compilam:
  - a tarefa sem o deal dela nas travas;
  - a cadeia sem a entidade raiz;
  - a reconferência aceitando escopo novo;
  - a guarda sem reconferência;
  - o sinal que não chega ao transporte;
  - o DNS sem o sinal;
  - o tratador sem `workspaceId`;
  - o tratador que não cria a entrega;
  - a tentativa fora dos metadados;
  - a entrega sem o id da origem;
  - a dúvida penalizando o destino.

  **Sem teste de mutação:** o sinal na própria requisição HTTPS (`signal` no `https.request`). Um teste exigiria rede e endereço público, que a defesa SSRF recusa em ambiente local. Se o sinal não chegasse, a guarda ainda limitaria o tempo: a chamada que passa do prazo vira `overran_deadline`, como prova o teste do POST que ignora o sinal.

A G3.3 foi publicada em `09b1a76` e `f1315b2` (quatro jobs do CI verdes sobre `f1315b2`).

#### 10. G4 — validação do conjunto (2026-10-21)

Escopo aprovado: matriz uso × mudança, recuperação de falhas, isolamento, transição dos despachos antigos e revisão final de segurança. **A conclusão da G4 não levanta o B2:** ela produz um relatório para decisão. A contagem dupla da G3.2 continua pendente antes do piloto.

**Como:** uma suíte própria (`clinics-guard-matrix`) com os **três consumidores reais** no mesmo app: a geração de IA (G3.1), o envio da mensagem de origem da IA (G3.2) e a entrega de webhook (G3.3). Ela usa o provedor de IA, a Meta e o destino falsos, segurando a chamada num portão, e a porta real do Clinics. Quem espera quem é conferido em `pg_blocking_pids`, nunca por sono.

1. **Matriz uso × mudança.** Cada consumidor contra cada mudança da G2 que o alcança, nas duas ordens:
   - **uso primeiro:** a mudança comprovadamente espera, o uso conclui, e a mudança comita depois;
   - **mudança primeiro:** o uso espera e, depois do commit, recusa sem chamar.

   Os pares:
   - geração de IA, com o contato liberado: revogar a liberação, tornar paciente, excluir o contato e desativar o Clinics (o workspace inteiro);
   - envio da IA, com o contato da conversa liberado: revogar a liberação, tornar paciente e desativar o Clinics. Excluir o contato fica fora do envio: ela apaga a conversa em cascata, e com ela a mensagem e o despacho;
   - webhook de deal ou tarefa sem contato: trocar o contato do deal, trocar o contato da tarefa e trocar o deal da tarefa;
   - webhook de contato num workspace sem o Clinics: ativar o Clinics (o workspace inteiro).

2. **Recuperação de falhas, com os tratadores reais.** Um uso órfão de cada tipo, com o registro de origem no estado em que o processo morto o deixou, é marcado pelos detectores:
   - pela **mudança** que segura as travas;
   - pela **reconciliação**;
   - pela **ativação** (o workspace inteiro).

   O esperado, por tipo:
   - o run fica `unknown_after_dispatch`;
   - o despacho fica `unknown_after_dispatch`, sem reenvio;
   - a entrega de webhook nasce incerta;
   - as reservas são cobradas pelo teto **uma vez**, e o incidente é auditado.

3. **Isolamento.**
   - Um uso de cada consumidor, preso no workspace B, não segura mudança no A.
   - A ativação no A não marca órfão do B.
4. **Transição dos despachos antigos** (exigida na aprovação da G3.2). O despacho anterior à G3.2 tem **cobertura limitada** e é verificado à parte, nunca como se tivesse a fotografia completa da aprovação:
   - o rascunho sem edição (`authorType = 'ai'`) continua sob a guarda, mas reconfere só o contato atual da conversa. O teste fixa esse limite;
   - o rascunho editado com trilha recebe a origem pelo preenchimento e passa a sair sob a guarda;
   - o editado sem trilha segue a regra antiga.

   O runbook ganha a contagem desses despachos, depois das migrations (antes delas, as colunas da G3.2 não existem).

5. **Mutações-chave contra a matriz:** a retirada da guarda ou da reconferência de cada consumidor derruba testes da matriz, não só da suíte de origem.
6. **Revisão final de segurança** do conjunto G1–G4 contra o critério G′ (adendos 6 e 7), pelo `security` e pelo `reviewer`.

**Saída:** o relatório da G4, com o que ficou provado, os resíduos declarados e as pendências antes do piloto. O B2 continua bloqueado até a decisão do usuário.

**Decisão do usuário (2026-10-21):** o B2 foi levantado tecnicamente para workspaces com o Clinics, sob o G′, com eficácia depois do CI verde sobre `4ff55e0`. O registro completo, com o que o levantamento afirma e não afirma e os bloqueios por marco, está no ADR-048, adendo 6. O ciclo G1–G4 está encerrado.

**Resultados da G4** (`clinics-guard-matrix`, 39 testes, todos passando; dados fictícios):

- **Matriz (24):**
  - geração de IA × 4 mudanças, nas duas ordens;
  - envio da IA × 3 mudanças, nas duas ordens;
  - envio × excluir o contato da conversa, nas duas ordens. A cascata apaga a conversa, a mensagem e o despacho. Em "mudança primeiro", o worker já tinha o corpo e o endereço em memória: quem barra é a porta do Clinics (contato apagado é restrito), e nada sai;
  - webhook × 4 mudanças (contato do deal, contato da tarefa, deal da tarefa, ativação), nas duas ordens.

  Em "uso primeiro", a mudança comprovadamente espera, o uso conclui e a mudança comita sem erro. Em "mudança primeiro", o uso espera e recusa sem chamar:
  - na IA, a pessoa recebe `content_restricted`, a recusa fica registrada (sem a referência ao contato, se ele foi excluído) e nada é contado;
  - no envio, `content_restricted`, sem Meta nem cobrança;
  - no webhook, sem POST nem entrega gravada.

  Depois de "uso primeiro" com exclusão, o run some em cascata com o contato: a conferência olha o desfecho devolvido (`proposed`).

- **Recuperação (9):** o órfão de cada tipo, com o registro de origem como o processo morto o deixou, marcado por cada detector: a mudança que segura as travas, a reconciliação e a desativação do workspace. Com os tratadores reais:
  - o run fica `unknown_after_dispatch`, com o teto como custo;
  - o despacho fica `unknown_after_dispatch` e `in_doubt`, sem Meta;
  - a entrega de webhook nasce `in_doubt`.

  As reservas são cobradas pelo teto uma vez (nenhuma sobra; os contadores fecham), e o incidente é auditado uma vez.

- **Isolamento (3):** a geração e o envio presos no workspace B não seguram a revogação no A (o webhook está na G3.3); a desativação no A marca só os órfãos do A.
- **Transição (3):**
  - o despacho antigo sem edição continua sob a guarda, mas **reconfere só o contato da conversa**. Com o contato só da aprovação revogado, a mensagem sai. É o limite, fixado em teste;
  - a contagem do runbook, feita depois das migrations, conta esse despacho e não conta a mensagem livre de pessoa;
  - o contato da conversa revogado continua barrando;
  - o editado antigo com trilha recebe a origem pela migration de preenchimento, executada como está, e não sai para contato restrito.
- **Mutações-chave contra a matriz (7):** cada uma derruba testes da **matriz**, e todas compilam:
  - a geração sem reconferência;
  - o envio sem guarda;
  - o webhook sem reconferência;
  - a mudança sem travas;
  - a mudança que não marca órfãos;
  - o workspace que não marca órfãos;
  - a recusa que se perde quando o contato sumiu.

**Revisão final de segurança e do `reviewer` (2026-10-21).** Os dois concluíram que **o critério G′ está implementado e provado** para o escopo do B2 (workspaces com o Clinics), sem P0 nem P1, e varreram o código inteiro:

- nenhum uso externo fora da guarda;
- nenhuma mudança de restrição ou de titularidade fora da primitiva;
- isolamento correto nas travas, nos detectores, nos tratadores e nas varreduras.

Achados e o que se fez:

- **P2 (`reviewer`): a geração recusada para um contato excluído durante a espera** respondia 409 e não registrava a recusa. A FK do run recusava o contato apagado. Agora o run recusado ou de erro é gravado sem a referência que não existe mais, como o run incerto. A matriz passou a conferir o desfecho devolvido e o run recusado, e uma mutação o prova.
- **P2 (`reviewer`, docs):** o plano prometia o isolamento dos três consumidores, mas os resultados só tinham a geração. O caso do envio entrou.
- **P2 (`security`, fora do escopo do B2): exclusão de contato num workspace só com o Core.** A porta sem vertical não restringe nada. A exclusão espera os usos em andamento, mas o que já estava montado ainda pode sair depois do commit. Tratar contato apagado como restrito no Core quebraria o webhook `contact.deleted`. O comentário do serviço foi corrigido, e a decisão fica registrada como pendência antes de dado real em qualquer workspace sem o Clinics (`docs/MEMORY/technical-debt.md`).
- **Nits:**
  - o par envio × excluir o contato entrou, com a justificativa certa;
  - a consulta de transição do runbook conta só a origem de IA;
  - as CLIs administrativas sobem com `DISABLE_JOBS=true` (`cli/sem-jobs.ts`, importado antes do `AppModule`), sem abrir workers nem a reconciliação no processo da CLI;
  - os pares "geração × trocar o contato de um deal do contato" e "envio × excluir um contato só da aprovação" ficam cobertos por construção (a trava do contato do pedido), sem teste próprio.
- **Observação:** o contexto da IA é lido **antes** das travas. A reconferência sob as travas confere a restrição dos contatos do pedido, não a titularidade do que foi lido. Um deal que troca de titular nesse intervalo leva ao provedor o que era do contato liberado no momento da leitura, e isso não viola o G′ (o conteúdo era do contato liberado), mas fica registrado.

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
- Mensagem de autoria da IA para contato restrito não é despachada; mensagem escrita por pessoa é despachada normalmente. _Nota de 2026-10-21 (decisão do usuário, ADR-047 adendo 7 §9, G3.2): o rascunho da IA aprovado **com edição** não é "mensagem escrita por pessoa" para esta regra. A origem de IA continua, e ele também não é despachado para contato restrito. A regra da pessoa vale para a mensagem livre._
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

> **Situação em 2026-10-21:** o **B2 foi levantado tecnicamente** para workspaces com o Clinics, sob o critério G′ (adendo 6, com o que ele afirma e o que não afirma). B1, B3 e B4 seguem abertos, e os bloqueios por marco do adendo 6 continuam valendo.

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
3. **Hora local, fuso e mudança de horário.** A conversão é uma função pura, sem dependência nova, que usa o `Intl` do runtime. Desde a F2.3 ela mora em `packages/contracts`, para a tela usar a mesma regra (adendo 5, item 1). Para uma data e hora locais no fuso da unidade, ela procura os instantes cujo horário local é exatamente aquele:
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

### Adendo 5 (2026-10-20) — F2.3: telas da agenda, do atendimento e dos pacientes, e o e2e

Implementa o item 9 do adendo 2, a parte de telas da F2. A revisão de 2026-10-20 recomendou a F2.3 **só com dados fictícios** e **não a usa como motivo para habilitar o Clinics nem para dados reais**. O Clinics segue desativado em staging, e o B2 segue fechado (ADR-047, adendos 6 e 7).

1. **Hora local compartilhada.** A conversão de hora local (adendo 4, item 3) sai da API e vai para `packages/contracts`, onde já mora `canonicalTimezone`. É uma função pura sobre o `Intl`, sem dependência nova. Com ela, a tela e o servidor decidem pela **mesma** regra:
   - o "hoje" da unidade;
   - os horários livres;
   - o pulo e a hora repetida.

   O servidor continua sendo quem decide; a tela só evita o pedido que ele recusaria.

2. **Agenda da clínica (`/clinics/agenda`)**, com `clinics:schedule:read` **e** `clinics:catalog:read`, porque a grade lê a unidade, os profissionais e os serviços.
   - **O item da lateral exige só `clinics:schedule:read`:** o item de navegação aceita uma chave só. Todos os papéis semeados que leem a agenda também leem o catálogo. Um papel customizado só com a agenda vê o item e, ao abrir, a mensagem de acesso; nada é consultado.
   - **Grade simples**, sem biblioteca de calendário (o adendo 2, item 9, recomendou assim enquanto H1 não for validada): uma coluna por profissional ativo, com o expediente do dia e os agendamentos em ordem de início.
   - **Agendamento de profissional arquivado não some:** ganha uma coluna própria, "(arquivado)", para a recepção ainda poder vê-lo, cancelá-lo ou registrá-lo. Remarcar ele não oferece, porque o drawer não teria serviços nem horários do arquivado.
   - **Horários sempre na hora local da UNIDADE**, nunca na do navegador.
   - **Navegação por dia:** anterior, hoje (da unidade) e próximo. O dia fica na URL; um `?dia=` que não seja uma data existente, na faixa que o servidor aceita (anos 2000 a 2100), é ignorado, e vale o hoje da unidade.
   - **Estados da tela:** "carregando" enquanto a agenda do dia não chega, e "Nenhum agendamento" só com a resposta em mãos. Com erro, a tela mostra o alerta e **nenhum dado antigo** (classe S), inclusive quando é a recarga que falha depois de um sucesso: nem os cartões nem as colunas de arquivado ficam. Sem unidade ativa, explica e não consulta a agenda.
   - **"Minha agenda":** um filtro opcional pelo profissional vinculado à conta. É conveniência, não restrição de acesso (D8).
   - **O `Profissional` vê e registra o atendimento dos agendamentos de qualquer profissional**, não só os seus. É intencional, pela mesma razão de D8: na clínica pequena, um profissional cobre o outro. A API já decide assim (adendo 4). Restringir por profissional seria uma regra nova no servidor, não um filtro de tela.
3. **Agendar e remarcar** (drawer, com `clinics:schedule:write`).
   - **Agendar:** paciente, serviço, profissional habilitado, data e um horário **livre**, em passos de 15 minutos, calculado na tela:
     - o paciente é escolhido por **busca** pelo nome (mínimo 2 letras, até 20 resultados); a tela nunca baixa a lista inteira (minimização, classe S). Com erro na busca, inclusive numa recarga (por exemplo, acesso revogado), a tela mostra o alerta e nada da busca anterior fica escolhível;
     - dentro do expediente do dia local;
     - sem sobrepor os agendamentos ativos daquele profissional;
     - com o fim lido como no servidor.
   - **Remarcar:** troca data e horário, e opcionalmente o serviço, entre os que o profissional faz. Sem troca de serviço, o pedido não leva `serviceId`. Se o serviço original foi arquivado, a tela explica e obriga a escolher outro, porque o servidor recusaria.
   - **Os horários começam alinhados ao passo:** um expediente que comece às 08:07 oferece 08:15 como primeiro horário.
   - **Mudança de horário na lista de horários:** a hora inexistente não aparece. A hora que se repete aparece **duas vezes**, "antes da mudança" e "depois da mudança", e envia o `utcOffset` correspondente.
   - **Recusas do servidor:** o 409 de horário ocupado (outra pessoa marcou antes) aparece com o motivo do servidor, e a agenda é recarregada.
4. **Estado e atendimento, no cartão do agendamento:**
   - **Ações de estado**, para `clinics:schedule:write`: "Confirmar", "Registrar chegada", "Marcar falta" e "Cancelar", este com motivo da lista fechada. Só as transições válidas para o estado atual aparecem. O cancelamento abre o motivo no próprio cartão, com "Voltar", e fecha depois do sucesso.
   - **"Registrar atendimento"**, para `clinics:care:write`, a partir de marcado, confirmado ou chegou.
   - **Cada botão diz de quem é:** o nome acessível leva a hora, o paciente e o profissional ("Cancelar: 09:00 Ana (Dra. Bia)"), único na tela mesmo com dois pacientes de mesmo nome no mesmo horário.
   - **A tela não decide nada:** cada ação chama a API, e a agenda é recarregada. As recusas da API chegam em português, com os estados pelo nome da tela ("Transição inválida: Marcado → Chegou"; "Agendamento com estado Faltou não aceita registro de atendimento").
5. **Pacientes (`/clinics/patients`)**, com `clinics:schedule:read`.
   - **Lista** com nome e data, as mais recentes primeiro, com **busca pelo nome** e **teto de 50**. No teto, a tela avisa e pede a busca. Com erro, nenhuma linha antiga. A API ganhou `search` (2 a 80 caracteres, sem distinguir maiúsculas) e `limit` (1 a 100, padrão 50) em `GET /api/clinics/patients`, em ordem `createdAt` e `id` decrescentes. A paginação por cursor ficou como dívida, com gatilho próprio (`docs/MEMORY/technical-debt.md`).
   - **"Novo paciente"**, com `clinics:schedule:write` + `contacts:read`: busca de contato e **as consequências na tela, antes de confirmar** (adendo 2, item 1):
     - a IA deixa de ler o contato, mesmo se ele estiver liberado, e a liberação é revogada;
     - o contato não pode ser excluído enquanto for paciente;
     - não há como desfazer pela tela.

     Quem já é paciente aparece marcado e não pode ser escolhido. A conferência é feita **só entre os contatos da busca** (`contactIds`), sem baixar a lista de pacientes, e nenhum contato pode ser escolhido enquanto ela não volta. Se ela falhar, a tela mostra o alerta e continua sem deixar escolher.
6. **Navegação:** o grupo "Clínica" passa a ter, nesta ordem, **Agenda da clínica** (o Core já tem a sua "Agenda", o calendário), Pacientes, Catálogo e Liberação para IA. Cada item leva a permissão da sua rota. Com o status não confirmado como ativo, nada aparece e nada é consultado (adendo 4 do ADR-047).
7. **Testes** (dados fictícios):
   - **Web:**
     - nada é consultado antes do status ativo, com o status em erro, sem a chave da agenda ou sem a do catálogo, nas duas telas;
     - itens da lateral por permissão, inclusive o caso negativo: quem só lê o catálogo não vê a agenda nem os pacientes;
     - horários livres, inclusive o pulo, a hora repetida e o alinhamento ao passo;
     - ações por papel: a recepção não vê "Registrar atendimento", e o `Profissional` não vê agendar nem as ações de estado;
     - cancelamento exige motivo e fecha depois do sucesso;
     - a coluna do profissional arquivado (sem remarcar), o `?dia=` inválido, os estados de carregando e de erro e a falta de unidade;
     - **recarga que falha depois de um sucesso**, nas duas telas e na busca de paciente: nenhum dado antigo fica;
     - o paciente escolhido por busca, sem a lista inteira, e a busca com erro;
     - remarcar: os serviços do profissional, o corpo sem `serviceId` e o serviço original arquivado;
     - corpo enviado à API e o 409 mostrado;
     - pacientes: o teto com aviso, o erro sem linhas antigas e a conferência de "já é paciente" só entre os contatos da busca, inclusive quando ela falha.

     Cada correção de "nenhum dado antigo" e de remarcar foi conferida com mutação: desfeita a correção, o teste dela falha.

   - **Integração:**
     - a busca e o teto de pacientes;
     - o isolamento da busca: um contato com nome que casa, mas não é paciente, não volta; B, com um paciente próprio que casa o mesmo termo, recebe só o dele; `contactIds` e `search` juntos valem como E;
     - o texto em português das recusas de transição e de atendimento.
   - **E2E**, no workspace `clinica` do e2e, com um usuário `Profissional` novo no seed. O **dia vem do banco e vai na URL**, para que nem o relógio do navegador nem a virada do dia decidam a agenda mostrada:
     - a recepção agenda, com o paciente escolhido por busca, e vê o conflito recusado;
     - o `Profissional` registra o atendimento e **recebe** o vínculo com o registro (`attendanceId`);
     - a recepção vê "Atendido", sem o vínculo e sem a ação;
     - a criação de paciente mostra as consequências e grava o perfil;
     - workspace sem o Clinics: as duas URLs diretas só explicam, a lateral não tem as seções, e nenhuma consulta ao vertical, fora o status, sai do navegador.

     O fuso vem da unidade, no banco, e não de uma constante do teste.
8. **Implementação (2026-10-20).**
   - **Telas:** `AgendaPage.tsx` (grade, cartão e drawer) e `PatientsPage.tsx`. Os horários livres ficam numa função pura (`agenda/slots.ts`), testada com o pulo e a repetição de Nova York em 2025.
   - **Testes web:** 29 das telas (`agenda.test.tsx`) e 4 dos horários livres (`agenda/slots.test.ts`).
   - **Integração:** um teste novo da busca e do teto de pacientes; asserções novas de isolamento da busca e do texto das recusas nos testes existentes.
   - **E2E:** `clinics-agenda.spec.ts`, com 4 testes. O seed ganhou o usuário `Profissional` (`PROF_C`), criado depois da ativação.
   - **Achado no caminho:** o pré-bundle do Vite (`node_modules/.vite`) não é invalidado quando o `dist` dos contratos muda, porque é um pacote do workspace. Um cache velho deixou `horaLocal` indefinida no navegador, embora o Vitest passasse. O Vite do e2e agora sobe com `--force`, num **cache próprio** (`VITE_CACHE_DIR=node_modules/.vite-e2e`), para não apagar o pré-bundle de um dev server aberto ao mesmo tempo. Em desenvolvimento, apagar `apps/web/node_modules/.vite` depois de mudar os contratos resolve.
9. **Revisão da implementação (2026-10-20).** `reviewer` e `security` aprovaram com ressalvas. As correções desta entrega são o que os itens 2 a 8 já descrevem:
   - a coluna do arquivado;
   - os estados da tela;
   - o `?dia=` validado;
   - os serviços do remarcar;
   - o cancelamento que fecha;
   - os nomes acessíveis únicos;
   - os rótulos das ações;
   - o alinhamento ao passo;
   - a busca e o teto de pacientes;
   - nenhum dado antigo com erro;
   - as mensagens da API em português;
   - os testes de casos negativos.

   **Segunda rodada (delta), no mesmo dia.** As duas revisões aprovaram com ressalvas, sem nada que bloqueasse o commit. Entraram nesta entrega:
   - o texto da recusa de atendimento ("Agendamento com estado Faltou…");
   - o exemplo de recusa deste adendo, que era uma transição impossível;
   - a faixa de datas do `?dia=`;
   - nenhum dado antigo também na recarga que falha: colunas de arquivado, busca de paciente e conferência de "já é paciente";
   - remarcar escondido para profissional arquivado e o serviço original arquivado;
   - o erro de uma ação que some quando outra ação começa;
   - `maxLength` nos campos de busca;
   - os testes de isolamento da busca, os de recarga que falha e os de remarcar;
   - o fuso da unidade e o filtro de consultas do e2e.

   Ficaram como dívida, com gatilho, em `docs/MEMORY/technical-debt.md`:
   - a paginação por cursor dos pacientes;
   - a limpeza do cache do TanStack Query no login e na perda de sessão. É do Core e vale para todas as telas. Na mesma aba, uma busca com `staleTime` de 30 s pode servir o resultado da sessão anterior **sem recarregar**, e isso é vazamento entre sessões e entre workspaces. Por isso a dívida entrou nas dependências de dado real do ROADMAP e em `docs/SECURITY.md`, e precisa vir **antes de qualquer dado real**. **Atualização (2026-10-20):** a revisão transformou a dívida em bloqueio da publicação da F2.3, e ela foi corrigida no Core pelo ADR-050.

   Ficaram como sugestão, sem gatilho próprio:
   - a coluna "Desde" dos pacientes mostra a hora do navegador (`fullStamp`), como o resto do Core, e não a da unidade;
   - os rótulos e as transições de estado estão duplicados entre API e tela (`ROTULO` e `ROTULO_DO_ESTADO`; a tabela de origens e `TRANSICOES`). Pela regra do item 1, iriam para os contratos se uma terceira cópia aparecer ou se as duas divergirem.

### Adendo 6 (2026-10-21) — levantamento técnico do B2 (decisão do usuário)

**Decisão.** O usuário aprovou o **levantamento técnico do B2** para **workspaces com o Clinics**, sob o critério G′ aprovado (ADR-047 adendo 7). A eficácia ficou condicionada aos quatro jobs do CI verdes sobre o commit da G4, `4ff55e0`, o que aconteceu na execução `39626339726`. Os registros anteriores **ficam como estão**, como histórico:

- a decisão de 2026-10-19 que manteve o B2 fechado (adendo 3, item 16);
- a revisão do adendo 6 do ADR-047, que não aceitou o residual da sessão de guarda como prova.

O que mudou desde então foi o critério e a implementação: o G′, os adendos 6 e 7 do ADR-047 e as entregas G1–G4.

**O que o levantamento afirma, e o que não afirma.** O registro distingue, por exigência do usuário:

1. **O G′ coordena a autorização e as mudanças de restrição, com detecção e recuperação da perda da guarda.** Ele **não promete impedir toda chamada física posterior à restrição.** Se a guarda se perde (processo congelado, partição, banco fora), uma chamada autorizada antes da restrição pode começar depois dela. O caso é detectado e recuperado: o uso fica `in_doubt`, o registro de origem fica incerto, a cobrança vai pelo teto e o incidente é auditado. Essa é a diferença declarada entre G′ e G (ADR-047 adendo 7).
2. **A garantia depende das condições documentadas** do banco e da reconciliação (ADR-047 adendo 7 §3.5; `docs/DEPLOY_STAGING.md` §4):
   - durabilidade dos commits confirmados (Postgres único, ou failover só para réplica síncrona);
   - conexão direta ou pooler em modo sessão;
   - os jobs no ar para a reconciliação.
3. **Os despachos anteriores à G3.2 têm cobertura limitada.** Eles reconferem só o contato atual da conversa. O preenchimento da origem (`fromAiProposal`) **não recria a fotografia da aprovação**. Eles são contados à parte e não são tratados como conferidos com ela.
4. **A leitura do contexto anterior às travas não garante a titularidade atualizada no instante do envio.** A reconferência sob as travas confere a restrição dos contatos do pedido, não a titularidade do que foi lido antes. Um deal que troca de titular nesse intervalo leva ao provedor o que era do contato liberado no momento da leitura.

**Escopo.** O levantamento vale para a regra "restrito por padrão" (§6.4) em workspaces com o Clinics, com a bateria do §6.6, a prova de concorrência e os passes de `reviewer` e `security` (critério da tabela do adendo 2), sob o G′. Ele **não incorpora** as pendências operacionais. Elas continuam como **bloqueios explícitos dos respectivos marcos**:

1. **Antes de qualquer deploy desta atualização:** fechar a **barreira contínua de manutenção**. Detectar uma rota aberta depois do deploy **não cumpre** a exigência de impedir o acesso durante toda a janela. As opções:
   - um modo de manutenção na própria aplicação;
   - uma barreira externa independente e comprovada.

   O proxy compartilhado não é alterado sem diagnóstico e autorização.

2. **Antes do piloto:**
   - resolver a contagem dupla, separando a quota interna da cobrança monetária;
   - preparar os alertas e a triagem dos usos em dúvida;
   - validar os pools sob carga;
   - tratar os despachos antigos **sem reenviar entregas incertas**.
3. **Antes de dados reais no Core sem o Clinics:** resolver a política de exclusão e de uso do conteúdo já carregado (`docs/MEMORY/technical-debt.md`).
4. **Continuam bloqueando dados reais e o piloto:** B1, B3 e B4, a validação operacional (H1–H7) e a avaliação jurídica (§9.2).

**Situação.**

- O ciclo G1–G4 da guarda está encerrado.
- O Clinics segue desativado em staging, com **somente dados fictícios**.
- Nenhum deploy nem ativação está autorizado.
- O próximo passo funcional é o plano da F3, para revisão, sem código.

### Adendo 7 (2026-10-21) — plano da F3: pacotes, consumo de sessão, retorno e taxa de faltas (PROPOSTO, revisão 1)

**Situação: PROPOSTO, revisão 1. Nenhum código está autorizado.**

A primeira versão está no `f00e873`. A leitura do usuário em 2026-10-21 aprovou a divisão F3.1–F3.3 e pediu os ajustes abaixo, que voltam para aprovação. Sem deploy, com o Clinics desativado em staging e **somente dados fictícios**.

**Aprovação da F3.1 (decisão do usuário, 2026-10-21).** Ela autoriza um **protótipo com dados fictícios**. A F3.1 está aprovada com estes critérios, que valem como parte da decisão:

- **Itens aprovados:** o contador, o consumo explícito, a transação única, o 409 para a repetição com escolha diferente e o preço total congelado.
- **Preço ausente significa "não informado"**, não zero nem gratuito. O zero só existe quando digitado.
- **O pacote nasce com zero sessões consumidas.** Paciente, serviço, total, preço e moeda ficam **imutáveis** nesta etapa.
- **A repetição idêntica funciona mesmo com o pacote `completed` ou `canceled`.** O registro consulta o atendimento existente **antes** de tentar um novo consumo.
- **A corrida com a última sessão:**
  - se o consumo conclui o pacote primeiro, o cancelamento **não** o transforma em `canceled` e responde 409;
  - se o cancelamento vem primeiro, o consumo falha **sem registrar atendimento**.
- **Os triggers não impedem os dois caminhos legítimos:**
  - a última sessão, que muda `active` para `completed` **na mesma instrução**;
  - o cancelamento sem incremento.

  Os dois caminhos e as recusas são cobertos por teste.

- **A exclusão em cascata do workspace** continua conforme o contrato existente.

**Retornos: a lista operacional com `clinics:schedule:read` está aprovada.**

- **O que a recepção vê:** paciente, serviço, vencimento, estado e responsável. Isso revela a necessidade de acompanhamento, e a visibilidade é aceita para a função operacional.
- **O que ela não vê:** o atendimento de origem, o pacote, o saldo e o conteúdo clínico.
- **A barreira é a API:** ela **projeta** só os campos permitidos, e esconder na tela não basta. Filtros, ordenações e respostas de erro também não podem permitir consultar indiretamente os vínculos ocultos.

**A detalhar antes da F3.2:**

1. **O que "concluir o retorno" significa:** encerrar o acompanhamento operacional ou comprovar um atendimento realizado. Marcar uma consulta não pode declarar que ela aconteceu. O vínculo com o agendamento precisa validar o workspace, o paciente e as demais regras.
2. **Quem pode registrar o quê:**
   - a recepção pode registrar a recusa do paciente e as ações administrativas;
   - "não necessário", como decisão clínica, exige `clinics:care:write`;
   - a atribuição exige membro ativo, a permissão de leitura e a permissão da ação pertinente;
   - o responsável sem acesso continua visível para reatribuição, sem ampliar permissões.

A taxa de faltas e a decisão sobre a correção de consumo seguem como aprovadas.

**Detalhamento da F3.2 (PROPOSTO, 2026-10-22).** Responde ao que ficou para detalhar antes da F3.2. Se aprovado, **substitui** três pontos do item 6 e da tabela do item 8 do plano:

- a "conclusão manual";
- a permissão de "concluir";
- a lista de motivos `patient_declined`, `not_needed` e `other`.

O resto do item 6 continua valendo: campos, criação automática e manual, vencimento pelo relógio do banco no fuso da unidade, e nada de outbox, webhook ou IA.

1. **"Concluir" é comprovar um atendimento realizado, e só o registro de atendimento comprova.**
   - **Não existe ação de "concluir".** O retorno passa a `done` quando o agendamento vinculado a ele recebe o registro de atendimento.
     - Se o vínculo já existe, isso acontece **na transação do registro de atendimento**.
     - Se o agendamento vinculado já está `attended`, acontece no momento do vínculo.
   - **Vincular um agendamento não conclui nada:** o retorno continua `pending`, agora com agendamento. Assim, marcar uma consulta nunca declara que ela aconteceu.
   - **O banco garante o critério:** um trigger recusa `done` se o agendamento vinculado não estiver `attended`.
   - **Encerrar o acompanhamento sem atendimento** é o **cancelamento**, com motivo de lista fechada (item 2). Nunca é "concluir".
   - **Sem casamento implícito:** um atendimento do mesmo paciente e serviço que não esteja vinculado não conclui retorno nenhum. É a mesma regra do consumo explícito de pacote.
   - **Agendamento vinculado cancelado ou com falta:** o retorno continua `pending`, e a lista mostra "reagendar". O vínculo não é desfeito sozinho, e a recepção vincula outro agendamento, que substitui o anterior e entra na trilha.
   - **Desvincular sem substituir** também é permitido enquanto o retorno estiver `pending`, com as mesmas permissões do vínculo. É a saída para trocar o serviço de um agendamento vinculado (item 4).
   - **A remarcação** mantém o vínculo, porque é o mesmo agendamento (item 4).

2. **Cancelamento: o motivo define a permissão.** A lista é fechada, sem texto livre e sem `other`: um "outro" sem texto não diz nada à auditoria.

   | Motivo                | Quem pode                                        | Restrição                   |
   | --------------------- | ------------------------------------------------ | --------------------------- |
   | `patient_declined`    | `clinics:schedule:write` ou `clinics:care:write` | —                           |
   | `patient_unreachable` | `clinics:schedule:write` ou `clinics:care:write` | —                           |
   | `not_needed`          | `clinics:care:write` (decisão clínica)           | —                           |
   | `created_in_error`    | `clinics:care:write`                             | só retorno **criado à mão** |
   - **Toda ação de escrita exige também `clinics:schedule:read`,** a leitura da lista.
   - **Por que `created_in_error` vale só para o retorno manual:** o automático nasce da regra do serviço. Se ele não faz sentido, a decisão é clínica (`not_needed`). Senão, a recepção contornaria a exigência de `care:write` chamando de "erro" o que é decisão clínica.
   - **Cancelar libera o vínculo:** o `appointmentId` volta a nulo, e a trilha guarda qual era. Isso libera o agendamento para outro retorno.
   - **Repetir o mesmo cancelamento** devolve o estado. Cancelar um retorno `done` é 409. A reabertura segue fora da F3.

3. **Atribuição, com as duas pontas conferidas:**
   - **Quem atribui, reatribui ou tira o responsável:** `clinics:schedule:write` ou `clinics:care:write`, e `clinics:schedule:read`.
   - **Quem pode ser responsável:** um membro **ativo** do workspace com `clinics:schedule:read` **e** com `clinics:schedule:write` ou `clinics:care:write`. Ou seja, alguém que vê a lista e consegue agir sobre o retorno. A conferência é feita **na membership viva e nas permissões do papel no momento da atribuição**, não no token de ninguém.
     - Membro inexistente ou de outro workspace: 404 neutro.
     - Suspenso, removido ou sem as permissões: 400 com uma mensagem única ("este membro não pode ser responsável por retornos"), sem dizer qual condição faltou.
   - **Ser responsável não concede nada:** nenhuma permissão é ampliada, e o responsável que perde o acesso não passa a ver o retorno por ser o responsável.
   - **"Sem acesso" é calculado na leitura,** pelo mesmo critério da atribuição. O responsável aparece com o nome e a marca "sem acesso", para alguém reatribuir. O motivo (suspensão, remoção ou papel) não aparece. Ninguém é desatribuído automaticamente, para preservar o histórico.
   - **Sem responsável:** "sem responsável". O retorno automático nasce assim.

4. **O agendamento vinculado: validações e garantias.**
   - **Mesmo workspace, mesmo paciente e mesmo serviço, garantidos pelo banco.**
     - A FK composta vai do retorno para `(workspaceId, id, patientId, serviceId)` do agendamento, apoiada num índice único novo em `ClinicsAppointment`.
     - Com `NO ACTION`, uma remarcação que troque o **serviço** de um agendamento vinculado é recusada pelo banco. A API responde 409 "desvincule do retorno antes de trocar o serviço".
     - "Mesmo serviço" é regra do protótipo, ligada à H3. Relaxá-la depois é decisão própria.
   - **Estado do agendamento:** marcado, confirmado ou chegou (vínculo aberto), ou atendido (conclui na hora). **Cancelado e falta são recusados.**
   - **Início estrito depois da criação do retorno,** pelo relógio do banco. Isso impede vincular o atendimento de origem ou qualquer visita anterior ao retorno.
   - **Um agendamento cumpre no máximo um retorno:** um índice único parcial em `appointmentId`. Num retorno `done`, o vínculo fica para sempre.
   - **Só retorno `pending` aceita vínculo.** Trocar o agendamento é permitido enquanto o retorno estiver `pending`.
   - **Concorrência** (vínculo × registro de atendimento, dois vínculos ao mesmo agendamento, cancelamento × atendimento, remarcação do serviço × vínculo):
     - **a ordem das travas é a mesma em todos os caminhos:** agendamento, depois pacote, depois retorno, para não haver deadlock;
     - **as corridas têm teste com a ordem forçada,** como na F3.1;
     - **o banco garante o desfecho:** o trigger de `done` e o índice único fazem a corrida perdida falhar fechado.

5. **Projeção e filtros, no servidor:**
   - **Com `clinics:schedule:read`:** paciente, serviço, unidade, vencimento, estado, a marca "vencido", o responsável (nome e "sem acesso") e o agendamento vinculado (id, início e estado). O motivo aparece se o retorno foi cancelado. Também vêm a criação e o encerramento.
   - **Não aparece para esse papel:** o atendimento de origem, se o retorno é automático ou manual, quem o criou, nem pacote, saldo ou conteúdo de atendimento.
   - **Com `clinics:care:read`, a mais:** o atendimento de origem e a origem (automática ou manual).
   - **Filtros e ordenação permitidos:** estado, vencido, unidade, intervalo de vencimento, responsável (inclusive "sem responsável") e paciente. A ordenação é por vencimento e, depois, por id.
   - **Proibido nos filtros e na ordenação:** nenhum filtro nem ordenação por origem, criador, atendimento de origem ou pacote, nem mesmo para `care:read`, para a lista não virar um caminho de consulta indireta.
   - **Erros:**
     - 404 neutro para retorno, agendamento ou membro inexistente ou de outro workspace;
     - 409 com mensagens que não citam atendimento nem pacote;
     - 400 por validação.

6. **Banco (migration transacional, ADR-051):**
   - **A tabela `ClinicsReturn`:**
     - FKs compostas `NO ACTION`, e o workspace em cascata;
     - o índice único parcial do agendamento;
     - o `originAttendanceId` único;
     - os CHECKs de estado: `pending` sem encerramento nem motivo; `done` com agendamento e encerramento; `canceled` com motivo e encerramento.
   - **A coluna `ClinicsService.returnIntervalDays`,** de 1 a 365 e anulável.
   - **O índice único** de apoio em `ClinicsAppointment`.
   - **Os triggers:**
     - imutáveis paciente, serviço, unidade, origem e criação;
     - só sai de `pending`;
     - `done` exige o agendamento `attended`.
   - **Ensaio da falha forçada e inventário,** antes do commit.
   - **O retorno entra** no registro do vertical, no `check:fk` e na presença da porta E6.

7. **Auditoria (allowlist, ids e enums):** `clinics.return.created` (automático ou manual), `.linked` (do agendamento anterior ao novo, ou a nenhum), `.completed` (pelo atendimento), `.canceled` (motivo) e `.assigned` (do responsável anterior ao novo).

8. **Testes previstos:**
   - **projeção:** o papel só com agenda não recebe origem nem pacote, e os filtros não sondam vínculos;
   - **permissões:** a matriz por ação e por motivo;
   - **atribuição:** membro suspenso, removido, sem permissão e de outro workspace; e a marca "sem acesso" depois da perda de acesso;
   - **vínculo:** outro paciente, serviço ou workspace; cancelado e falta; vínculo duplo; início anterior à criação; e o atendimento de origem;
   - **conclusão:** só pelo atendimento, automática nos dois sentidos, e o trigger recusando `done` sem `attended`;
   - **corridas:** com a ordem forçada;
   - **criação automática:** com e sem intervalo, e a data no fuso da unidade;
   - **cascata e isolamento:** a cascata do workspace e o workspace B;
   - **mutações:** em cada garantia.

**Fica fora da F3.2:**

- a reabertura;
- adiar o vencimento;
- as telas (F3.3);
- as notificações (F4);
- a ponte para `Task`.

**Decisões para aprovação:**

- (1) concluir só pelo atendimento registrado, sem ação manual;
- (2) os motivos e as permissões de cancelamento, com `created_in_error` só no manual;
- (3) os critérios de atribuição e o "sem acesso" calculado na leitura;
- (4) o vínculo com o mesmo paciente e serviço garantidos por FK, o que recusa trocar o serviço de um agendamento vinculado, e com o início depois da criação;
- (5) a projeção e os filtros.

**Aprovação da F3.2 (decisão do usuário, 2026-10-22).** O detalhamento acima está aprovado com os critérios abaixo, que valem como parte da decisão. Ele **substitui** os pontos do item 6 e da tabela do item 8 que o detalhamento indicou.

1. **Conclusão pelo atendimento: aprovada.**
   - Vincular uma consulta futura não conclui.
   - Vincular uma consulta **já atendida** conclui na mesma transação, com auditoria.
   - A condição **comprova o registro de atendimento correspondente**, e não confia só no rótulo `attended`.
   - Repetições não duplicam a conclusão nem o retorno automático.
2. **Cancelamento e projeção: aprovados com correção.**
   - **O motivo revela a origem.** As permissões por motivo estão corretas, mas `created_in_error` revela a origem manual, que a projeção operacional promete esconder.
   - **O que cada papel vê:** quem tem só `clinics:schedule:read` vê o estado cancelado com uma apresentação genérica, sem o motivo. O motivo detalhado exige `clinics:care:read`.
   - **A ordem das conferências:** a permissão específica do motivo é conferida no servidor **antes** de consultar a condição de origem oculta.
   - **Repetição:** repetir o cancelamento com o mesmo motivo é idempotente. Tentar outro motivo responde 409 neutro, sem alterar o registro.
3. **Atribuição: aprovada.**
   - Ser responsável não concede acesso.
   - A conferência de membro ativo e de permissões vivas fica como proposta.
   - A lista geral de membros não se abre a quem não tem `members:read`. Um seletor próprio fica limitado aos candidatos operacionais e aos campos necessários.
4. **Vínculo e concorrência.**
   - **O vínculo:** estão aprovados o mesmo paciente e serviço, o início posterior à criação e um agendamento por retorno. **A unidade também é validada**, porque o retorno tem unidade e vencimento local próprios. **Substituído:** o início posterior à criação saiu (item 3 dos ajustes, abaixo).
   - **A ordem das travas:** "agendamento → pacote → retorno" cobre também a **troca entre dois agendamentos**. Os agendamentos envolvidos são travados em ordem determinística, e o vínculo é relido antes de escrever.
   - **Os desfechos fixados:**
     - atendimento primeiro: o retorno é concluído e o cancelamento, recusado;
     - cancelamento primeiro: o retorno permanece cancelado; o atendimento pode acontecer, mas não o conclui;
     - a remarcação não pode violar a regra temporal do vínculo.
5. **ADR-051 e Definition of Done:** registrados no adendo 1 do ADR-051.

**Notas de implementação da F3.2, decididas antes do código:**

- **A prova da conclusão é estrutural:**
  - `ClinicsReturn.fulfilledByAttendanceId` tem uma FK composta `(workspaceId, appointmentId, fulfilledByAttendanceId)` para `ClinicsAttendance (workspaceId, appointmentId, id)`. O registro de atendimento precisa existir e ser **do mesmo agendamento** vinculado.
  - Um `CHECK` amarra `done` à presença dessa referência.
  - O rótulo `attended` sozinho não basta em lugar nenhum.
- **O vínculo, garantido pelo banco:**
  - a FK composta `(workspaceId, appointmentId, patientId, serviceId, unitId)` vai para um índice único novo no agendamento. Isso cobre o mesmo paciente, serviço e unidade;
  - um índice único em `(workspaceId, appointmentId)` garante um agendamento por retorno. Não é parcial: os NULLs são distintos, com o mesmo efeito;
  - **gatilhos nos dois lados guardam a regra temporal.** No retorno, o vínculo exige início posterior ao `createdAt`, que o banco escreve (ADR-049), e um estado do agendamento que aceite vínculo. No agendamento, uma remarcação que traga o início para antes da criação de um retorno pendente vinculado é recusada. **Substituído:** a regra do início saiu, com o gatilho da remarcação (ver "Ajustes da revisão do usuário", abaixo);
  - trocar o serviço de um agendamento vinculado esbarra na FK. A remarcação traduz os dois casos para 409, sem citar o retorno. **Substituído:** sobrou só o caso da FK, e a mensagem cita o retorno, porque o vínculo é visível na lista.
- **As travas:**
  - o vínculo, a troca e a desvinculação travam os agendamentos envolvidos (o novo e o anterior) em ordem de id, e escrevem o retorno com um `updateMany` condicionado ao estado e ao vínculo relidos;
  - o registro de atendimento trava o agendamento, depois o pacote, depois o retorno;
  - o cancelamento e a atribuição escrevem só o retorno, condicionados a `pending`.

  Nenhum caminho trava na ordem inversa.

  **Complementado** pelos ajustes e pela revisão delta: o vínculo trava o retorno DEPOIS dos agendamentos e o relê antes de olhar o candidato; o cancelamento e a atribuição travam o retorno ANTES de ler. A ordem continua uma só: agendamentos (em ordem de id) → pacote → retorno.

- **As mensagens:**
  - **paciente, serviço ou unidade diferentes:** 400 com o motivo, porque são fatos visíveis na agenda;
  - **agendamento cancelado ou com falta, e início anterior à criação:** um único 409 neutro ("este agendamento não pode cumprir este retorno"), sem distinguir os casos. **Substituído:** o início anterior à criação deixou de ser recusado;
  - **o que ainda vaza (corrigido depois da revisão do `security`; ver "Pendente de decisão do usuário", abaixo):** o texto original dizia "de forma grosseira", e está errado. A origem e a criação são dedutíveis por quem opera a agenda;
  - **a criação (`createdAt`)** não é projetada para quem só tem a agenda, porque aproximaria o atendimento de origem.
- **O "vencido" é calculado no Node,** e isso é um desvio do texto do plano, que dizia "pelo relógio do banco". **Não aprovado e substituído** pelo relógio do banco (ver "Ajustes da revisão do usuário", abaixo).
  - O vencimento automático é a data local, no fuso da unidade, do registro de atendimento (que o Node escreve) mais o intervalo.
  - O "hoje" é a data local do relógio do Node.
  - A comparação acontece no Node, com o mesmo relógio dos dois lados. Pelo ADR-049, quem compara define o relógio, e não há par misto.
  - Usar o relógio do banco exigiria SQL cru fora dos modelos de coordenação do client protegido, uma mudança em arquivo sensível sem ganho de garantia.
- **O seletor de responsável** (`GET /clinics/returns/assignees`) exige `clinics:schedule:read` e `schedule:write` ou `care:write`. Ele devolve só id da membership e nome dos candidatos operacionais: membro ativo com `schedule:read` e com `schedule:write` ou `care:write`. Não precisa de `members:read`, e o resto da lista de membros não aparece.
- **Os nomes vêm do padrão existente:** a membership filtrada pelo workspace e o nome em `prisma.raw.user`, com a justificativa no código.
- **Os escritores de `ClinicsReturn`:** só o serviço de retornos escreve. O registro de atendimento chama as funções dele (cumprir o vinculado, criar o automático) na própria transação. Uma regra estática fixa o arquivo único.

**Resultados da implementação da F3.2:**

- **A API:**
  - `GET /clinics/returns` (lista com os filtros permitidos) e `GET /clinics/returns/:id`: `schedule:read`, com a projeção por permissão;
  - `GET /clinics/returns/assignees`: o seletor;
  - `POST /clinics/returns`: criação manual, com `care:write`, `care:read` e `schedule:read`;
  - `POST /clinics/returns/:id/link`, `/unlink`, `/cancel` e `/assign`: `schedule:read` e a permissão da ação, ou a do motivo, conferida no serviço;
  - o serviço de catálogo ganha `returnIntervalDays`.
- **Uma decisão tomada no caminho, sobre o critério 2 da aprovação:** a repetição do cancelamento é idempotente quando é **o mesmo pedido, o mesmo motivo de quem encerrou**. Para qualquer outra pessoa, o 409 é neutro e igual. Com a regra literal, "mesmo motivo = idempotente" para qualquer um, quem só tem a agenda descobriria pelo 200 o motivo operacional de um encerramento de outra pessoa, que a projeção esconde dele. Quem repete o próprio pedido já sabe o motivo.
- **Achado da migration:** o `createdAt` usa `dbgenerated("transaction_timestamp()")`, a convenção do ADR-049. Com `now()`, o Prisma lê o default como o dele e o `migrate diff` acusava diferença; o ensaio pegou isso. O campo entrou na regra estática do relógio de agendamento: o Prisma nunca o escreve.
- **O ensaio da migration** (ADR-051 e adendo 1) foi feito pelo bloco da skill, num banco descartável:
  - a falha forçada antes do `COMMIT` deixou o schema idêntico e o inventário em zero;
  - a aplicação limpa deu inventário 35 e `migrate diff` vazio;
  - a diferença de definições nas tabelas existentes é só a declarada: em `ClinicsService`, a coluna e o CHECK; em `ClinicsAppointment`, o índice único e o gatilho; em `ClinicsAttendance`, o índice único;
  - o passo 5 do runbook foi ensaiado para esta migration, com um Postgres 17 isolado e a imagem da API fazendo o papel dos containers: o inventário do runbook deu 35, o caso íntegro chegou a "IGUAL" e depois ao `--applied`, e o gatilho adulterado fez o bloco interromper.
- **A presença da porta E6** tem doze modelos e treze consultas: p50 de 0,94–0,96 ms e p95 de 1,06–1,13 ms. O gatilho da dívida não foi cruzado.

**Revisão da F3.2 (`reviewer` e `security`, sem P0 nem P1) e o que mudou com ela:**

- **P2, dos dois: um retorno podia ser concluído pelo atendimento que o gerou, ou por um registrado antes de ele existir.**
  - **O defeito:** o registro de atendimento não confere o horário, e a paciente que chega cedo tem o registro antes do início. Com o retorno automático criado nesse registro, vincular a própria consulta passava pela regra "início posterior à criação" e concluía o retorno com o atendimento de origem.
  - **O mesmo valia para um retorno manual** criado entre um registro antecipado e o horário da consulta.
  - **Os testes não pegavam** porque a consulta de origem deles estava no passado.
  - **A correção é estrutural, pelo critério 1 da aprovação** ("comprovar o registro de atendimento correspondente"):
    - o registro de atendimento ganha `recordedAt`, escrito pelo relógio do banco. É `clock_timestamp()`, uma exceção ao ADR-049, que usa `transaction_timestamp()`: o registro pode ESPERAR a trava do agendamento, e a prova precisa do instante de depois da espera. Com o início da transação, um registro legítimo que esperou seria recusado. Os registros já existentes ficam com o instante da migration, anterior a qualquer retorno;
    - o gatilho do retorno exige, para `done`, uma prova com `recordedAt` posterior ao `createdAt` do retorno. O gatilho também força o `createdAt` na inserção, como pediu o `reviewer`;
    - um CHECK impede que a prova seja o atendimento de origem;
    - o serviço confere as duas coisas antes, com a mesma recusa neutra. Pelo caminho do registro de atendimento, a prova é sempre posterior: o vínculo precisa ter comitado antes, sob a trava do agendamento.
  - **O `reviewer` propunha** só o CHECK da origem, deixando o caso geral como resíduo. Não ficou como resíduo: um retorno manual criado logo depois de um registro antecipado não é caso raro.
- **Ordem dos locks da migration (nit do `reviewer`):** os dois `ADD COLUMN`, em `ClinicsService` e em `ClinicsAttendance`, foram para o fim. O lock exclusivo deles fica preso só até o `COMMIT`. A estimativa das esperas passou a ser de cerca de 55 s, com até onze esperas de 5 s; é estimativa, não limite.
- **P2 do `security`: o teste P0 não exercitava "não vincula agendamento de A".** Ganhou um teste: um retorno de B tentando vincular um agendamento de A recebe 404, e nada muda nos dois lados.
- **Agendamento vinculado cancelado ou com falta:** o retorno segue pendente, com o vínculo visível e o estado do agendamento, até alguém trocar ou desvincular. Agora há teste.
- **O bloco da skill** (no commit refeito como `d56445b`) exige `DADOS` e `DADOS_ESPERADO` juntos e pede semente fictícia. Foi ensaiado de novo.
- **O ensaio da migration corrigida:**
  - a falha forçada deixou o schema idêntico e o inventário em zero;
  - a aplicação deu inventário **39** e `migrate diff` vazio;
  - nas tabelas existentes mudou só o declarado, agora com a coluna `recordedAt` e o índice em `ClinicsAttendance`;
  - o passo 5 do runbook foi ensaiado de novo: inventário 39, "IGUAL" seguido de `--applied`, e o bloco interrompeu sem o CHECK da origem e com o gatilho do `recordedAt` adulterado.
- **Segunda rodada da revisão (P2 dos dois e nits): a evidência dos DADOS que a migration escreve.**
  - **O preenchimento do `recordedAt` não tinha sido exercitado:** a migration o escreve em todos os registros de atendimento existentes, e a base do ensaio não tinha nenhum. É o que o adendo 1 do ADR-051 exige para migration que escreve dado.
  - **O ensaio foi refeito** com uma semente fictícia de três registros de atendimento, com a cadeia inteira de FKs. A consulta de conferência lê a coluna por `to_jsonb(linha) ->> 'recordedAt'`, o que vale antes e depois de ela existir: contagem, preenchidos, todos anteriores ao `now()` da conferência e o `md5` dos ids.
  - **Resultado:** a falha forçada deixou schema, inventário e dados intactos (`3|0|-|md5` antes e depois da falha). A aplicação deu inventário 39, `migrate diff` vazio e os dados esperados (`3|3|true|md5`, as mesmas linhas, todas preenchidas). As três leituras saem impressas pelo bloco, que agora as mostra (veja a skill `create-migration`), e ficaram na saída guardada do ensaio.
  - **O `recordedAt` não se forja:** um gatilho próprio em `ClinicsAttendance` o força no INSERT e recusa a mudança depois. A função da F3.1, já publicada, não foi editada. Com isso o inventário passou a 39.
  - **A recusa do banco no registro de atendimento** só viria com o relógio do banco recuando: pela ordem das travas, a prova desse caminho é sempre posterior. Ela agora vira 409, com log, e o registro inteiro volta. Antes, seria 500.
- **Terceira passada (P2 do security e do reviewer):**
  - **O teste do relógio recuando desligava o gatilho do retorno para a base inteira.** Agora desliga e religa dentro de uma transação: DDL é transacional, então nenhuma outra sessão o vê desligado e um processo morto no meio não deixa a base de teste sem a guarda. A alternativa sugerida, `session_replication_role = replica`, desligaria também as FKs e exige superusuário.
  - **A leitura dos dados antes e depois da falha não ficava guardada:** o bloco do ensaio não a imprimia. Agora imprime, e o ensaio foi refeito com o mesmo resultado.
  - **As Consequências do ADR-049 ainda diziam que `clock_timestamp()` não é usado.** Ganharam uma nota apontando esta exceção, e o comentário do campo no schema passou a dizer o mesmo.

**Pendente de decisão do usuário: a origem e a criação do retorno são dedutíveis por quem opera a agenda** (P2 do `security`). **Decidido; ver o item 3 dos ajustes abaixo.**

- **De forma passiva:** num retorno automático, o vencimento é a data local do atendimento de origem mais o intervalo do serviço. O intervalo aparece no catálogo, e a agenda mostra as consultas atendidas. Uma consulta atendida do mesmo paciente, serviço e unidade na data do vencimento menos o intervalo identifica o retorno como automático e aponta a origem.
- **De forma ativa, e exata:** quem tem `schedule:write` cria agendamentos no passado e tenta vinculá-los. A regra "início posterior à criação" responde sim ou não, e por busca binária a criação sai com precisão de minutos. A recusa da remarcação dá o mesmo oráculo.
- **Recomendação:** aceitar que a origem e a criação não são sigilosas para quem opera a agenda. O vencimento e o intervalo são necessários à operação e entregam a origem de qualquer jeito. A projeção continua a não as entregar diretamente, como redução de ruído. Opcionalmente, para tirar o oráculo exato, trocar a regra aprovada "início posterior à criação" por "atendimento registrado depois da criação", que agora existe e é a que de fato protege a conclusão. Agendamento fabricado pela recepção não serve de prova, porque a recepção não registra atendimento. Isso muda uma regra aprovada, então só com a sua decisão.

**Ajustes da revisão do usuário (2026-10-22), registrados antes do código.** A revisão documental do ADR-051 foi aceita. A F3.2 volta com quatro ajustes, que valem como parte da decisão:

1. **A trilha do cancelamento registrava o vínculo errado.**
   - **O defeito:** o cancelamento lia o retorno antes do UPDATE que trava a linha. Se outra transação trocasse o agendamento vinculado nesse intervalo, o cancelamento removia o vínculo novo, mas auditava o antigo.
   - **A correção:** o cancelamento trava a linha do retorno primeiro, com um `updateMany` condicionado a `pending`, e só então lê. A transição e a trilha usam essa leitura, que é a versão efetivamente substituída. A ordem das travas não muda: o cancelamento só trava o retorno.
   - **Num retorno já encerrado,** a trava não pega nada, e a leitura é a final, porque encerrado não muda mais. A idempotência e o 409 neutro seguem iguais.
   - **A atribuição tinha o mesmo defeito** (a trilha `before` e o "nada a fazer" vinham da leitura de antes da trava), e recebe a mesma correção.
   - **Teste determinístico:** outra transação troca o vínculo (ou o responsável) e segura a linha; o pedido começa e lê; ela comita; o pedido termina. A trilha identifica exatamente o vínculo removido. A mutação que volta à leitura antiga precisa derrubar o teste.
2. **O "vencido" usa o relógio do banco, conforme aprovado no plano.** O desvio para o relógio do Node não foi aprovado: a justificativa "quem compara define o relógio" não substitui a escolha explícita do plano.
   - **Um instante do banco por operação de leitura:** `SELECT now()`, convertido para o fuso de cada unidade. O mesmo "hoje" serve ao filtro `overdue` e à projeção do campo `overdue`, e nenhuma operação lê "hoje" duas vezes.
   - **Como ler o instante:** o client protegido recusa SQL cru. A leitura vai por um helper único, `agoraDoBanco`, em `src/prisma/`, que usa `prisma.raw` com um texto fixo: sem tabela, sem parâmetro e sem dado de tenant. Isso é uma **exceção nova ao §3.3 do CLAUDE.md e ao §2 do `SECURITY.md`** ("leitura do relógio do banco"), registrada nos dois. Um teste estático fixa o texto e o arquivo único.
   - **Alternativas rejeitadas:**
     - pôr a leitura entre os modelos de coordenação do ADR-047 (`coordination-sql.ts`) misturaria propósitos numa lista que é decisão de segurança da guarda de uso externo;
     - uma view com `now()` dependeria de recurso em preview no Prisma;
     - o filtro em SQL cru exigiria a consulta inteira fora do client protegido.
   - **Testes:** a unidade fica num fuso escolhido na hora do teste, com o meio-dia local do banco. O Node é deslocado a partir dos minutos do banco desde a meia-noite local: cai por volta das 06h de amanhã e das 18h de ontem, com pelo menos 6 h de folga. O filtro e a projeção precisam dar a resposta do banco nos dois sentidos. Um teste conta uma leitura do relógio do banco por operação.
   - **O vencimento automático também passa ao relógio do banco** (revisão delta do `reviewer`). O texto anterior dizia que ele "não muda", por ser "um dado do registro, e não um agora", e estava errado: o `completedAt` é um `new Date()` do Node, e compará-lo com o "hoje" do banco era o par misto do ADR-049. A base agora é o `recordedAt` do registro, forçado pelo banco e devolvido pelo INSERT.
3. **A inferência da origem e da criação: decidida pelo usuário.**
   - **Aceito:** a recepção pode correlacionar vencimento, serviço e agenda e formular hipóteses operacionais. Isso não equivale a garantir que a origem seja indedutível.
   - **Não aceito:** uma consulta que permita descobrir com precisão um campo oculto por tentativas de vínculo.
   - **Decisão: sai a condição "início posterior à criação".** Ela sai do serviço, do gatilho do retorno e da remarcação. O gatilho `ClinicsAppointment_return_temporal` e a função dele deixam a migration, porque só guardavam essa regra. A migration ainda não foi publicada, então é editada no lugar; nenhuma migration publicada muda.
   - **Fica:** a exigência de atendimento registrado DEPOIS da criação, com o `recordedAt` imposto pelo banco; a recusa do atendimento de origem; e nenhuma conclusão sem registro.
   - **Consequência registrada:** um agendamento iniciado antes da criação do retorno poderá cumpri-lo se o atendimento for registrado depois. O sistema comprova a ordem dos registros, e não que a visita física ocorreu depois. A regra permanece **hipótese do protótipo, sujeita à validação operacional**.
   - **O critério "a remarcação não pode violar a regra temporal do vínculo"** passa a valer sem gatilho: a regra temporal agora é sobre o instante do registro, que a remarcação não muda. Trocar o serviço, a unidade ou o paciente de um agendamento vinculado continua esbarrando na FK do vínculo, com 409.
   - **O que o vínculo ainda responde (inferência residual aceita para o protótipo):** vincular um agendamento JÁ ATENDIDO e LIVRE diz se o registro dele é anterior à criação (409) ou posterior (conclui). As respostas revelam essa relação temporal, e isso é sondagem possível. O texto anterior dizia "não é uma sonda por tentativas", e estava errado (correção pedida pelo usuário). O que limita a informação, sem eliminá-la:
     - o `recordedAt` não é escolhido por ninguém (o banco o impõe) e não é projetado;
     - cada resposta positiva conclui o retorno, de forma irreversível e auditada, o que limita as tentativas positivas;
     - os candidatos são só os atendimentos do mesmo paciente, serviço e unidade.
   - **Corrigido na revisão delta do `security` (P2):** um agendamento atendido que JÁ cumpre outro retorno não concluía nada, e a resposta mudava conforme o registro dele (o 409 neutro ou o do índice único "já vinculado"). Era uma sonda repetível, sem trilha. Agora o vínculo alheio é conferido antes do estado e da prova, com uma consulta sob a trava do agendamento, e a resposta é sempre "já está vinculado a outro retorno", um fato visível na lista. O índice único fica como rede.
   - **Inferência passiva e exata, aceita no item acima:** na cadeia automática, o registro que conclui um retorno cria o seguinte na mesma transação, e o `closedAt` do primeiro (projetado à agenda) é igual ao `createdAt` do segundo. Esconder o `createdAt` de quem só tem a agenda reduz ruído; não garante sigilo.
   - **Testes:** variar apenas o início de um agendamento elegível (antes e depois da criação, perto e longe) dá a mesma resposta no vínculo e na remarcação, sem sondar `createdAt`. Continuam as provas: o atendimento anterior é recusado, a origem é recusada e nada conclui sem registro.
4. **Cancelamento repetido: aceito como implementado.** A idempotência fica limitada ao mesmo ator e ao mesmo motivo, com as permissões ainda válidas: a permissão do motivo é conferida antes de qualquer leitura, também na repetição. O 409 neutro para os demais evita revelar o motivo de outra pessoa. Um teste cobre a repetição depois da perda da permissão (403, e não 200).

**Depois dos ajustes:** a revisão delta do `reviewer` e do `security`, os testes, o ensaio da migration ajustada (o inventário passa de 39 para 37 objetos), a bateria final e um novo hash local para liberação. Sem push, deploy ou ativação; só dados fictícios.

**Resultados dos ajustes:**

- **A trava antes da leitura** é um `updateMany` sem efeito (`status` de `pending` para `pending`), condicionado a `pending`. O gatilho do retorno passa por ele sem recusar nem mudar nada: os imutáveis são iguais e o vínculo não muda. No registro de atendimento, o retorno continua sendo a última trava, e o cancelamento e a atribuição só travam o retorno. Os testes das corridas atendimento × cancelamento, nas duas ordens, seguem verdes.
- **O "vencido"** lê `agoraDoBanco` uma vez por operação. A lista com o filtro `overdue` passa o mesmo mapa de "hoje" à projeção, e uma regra estática fixa a exceção do `raw`.
- **A remarcação** ficou só com a FK do vínculo, e a mensagem não fala mais em horário. O `postgresErrorMessage`, que só servia ao gatilho removido, saiu de `prisma-exception.filter.ts`.
- **O ensaio da migration ajustada** usou o bloco da skill e a semente fictícia:
  - a falha forçada deixou schema, inventário e dados intactos (`3|0|-|md5` antes e depois da falha);
  - a aplicação deu inventário **37**, `migrate diff` vazio e os dados esperados (`3|3|true|md5`);
  - nas tabelas existentes mudou só o declarado: em `ClinicsAppointment`, agora só o índice único.
- **O passo 5 do runbook foi ensaiado de novo,** com o Postgres 17 isolado e a imagem da API: o inventário deu 37, o caso íntegro chegou a "IGUAL" e ao `--applied`, e o gatilho do retorno adulterado fez o bloco interromper.
- **As bases locais** (`veyra` e `veyra_test`) receberam o delta e o checksum novo da migration, que não foi publicada. A `veyra_test` ficou idêntica a uma aplicação do zero, também depois das mutações de banco. A `veyra` só difere pela tabela `public.t`, que não faz parte desta entrega.

**Revisão delta (`reviewer` e `security`, os dois aprovando com ressalvas, sem P0 nem P1) e o que mudou com ela:**

- **P2 do `security`: o agendamento que JÁ cumpre outro retorno virava sonda.** Corrigido com a conferência do vínculo alheio antes do estado e da prova (ver o item 3 dos ajustes).
- **P2 do `reviewer`: uma troca concorrente fazia o vínculo responder conforme a prova.** Se outra escrita mudasse o vínculo entre a leitura e o UPDATE, a prova positiva respondia "mudou", sem concluir, e a negativa, a recusa neutra: outra sonda sem conclusão. Agora o vínculo trava o retorno depois dos agendamentos (a mesma ordem) e o relê. Se mudou, responde "mudou" (ou "encerrado") antes do vínculo alheio, do estado e da prova. O mesmo pedido concorrente é idempotente.
- **P2 do `security`: a camada executável** tinha a lista antiga de exceções do `raw`. A skill `review-tenant-isolation` e o `ARCHITECTURE.md` passaram a citar a leitura do relógio e a apontar o §2 do `SECURITY.md` como lista canônica.
- **Nits:**
  - a regra estática ficou estrita: um só `.raw` e um só SQL cru no arquivo do relógio, e a leitura do relógio por SQL cru em string também é pega nos outros arquivos. As quatro evasões apontadas foram conferidas e caem;
  - o helper avisa que roda fora de transação;
  - a trava sem efeito registra que depende de READ COMMITTED;
  - os comentários dizem "não projetada", e não "oculta";
  - o vencimento automático passa ao `recordedAt` (acima);
  - o teste do fuso ganhou folga de 6 h nos dois sentidos (antes, no sentido para trás, a folga podia ser de minutos);
  - a remarcação e o item 4 da aprovação ganharam a marca "Substituído";
  - fora do delta, o `PRODUCT_BRIEF.md` e o `ARCHITECTURE.md` ainda descreviam o retorno como `Task` do Core, e foram corrigidos.
- **Confirmação dos dois (sem P0 nem P1, sem deadlock novo).** O que veio dela:
  - **`reviewer`:** faltava o teste do mesmo vínculo feito concorrentemente (idempotente, 201, sem trilha nova), e ele entrou. O teste da troca contra o atendimento passou a conferir a mensagem "encerrado". A docstring do vínculo e este texto ganharam a trava do retorno.
  - **`security`:** o comentário da trava sem efeito foi corrigido. Em REPEATABLE READ, ela falharia com erro de serialização (falha fechada), e não leria a versão velha.
  - **Resíduo aceito, do `security`:** a regra estática do relógio não pega toda forma de ler o relógio por SQL cru noutro arquivo, como `Prisma.sql` aninhado, `statement_timestamp()` ou `now()` no meio da lista do SELECT. Ampliar o padrão pegaria os usos legítimos de `now()` em cláusulas de outras consultas, como as do outbox. Não há risco de tenant, porque ler o relógio não expõe dado. Quem barra um `raw` novo continua sendo a revisão, pelo passo 2 da skill `review-tenant-isolation`.
- **Os ensaios da migration foram refeitos sobre o texto final** (o comentário mudou, e o checksum com ele): os dados deram `3|0|-|md5` antes e depois da falha e `3|3|true|md5` depois da aplicação, com inventário 37 e diff vazio. No passo 5, o inventário deu 37, o caso íntegro chegou a "IGUAL" e ao `--applied`, e o gatilho adulterado fez o bloco interromper.

**Decisão do usuário sobre a F3.2 (2026-10-22), com o push autorizado:**

- **Os quatro ajustes estão aprovados.**
- **A exceção do `agoraDoBanco` é aceita estritamente como implementada:** consulta fixa, sem parâmetros, sem tabelas e sem dados de workspace, usada fora de transação. **Não autoriza ampliar o acesso por `raw`.**
- **As inferências temporais ficam para o protótipo com dados fictícios:**
  - a data de encerramento continua visível à recepção;
  - a inferência passiva da cadeia automática (o `closedAt` de um retorno igual ao `createdAt` do seguinte) fica como está documentada;
  - a resposta do vínculo a um agendamento atendido e livre fica registrada como inferência residual aceita, sem afirmar ausência de sondagem.

  São aceitas para o protótipo; um piloto com dados reais exige revisitá-las.

- **Esta correção de texto** vai em documentação separada, sem alterar a migration nem reabrir o código aprovado.

**Testes da F3.2** (dados fictícios):

- **Integração, `clinics-returns` (40):**
  - **criação:**
    - o automático é pendente, sem responsável, com vencimento na data local mais o intervalo; o serviço sem intervalo não gera nada, e a repetição não duplica;
    - **o vencimento automático vem do relógio do banco:** com o Node do outro lado da meia-noite local, nos dois sentidos, ele é a data local do banco mais o intervalo;
    - o manual exige `care:write`; o intervalo vai de 1 a 365; o serviço arquivado é recusado;
  - **conclusão:**
    - consulta futura vinculada não conclui; o registro dela conclui uma vez, com a prova;
    - vincular uma consulta já atendida conclui na hora;
    - não há casamento implícito;
    - nem o atendimento de origem, com a consulta no futuro e registrada antes do horário, nem um registro anterior a um retorno manual concluem o retorno;
  - **vínculo:**
    - outro paciente, serviço ou unidade dá 400; cancelado, falta e o atendimento de origem dão o mesmo 409 neutro;
    - um agendamento cumpre um retorno só;
    - a troca e a desvinculação funcionam; o encerrado é recusado;
    - a remarcação que troca o serviço dá 409, sem mudança; o horário é livre;
    - **variar apenas o início não sonda a criação:** quatro inícios, longe e perto, antes e depois da criação, dão a mesma resposta no vínculo e na remarcação, e o banco aceita o vínculo a um início anterior;
    - **a consequência registrada:** o agendamento iniciado antes da criação cumpre o retorno com o atendimento registrado depois; registrado antes, não;
    - **o agendamento que já cumpre outro retorno** dá a mesma recusa ("já está vinculado"), seja o registro dele anterior ou posterior à criação, e também quando ainda não foi atendido;
    - o agendamento vinculado cancelado deixa o retorno pendente, com o vínculo visível, até a troca;
  - **cancelamento:**
    - motivo clínico dá 403 para a recepção, antes da origem, também no automático;
    - `created_in_error` no automático dá 409 para o profissional;
    - a repetição pelo mesmo autor é idempotente; outro motivo, outro autor e retorno concluído dão o mesmo 409;
    - a repetição depois da perda da permissão do motivo dá 403, sem mudança;
    - o cancelamento libera o agendamento;
  - **atribuição:**
    - o guest, um papel que escreve a agenda sem lê-la, um membro suspenso e um de outro workspace são recusados, com a mesma mensagem nos três primeiros;
    - "sem acesso" aparece depois da suspensão e da perda de papel, e ser responsável não dá leitura;
    - o seletor traz só id e nome dos candidatos, funciona para o `Profissional` sem `members:read` (cuja lista de membros segue fechada) e é recusado ao guest;
  - **projeção e filtros:**
    - quem tem só a agenda não recebe origem, motivo nem criação;
    - os filtros permitidos funcionam, e filtro ou ordenação fora da lista dá 400;
    - **o "vencido" é do relógio do banco:** numa unidade ao meio-dia local, com o Node do outro lado da meia-noite local nos dois sentidos (cerca de 06h de amanhã e 18h de ontem), o filtro, a lista e o detalhe dão a resposta do banco;
    - uma leitura do relógio do banco por operação, na lista com e sem filtro e no detalhe;
  - **banco:**
    - concluir exige a prova do mesmo agendamento; o cancelado sem motivo é recusado pelo CHECK;
    - a prova não é o atendimento de origem (CHECK) nem um registro anterior à criação (gatilho);
    - o `recordedAt` é forçado no INSERT, mesmo com outro valor enviado, e imutável;
    - a recusa da prova no registro de atendimento, com o relógio do banco recuando (simulado), vira 409, e o registro, a transição e a conclusão voltam;
    - nascer fora de pendente, mudar o imutável junto de um caminho legítimo, mexer no encerrado, vincular a atendido mantendo pendente, e `created_in_error` com origem são recusados;
    - a FK cruzada de workspace recusa; a exclusão do workspace cascateia;
  - **corridas, com a ordem forçada:**
    - atendimento × cancelamento, nas duas ordens;
    - troca × atendimento do agendamento anterior, nas duas ordens;
    - duas trocas simultâneas do mesmo retorno;
    - dois retornos disputando o mesmo agendamento;
    - **a trilha do cancelamento e a da atribuição** registram a versão efetivamente substituída, com outra transação trocando o vínculo (ou o responsável) depois da leitura inicial do pedido;
    - **o vínculo com o retorno mudado por outra escrita** dá a mesma resposta ("mudou") para um candidato com prova posterior e um com prova anterior, sem concluir nada;
    - **o mesmo vínculo feito por outra escrita** no meio do pedido é idempotente (201), sem trilha nova;
  - **P0 de isolamento:**
    - o workspace B não lê, não vincula, não cancela nem atribui retorno de A;
    - um retorno de B não vincula agendamento de A (404), e nada muda nos dois lados.
- **Suíte de restrição:** a presença pelo retorno.
- **Unitários:**
  - os escritores de `ClinicsReturn`;
  - os estados e motivos iguais no contrato e no banco;
  - o `createdAt` na regra do relógio do banco;
  - a leitura do relógio do banco só em `relogio-do-banco.ts`, com o texto fixo. Trocar o texto ou ler `now()` por SQL cru noutro arquivo derruba a regra; os dois casos foram conferidos.
- **Mutação (refeita sobre o código final, depois dos ajustes e da revisão delta): 38, das quais 36 morrem,** cada uma pelo teste esperado e todas compilando:
  - **28 de código.** As duas equivalentes sobrevivem, como antes: são as pré-checagens da prova no serviço, e o banco recusa a mesma prova pelo CHECK e pelo gatilho. Ficam como defesa em profundidade;
    - o atendimento não cumpre;
    - o automático sem intervalo;
    - o vínculo a atendido não conclui;
    - o motivo clínico pela agenda;
    - a projeção que vaza;
    - a idempotência sem o autor;
    - a trava só do agendamento novo;
    - o vínculo sem a releitura do retorno travado (morre pelo teste do vínculo com o retorno mudado);
    - o vínculo sem a releitura e sem a escrita condicionada (morre pelas duas trocas simultâneas);
    - o vínculo sem travar o retorno antes de reler;
    - o mesmo vínculo concorrente sem a idempotência da releitura;
    - sem conferir a unidade;
    - o responsável sem a exigência de leitura;
    - o responsável sem a exigência de estar ativo;
    - o acesso sem o estado;
    - a remarcação sem a tradução;
    - o cancelamento sem a checagem de origem;
    - o serviço aceitando a prova de origem (equivalente);
    - o serviço aceitando a prova anterior à criação (equivalente);
    - o registro de atendimento sem traduzir a recusa da prova;
    - o cancelamento lendo antes da trava (a leitura antiga);
    - a atribuição lendo antes da trava;
    - o "vencido" pelo relógio do Node;
    - duas leituras de "hoje" na mesma operação;
    - o serviço voltando a exigir o início posterior à criação;
    - o vínculo sem conferir o vínculo alheio antes da prova;
    - o vencimento automático pelo relógio do Node;
    - a repetição do cancelamento antes da conferência da permissão;
  - **10 de banco,** trocando a função ou derrubando a restrição na base de teste e restaurando em seguida:
    - o gatilho voltando a exigir o início posterior à criação;
    - o pendente apontando para atendido;
    - sem o CHECK de estado;
    - sem a FK da prova;
    - a remarcação com o gatilho temporal de volta;
    - sem o CHECK de `created_in_error`;
    - sem o CHECK da origem;
    - o gatilho aceitando a prova anterior à criação;
    - o `recordedAt` sem ser forçado no INSERT;
    - o `recordedAt` mutável.
- **O teste em cadeia da G3.3** (`clinics-webhook-guard`, "em CADEIA, a entidade RAIZ também é travada") falhou por timeout de 30 s. Foi uma vez numa rodada das suítes do Clinics e uma em três rodadas isoladas. Depois passou 20 vezes seguidas, inclusive com um monitor do banco a cada segundo.
  - **É o mesmo teste da falha da b48,** anterior à F3.2.
  - **Investigado:** não houve erro do banco nem checkpoint na janela, e as conexões derrubadas no log são dos próprios testes da guarda. Também não houve sinal de porta indisponível nessa suíte.
  - **Causa não identificada,** e não atribuída ao ambiente.
  - **O teste foi instrumentado:** cada espera sem prazo dele (a entrega chegar ao destino, terminar, e a troca terminar) agora falha em 20 s dizendo qual etapa travou, com o estado do destino, da sessão da guarda e das sessões do banco. A próxima ocorrência traz a evidência.

**H2, H3 e H6 continuam não validadas.** A aprovação técnica deste plano não equivale à validação operacional.

**Detalhamento da F3.3 (PROPOSTO, 2026-10-22).** O escopo aprovado é a taxa de faltas na API, as telas de pacote, saldo, retornos e faltas, e o e2e. A F3.3 não tem migration: a taxa usa o índice `(workspaceId, unitId, startsAt)`, que já existe, e nada muda no que a F3.1 e a F3.2 garantem no banco. Somente dados fictícios, sem deploy e sem ativação.

1. **Duas entregas, cada uma com `reviewer` e `security`, bateria completa e parada para revisão:**
   - **F3.3a, na API:** a taxa de faltas, os candidatos ao vínculo de um retorno e a leitura de um paciente por id;
   - **F3.3b:** as telas e o e2e, sobre a API já revisada.

   A recomendação é separar porque a F3.3a mexe em autorização e em agregação, e merece revisão própria antes das telas, que são a parte maior.

2. **Taxa de faltas (F3.3a), conforme o item 7 do plano.**
   - **Rota:** `GET /api/clinics/metrics/no-show?from&to&unitId&professionalId&serviceId`, com `clinics:schedule:read`. Os nomes seguem o contrato em inglês, como `dueFrom` e `dueTo` dos retornos, e não `de` e `ate` do texto do plano.
   - **Período:** datas locais `[from, to)`, com `from < to` e no máximo 366 dias. A unidade é obrigatória quando há mais de uma ativa, como na criação do retorno. O recorte por profissional e por serviço é opcional.
   - **Resposta, só agregados, com DTO estrito:** `attended`, `noShow`, `rate` (`faltas / (atendidos + faltas)`; `null` só quando atendidos + faltas = 0, o "sem dados". Com atendidos e nenhuma falta, a taxa é 0 %, legítima), `pendingPast` (marcados, confirmados e chegados com início antes de agora) e `canceled` (à parte, fora da conta). Nenhuma pessoa, nenhum id de agendamento.
   - **"Antes de agora" pelo relógio do banco:** reusa o `agoraDoBanco`, uma leitura por operação e fora de transação. É o mesmo helper, com a mesma consulta fixa: nenhum `raw` novo. Como a aceitação da exceção foi "estritamente como implementada", **um segundo ponto de uso precisa de aprovação explícita**.
   - **Conversão do período: desvio do texto do plano, para decidir.** O plano diz "convertidas no banco". No banco, isso exigiria SQL cru com parâmetros (`AT TIME ZONE`), e a exceção do `raw` não autoriza ampliar o acesso. A recomendação é converter com `resolverHoraLocal`, a mesma função que converte a data e a hora locais em `startsAt` quando o agendamento é criado. É cálculo de fuso puro, sem relógio, e os limites ficam consistentes com a forma como o início foi gravado.
   - **Contagem:** dois `groupBy` por estado no client protegido, um sobre o período e outro sobre o período antes de agora. Sem persistência. As duas consultas podem observar estados diferentes, porque várias mudanças concorrentes podem acontecer entre elas. Isso se aceita para este indicador operacional e fica registrado. _(Corrigido na decisão do usuário sobre a F3.3a: o texto anterior limitava a diferença a um, e não há esse limite.)_
   - **Testes:**
     - a definição: o denominador, o "sem dados", os cancelados à parte e os passados sem desfecho;
     - os limites do período no fuso da unidade, com um agendamento às 23h30 locais do último dia;
     - o relógio do Node deslocado não muda os passados sem desfecho;
     - o RBAC, inclusive o guest;
     - o P0 de isolamento: o workspace B não conta nada de A;
     - o DTO estrito.

3. **Candidatos ao vínculo (F3.3a, rota nova e pequena):** `GET /api/clinics/returns/:id/candidates`, com `schedule:read` e a ação do retorno (`schedule:write` ou `care:write`).
   - **O que devolve:** os agendamentos do mesmo paciente, serviço e unidade, em estado que aceita vínculo e sem outro retorno, ordenados pelo início, com no máximo 50. Os campos são `id`, `startsAt`, `status` e o nome do profissional. Para retorno encerrado, a resposta é 409.
   - **Sem filtrar pela prova.** Um agendamento atendido e livre aparece sem dizer se concluiria o retorno. Filtrar pela prova daria, sem custo, exatamente a informação que o vínculo só revela concluindo (a inferência residual aceita).
   - **Alternativa:** vincular pelo cartão da agenda, sem rota nova. A recomendação é a rota, porque a recepção trabalha a lista de retornos, e o servidor decide a elegibilidade num lugar só.

4. **Paciente por id (F3.3a):** `GET /api/clinics/patients/:id`, com `schedule:read` e a mesma projeção da lista. O `contactId` só vai para quem tem `contacts:read`. Serve à ficha, que precisa funcionar por link direto.

5. **Telas (F3.3b).** Estado de servidor só no TanStack Query, com a chave incluindo a membership, como hoje. Nada do vertical é consultado antes do status ativo confirmado. Esconder é usabilidade: quem garante é o servidor.
   - **Ficha do paciente** (`/clinics/patients/:id`, `schedule:read`): os retornos do paciente e, só com `care:read`, a seção **Pacotes**.
     - Os pacotes mostram serviço, total, consumidas, restantes, estado e o preço total registrado. O preço é chamado "registrado", e não "pago": a D1 segue aberta.
     - **Criar** (`care:write` e `schedule:read`): serviço, total de sessões e preço total opcional digitado, com uma confirmação que mostra o que fica congelado.
     - **Cancelar** (`care:write`): uma confirmação que diz que as consumidas ficam e que não há reabertura.
   - **Registro de atendimento na agenda** (`care:write`), com o consumo explícito do item 4 do plano:
     - um diálogo lista os pacotes ativos do paciente para aquele serviço, com saldo, e a opção "Avulso";
     - mostra o saldo antes e depois, e o botão nomeia a escolha;
     - **sugestão:** com exatamente um pacote elegível, ele vem pré-selecionado; com dois ou mais, nada vem marcado e a escolha é obrigatória;
     - sem `care:read`, que é preciso para listar os pacotes, só "Avulso", com o aviso;
     - o 409 da repetição com outra escolha aparece como o servidor responde, sem nova tentativa automática.
   - **Retornos** (`/clinics/returns`, `schedule:read`, item novo na navegação):
     - **filtros:** estado, vencido, responsável (inclusive "sem responsável"), paciente e período de vencimento;
     - **colunas:** paciente, serviço, vencimento, "vencido" (do servidor), responsável (com "sem acesso"), agendamento vinculado e estado;
     - **ações, conforme a permissão:**
       - vincular, por um diálogo com os candidatos e um aviso de que vincular uma consulta já atendida pode concluir o retorno;
       - desvincular;
       - cancelar: só os motivos operacionais para quem tem só `schedule:write`; todos para `care:write`, e "criado por engano" só no retorno manual, que só quem tem `care:read` enxerga;
       - atribuir, com o seletor próprio;
       - criar manualmente (`care:write`).
     - **Projeção:** quem tem só a agenda vê o cancelado de forma genérica, sem motivo. A tela nunca pede o que a resposta não traz.
   - **Faltas** (`/clinics/no-show`, `schedule:read`, item novo na navegação):
     - período (por padrão, os últimos 30 dias até hoje, em datas locais), unidade e recorte;
     - mostra a taxa ou "sem dados", "X faltas em Y (atendidos + faltas)", os passados sem desfecho (com o caminho para a agenda) e os cancelados à parte;
     - sem gráfico e sem pessoas.
   - **Testes de componente (Vitest):** a renderização por permissão, o diálogo de consumo (sugestão, saldo e escolha obrigatória), os motivos de cancelamento por permissão e o "sem dados".

6. **E2E (Playwright, dados fictícios, na F3.3b):**
   - o profissional cria um pacote na ficha, registra o atendimento escolhendo o pacote e vê o saldo cair de 10 para 9. A repetição não consome;
   - a recepção não vê pacotes nem saldo na ficha, e a API responde 403. Ela vê os retornos, vincula uma consulta futura pelo diálogo, atribui um responsável e cancela com motivo operacional. O cancelado clínico aparece genérico para ela;
   - o retorno automático nasce do atendimento de um serviço com intervalo, e o registro do agendamento vinculado o conclui;
   - na tela de faltas, uma falta e um atendimento dão 50 % ("1 em 2"), e um período vazio dá "sem dados";
   - o link direto para uma tela sem permissão mostra a recusa.

7. **Integrar ou construir:** os componentes existentes (primitivos Radix/shadcn) e o TanStack Query/Table. Nenhuma biblioteca nova e nenhum gráfico.

**Fica fora da F3.3:** a interface multiunidade, as notificações (F4), a D1 (pagamento), a reabertura de pacote, a correção de consumo (obrigatória antes do piloto), a exportação e o atalho "agendar o retorno" com a agenda pré-preenchida.

**Decisões para a aprovação:**

1. as duas entregas, F3.3a e F3.3b (item 1);
2. o `agoraDoBanco` num segundo ponto de uso, a taxa de faltas, sem `raw` novo (item 2);
3. a conversão do período com `resolverHoraLocal`, e não no banco: é um desvio do texto do plano (item 2);
4. a rota de candidatos sem filtrar pela prova, em vez do vínculo pelo cartão da agenda (item 3);
5. a regra de sugestão do diálogo de consumo: pré-selecionar só quando há exatamente um pacote elegível (item 5);
6. a ficha do paciente por rota própria, com a leitura por id (itens 4 e 5).

**Aprovação da F3.3 (decisão do usuário, 2026-10-22), com condições que valem como parte da decisão.** A F3.2 está encerrada, publicada e validada. O plano original da F3 se mantém, sem reduzir o escopo. A divisão em F3.3a (API) e F3.3b (telas e e2e) está aprovada, e as condições abaixo **substituem** o que divergir no detalhamento acima.

1. **Relógio e período da taxa de faltas.**
   - **O relógio:** reutiliza o `agoraDoBanco` sem alterar o helper nem ampliar a exceção de SQL cru, com um único instante do banco por operação.
   - **A conversão:** os limites do período são convertidos na aplicação, com as funções compartilhadas de fuso.
   - **O contrato deixa explícito:** as datas são locais da unidade, o início é inclusivo e o limite final é exclusivo, sempre pelo **início do agendamento**.
   - **A regra do limite de dia, documentada antes do código.** Um dia local não tem sempre 24 horas, e a meia-noite pode não existir ou se repetir. A função atual (`resolverHoraLocal`) devolve "inexistente" ou "ambígua" para esses casos, e por isso a regra fica definida aqui: **o início do dia local D é o primeiro instante cuja data local é D.**
     - Se a meia-noite existe uma vez, é ela.
     - Se a meia-noite se repete, é a primeira ocorrência. Exemplo: Havana, 2025-11-02.
     - Se a meia-noite cai no pulo, é o instante em que o pulo termina, o primeiro horário local que existe naquele dia. Exemplos: São Paulo, 2018-11-04, e Santiago, 2025-09-07.
     - O período `[from, to)` vai do início de `from` ao início de `to`, sem presumir 24 horas por dia. Exemplo: São Paulo, 2019-02-16, um dia de 25 horas.
     - Conferido na base de fusos do runtime. A regra vira uma função compartilhada nos contratos (`inicioDoDiaLocal`), com testes desses casos e de um dia comum.
   - **Testes exigidos:** as mudanças de horário de verão e os limites de dia, com agendamentos encostados nos dois limites.
   - **A taxa:**
     - "sem dados" vale **só** quando atendidos + faltas = 0, e então a taxa é nula (`null`), não zero;
     - com atendimentos e nenhuma falta, a taxa é 0 %, legítima;
     - os cancelados e os passados sem desfecho ficam separados, fora do denominador.
2. **Consumo de pacote (F3.3b).**
   - **Nenhum pacote é pré-selecionado**, nem quando há só um elegível. A pessoa escolhe explicitamente "avulso" ou um pacote, e antes de confirmar vê o pacote e o saldo antes e depois.
   - **Falha ao carregar os pacotes não vira escolha automática por "avulso".** O diálogo mostra a falha, oferece recarregar e não confirma enquanto não houver lista.
   - **Se o saldo mudar até a confirmação,** a recusa do servidor é apresentada e as opções são atualizadas. Nunca se troca de pacote nem se registra "avulso" em silêncio.
   - **Sem `care:read`,** que é preciso para listar pacotes, a pessoa não vê pacotes e registra só "avulso", explicitamente e com o aviso.
3. **Candidatos ao vínculo do retorno (F3.3a).**
   - **Permissões:** as mesmas da ação de vincular (`schedule:read` na rota, e `schedule:write` ou `care:write`). A rota respeita o workspace e devolve só dados operacionais permitidos.
   - **A lista independe da prova temporal e da origem oculta do atendimento**, inclusive na contagem, na ordenação e na paginação. Os critérios são só os visíveis na agenda:
     - o mesmo paciente, o mesmo serviço e a mesma unidade;
     - um estado que aceita vínculo;
     - nenhum vínculo a outro retorno.

     Por isso, o agendamento do atendimento de origem aparece como qualquer outro, e o vínculo dele é recusado com a mesma resposta neutra. Não há selo de "pode concluir".

   - **É uma seleção de candidatos, não uma garantia de sucesso:** o vínculo reconfere tudo na transação.
   - **Sem truncamento silencioso:** a resposta é paginada, com `limit` explícito (padrão 20, máximo 50), ordem por início e id, e `nextCursor` quando há mais. Há também um filtro opcional `from`, uma data local da unidade convertida pela mesma regra do início do dia.
4. **Paciente por id e telas.**
   - **A leitura por id** tem a mesma autorização e a mesma projeção da lista, inclusive a omissão de `contactId` sem `contacts:read`. O acesso direto à URL não contorna isso. Outro workspace recebe 404.
   - **Sem `care:read`,** a seção de pacotes não aparece e **nenhuma consulta a pacotes é feita**. Os testes da F3.3b cobrem também a troca de sessão, a falha de recarga e as respostas antigas.
5. **Sequência e aceite.**
   - **A F3.3a começa depois deste registro.** Ela termina com `reviewer`, `security` e bateria sobre a versão final, e com o commit local, e para para revisão antes do push e da F3.3b.
   - **O e2e da F3.3b inclui:**
     - o "sem dados" e o 0 % legítimo;
     - a escolha explícita entre avulso e pacote;
     - a recepção sem acesso aos dados de atendimento e de pacote.

Sem deploy, sem ativação do Clinics e sem dados reais. Os bloqueios operacionais e de piloto permanecem.

**Resultados da F3.3a (API), para revisão.**

- **Complemento da regra do limite de dia: PROPOSTO na F3.3a, a confirmar pelo usuário.** Ele muda uma regra aprovada, por isso fica fora do bloco da aprovação.
  - **O achado:** uma varredura de todos os fusos do runtime mostrou que um dia local pode **não existir**. Samoa (`Pacific/Apia`) e Tokelau (`Pacific/Fakaofo`) atravessaram a linha de data e pularam 2011-12-30 inteiro. A regra aprovada ("o primeiro instante cuja data local é D") não define nada para esses dias, e a função lançava erro.
  - **A proposta:** o início do dia local D passa a ser **o primeiro instante cuja data local é D ou posterior**. Para todo dia que existe, o resultado é o mesmo da regra aprovada. Para um dia que não existe, é o início do dia seguinte que existe. Assim, em Samoa, fica vazio só o intervalo que corresponde exclusivamente ao dia pulado, `[2011-12-30, 2011-12-31)`, porque os dois limites coincidem. Um período maior que comece nesse dia continua incluindo os dias existentes seguintes: `[2011-12-30, 2012-01-01)` inclui o dia 31. E `[2011-12-29, 2011-12-31)` tem 24 horas.
  - **A ordem:** o texto desta proposta foi escrito antes do código dele, na mesma sessão, e vai para um commit de documentação separado, antes do commit da F3.3a.
  - **As varreduras:** 418 fusos, nos dias de mudança de deslocamento e nos vizinhos.
    - De 2000 a 2100, o intervalo que o contrato aceita, não há nenhum erro, e o resultado é sempre exatamente o primeiro instante. Os únicos dias com o início lido em outra data são os dois que não existem. O `reviewer` confirmou isso com uma verificação própria, que não usa a lógica da função, em cerca de 140 mil dias.
    - De 1970 a 1999, um caso falha: Monrovia 1972, com deslocamento em segundos, de antes da padronização. O contrato já recusa anos antes de 2000.
  - **Um caso raro que a regra também cobre:** em Goose Bay (2000 a 2010), a meia-noite acontece, o relógio volta para o dia anterior às 00:01 e a meia-noite acontece de novo. O dia começa na primeira entrada. Os períodos são faixas contínuas de instantes, então os horários lidos depois disso como do dia anterior ficam dentro da faixa do dia.

- **Contratos:**
  - `inicioDoDiaLocal(data, fuso)` em `local-time.ts`, com a regra aprovada. Ela tenta os candidatos de meia-noite e, em último caso, varre por minuto;
  - os esquemas e DTOs da taxa de faltas (`clinicsNoShowQuerySchema`, estrito: `from < to`, no máximo 366 dias) e dos candidatos (`listClinicsReturnCandidatesSchema` e a página com `nextCursor`). Os comentários explicitam a semântica do período e da taxa.
- **Rotas:**
  - `GET /api/clinics/metrics/no-show` (`schedule:read`);
  - `GET /api/clinics/returns/:id/candidates` (`schedule:read`, mais a ação de vincular, conferida no serviço);
  - `GET /api/clinics/patients/:id` (`schedule:read`, com a projeção da lista).
- **Decisões tomadas no caminho:**
  - **Unidade da taxa:** a informada vale mesmo arquivada, porque o histórico dela continua valendo. Sem ela, vale a única ativa; com nenhuma ou com duas ou mais, a resposta é 400. A unidade de outro workspace dá 404, igual à inexistente.
  - **Profissional e serviço do recorte:** um inexistente, ou de outro workspace, dá zeros ("sem dados"), e não 404. A consulta passa pelo filtro do workspace, então a resposta não diz se o id existe.
  - **A varredura por minuto do `inicioDoDiaLocal`** nunca é alcançada de 2000 a 2100 (as duas verificações). Fica como defesa documentada, com custo limitado a uns 3.200 passos.
  - **Agendamentos vinculados nos candidatos:** saem todos os que estão vinculados a algum retorno, inclusive o do próprio retorno, que já aparece no vínculo dele. Esse critério é visível na agenda.
  - **O cursor dos candidatos** é opaco por contrato (`base64url` do início e do id), mas **não é assinado**. A validação recusa com 400 o cursor malformado: o id precisa ser UUID estrito, e o instante, o ISO que o servidor escreve, com ano de 0001 a 9999. Ela não recusa necessariamente todo cursor fabricado com valores válidos, e não há garantia de autenticidade. Um cursor fabricado assim só reposiciona a página: a autorização continua nos filtros do servidor, que são o workspace e o paciente, o serviço e a unidade do retorno. _(Precisão da decisão do usuário sobre a F3.3a.)_
  - **As duas contagens da taxa** são consultas separadas e podem observar estados diferentes, porque várias mudanças concorrentes podem acontecer entre elas. Isso foi aceito para este indicador operacional. O comentário do serviço ainda fala em "deslocar em um", o que é impreciso, e será corrigido quando o arquivo for alterado de novo, sem reabrir agora o código aprovado.
- **Testes:**
  - **Unitários, o início do dia (6 novos):**
    - São Paulo: o dia comum, a meia-noite no pulo de 2018 e o dia de 25 h de 2019;
    - Santiago: o pulo de 2025;
    - Havana: a meia-noite repetida de 2025;
    - Nova York: os dias de 23 e de 25 h;
    - Goose Bay: a meia-noite que volta, em 2000;
    - Samoa: o dia que não existe, em 2011.
  - **Integração, taxa de faltas (7):**
    - a definição: "sem dados" só sem atendidos nem faltas, o 0 % legítimo, e os cancelados e os passados sem desfecho à parte;
    - os limites nos dias de 23 e de 25 h de São Paulo, na meia-noite repetida de Havana e no dia que não existe em Samoa, com agendamentos encostados no início e no fim de cada faixa;
    - o relógio do Node deslocado para os dois lados, com uma leitura do relógio do banco por operação;
    - o recorte por profissional e por serviço, com outra unidade no mesmo período fora da conta e com o DTO estrito;
    - a validação, inclusive o período de exatamente 366 dias aceito, a unidade arquivada informada (vale) e nenhuma unidade ativa sem unidade informada (400);
    - o RBAC;
    - o P0 de isolamento, inclusive o profissional e o serviço de A pedidos por B (zeros).
  - **Integração, candidatos (3):**
    - a mesma lista para um retorno anterior, um posterior e o de origem, sem o agendamento de outra unidade, e o vínculo reconferindo;
    - a paginação sem truncamento, com um empate no início desempatado pelo id;
    - o `from` pela regra do início do dia local (22:00 locais da véspera ficam fora);
    - as recusas, inclusive cursores forjados com a forma certa (id que não é UUID, instante fora da faixa do banco, ano 0000);
    - as permissões de vincular, o encerrado e o P0.
  - **Integração, paciente por id (1):** a mesma projeção da lista sem `contacts:read`, o guest e o P0 pela URL.
- **Mutação: 25, das quais 24 morrem,** cada uma pelo teste esperado e todas compilando:
  - **taxa (11):**
    - "sem dados" virando 0;
    - 0 virando "sem dados";
    - o limite na meia-noite UTC;
    - o dia de 24 h fixas;
    - o "passado" pelo relógio do Node;
    - os cancelados no denominador;
    - os passados de qualquer estado;
    - o fim inclusivo;
    - sem o filtro de unidade;
    - a unidade arquivada recusada;
    - o período de 366 dias recusado;
  - **candidatos (11):**
    - o já vinculado na lista;
    - sem os atendidos;
    - o truncamento silencioso;
    - sem a conferência da ação;
    - os candidatos de um encerrado;
    - o cursor sem desempate pelo id;
    - o cursor sem o formato ISO do servidor;
    - o cursor com UUID frouxo;
    - o cursor com o ano 0000;
    - candidatos de outra unidade;
    - o `from` na meia-noite UTC;
  - **paciente (1):** o `contactId` sempre;
  - **início do dia (2):**
    - a última ocorrência em vez da primeira, que morre pelo caso de Goose Bay;
    - **sobrevive a que tira a guarda "o primeiro instante".** A varredura dos 418 fusos de 2000 a 2100 mostrou que ela é equivalente em todo caso real, porque a ordenação já escolhe a primeira entrada. Fica como defesa para um formato de transição que a base atual não tem.
- **A primeira rodada de mutações** achou duas lacunas de teste: a unidade da taxa e o desempate do cursor. As duas viraram testes, e as mutações delas passaram a morrer.

**Revisão da F3.3a (`reviewer` e `security`, os dois aprovando com ressalvas, sem P0) e o que mudou com ela:**

- **P1 do `reviewer`:** o complemento da regra do dia estava escrito dentro do bloco da aprovação do usuário, como se fosse dele. Foi para estes Resultados, marcado como proposto e a confirmar. Ganhou Tokelau (`Pacific/Fakaofo`), que o `reviewer` achou, e as faixas corretas das varreduras. O texto vai num commit de documentação antes do commit da F3.3a.
- **P2 do `security`: o cursor dos candidatos validava pouco.** Um id de 36 hífens, ou um instante que o JS lê mas o banco recusa (como `-271821-04-20`), virava 500. Um teste reproduziu esse 500 antes da correção. Agora o cursor exige um UUID estrito e o formato ISO que o servidor escreve, com ano de quatro dígitos. A confirmação dos dois achou ainda o ano `0000`, que o Postgres não tem. Ele também é recusado agora, e um teste e uma mutação provam que, sem essa guarda, a resposta era 500. O cursor malformado dá 400. Como o cursor não é assinado, isso não é garantia de autenticidade: o comentário do `lerCursor` ("um cursor forjado é 400") diz mais do que a validação faz, e será corrigido quando o arquivo for alterado de novo.
- **P2 do `reviewer`: três lacunas de teste.** Eram o critério de unidade dos candidatos, a unidade arquivada da taxa (com o caso de nenhuma ativa registrado) e o `from` pela regra do dia. Viraram testes, e as mutações delas morrem.
- **Nits:**
  - os pares de limite que faltavam;
  - o período de 366 dias aceito;
  - o profissional e o serviço de A pedidos por B;
  - a decisão de zeros, e não 404, para profissional e serviço;
  - a varredura por minuto como defesa documentada;
  - a citação da aprovação no `SECURITY.md`;
  - a lista fixa de quem pode usar o `agoraDoBanco`, numa regra estática: hoje só a taxa e os retornos;
  - as duas noções de limite de dia, a da agenda e a nova, como dívida com gatilho em `technical-debt.md`.

**Decisão do usuário sobre a F3.3a (2026-10-22), com o push autorizado:**

1. **O dia local inexistente:** aprovada a regra "o primeiro instante cuja data local é D ou posterior". A explicação foi ajustada nos Resultados. Ficam os testes do dia pulado isolado e de um período que atravessa esse dia.
2. **Filtros e candidatos, aprovados:**
   - a unidade arquivada vale quando informada;
   - a unidade é exigida quando não há exatamente uma ativa;
   - profissional ou serviço sem correspondência no workspace dá contagens zero e taxa nula;
   - os candidatos excluem os agendamentos já vinculados, inclusive o vínculo atual, que continua mostrado separadamente.

   A seleção segue sem usar a origem nem a prova temporal oculta, e o vínculo mantém a reconferência na transação.

3. **Precisões documentais:**
   - o cursor é opaco, mas não é assinado, e não há garantia de autenticidade;
   - as duas consultas da métrica podem observar estados diferentes, sem o limite de um.

   Entram neste commit de documentação, sem reabrir o código.

4. **A divergência entre a agenda e as métricas** fica como dívida, com o gatilho registrado. **O suporte aos fusos raros em que as duas regras divergem não está validado de ponta a ponta enquanto elas divergirem.**
5. **Próxima etapa:** com o CI verde, a F3.3b segue o plano aprovado. Continuam obrigatórios:
   - a escolha explícita entre avulso e pacote;
   - nenhuma consulta a pacotes sem permissão;
   - o tratamento de falha sem dados antigos;
   - a distinção entre taxa zero e "sem dados".

**Notas de implementação da F3.3b (telas e e2e), decididas antes do código.** Seguem o detalhamento e as condições aprovadas. O que é escolha nova está marcado.

- **Rotas e navegação:**
  - `/clinics/patients/:id` é a ficha, e o nome na lista de pacientes leva até ela;
  - `/clinics/returns` (Retornos) e `/clinics/no-show` (Faltas) entram na navegação, com `schedule:read`;
  - a porta de sempre: nada do vertical é consultado antes do status ativo confirmado e da permissão da tela.
- **Dado de servidor só no TanStack Query.** A troca de sessão já monta um cache novo e descarta a resposta de outra época (ADR-050).
  - **Com erro, nenhum dado antigo:** uma recarga que falha esconde a lista e mostra o alerta, como nas telas da F2.
  - **Sem `care:read`,** a seção de pacotes não existe e nenhuma consulta a `/api/clinics/packages` é feita.
- **Registro de atendimento na agenda (consumo explícito):**
  - o botão abre um painel de escolha com os pacotes ativos do paciente para aquele serviço e com saldo, e a opção "Avulso";
  - **nada vem marcado,** e o botão de confirmar fica desabilitado até a escolha. O texto dele nomeia a escolha, com o saldo antes e depois;
  - enquanto os pacotes carregam, ou se a consulta falha, não se confirma. A falha mostra o alerta e "tentar de novo", e nunca vira "avulso";
  - o "avulso" vai como escolha explícita (`packageId: null`);
  - **a recusa do servidor** (o saldo acabou, o pacote encerrou ou a repetição veio com outra escolha) aparece como veio, as opções são recarregadas e a escolha é desfeita. Nada troca de pacote nem registra "avulso" em silêncio;
  - **sem `care:read`,** a única opção é "Avulso", com o aviso de que os pacotes não estão visíveis para essa pessoa.
- **A ficha do paciente:**
  - **pacotes** (só com `care:read`): serviço, sessões (total, consumidas, restantes), estado e o preço total "registrado", nunca "pago";
  - **criar** (`care:write`): serviço, total de sessões e preço total opcional, digitado em reais e enviado em centavos inteiros. Uma confirmação mostra o que fica congelado;
  - **cancelar** (`care:write`): uma confirmação diz que as consumidas ficam e que não há reabertura;
  - **retornos do paciente:** a lista filtrada, com o mesmo componente da tela de retornos.
  - **Escolha nova, para a revisão:** a **criação manual de retorno fica na ficha**, onde o paciente já está escolhido, e não na tela de retornos, como dizia o detalhamento. Isso evita repetir a busca de paciente. A tela de retornos leva à ficha pelo nome do paciente.
- **Tela de retornos:**
  - **filtros:** estado, vencido, responsável (inclusive "sem responsável") e período de vencimento;
  - **ações conforme a permissão:**
    - vincular, por um painel com os candidatos paginados ("carregar mais" pelo `nextCursor`), a partir de 30 dias antes de hoje (um padrão da tela; o servidor decide) e com o aviso sobre consultas já atendidas;
    - desvincular;
    - cancelar, com os motivos conforme a permissão;
    - atribuir, com o seletor próprio.
  - **Projeção:** a tela mostra o cancelado sem motivo quando a resposta não traz o motivo.
- **Tela de faltas:**
  - período em datas locais (por padrão, os 30 dias até hoje; o "hoje" do padrão vem do relógio do navegador no fuso da unidade, e o servidor decide o resto), unidade e recorte opcional por profissional e serviço;
  - mostra a taxa em porcentagem ou "Sem dados", **nunca 0 % para "sem dados"**;
  - mostra "X faltas em Y (atendidos + faltas)", os passados sem desfecho com o caminho para a agenda e os cancelados à parte.
- **Testes de componente (Vitest):**
  - a escolha obrigatória, sem pré-seleção;
  - a falha ao carregar os pacotes, que não vira "avulso";
  - a recusa que recarrega e desfaz a escolha;
  - nenhuma consulta a pacotes sem `care:read`;
  - a recarga que falha, sem dado antigo;
  - a troca de sessão e a resposta antiga de pacotes (com o servidor falso do teste de isolamento da ADR-050);
  - 0 % e "sem dados" distintos;
  - os motivos de cancelamento conforme a permissão;
  - a paginação dos candidatos.
- **E2E (Playwright, dados fictícios):** os cenários do detalhamento, mais o "sem dados" e o 0 % legítimo, a escolha explícita entre avulso e pacote, e a recepção sem acesso aos dados de atendimento e de pacote.

**Resultados da F3.3b (telas e e2e), para revisão.**

- **Rotas e navegação:**
  - "Retornos" e "Faltas" entraram na lateral do grupo "Clínica";
  - a ficha é `/clinics/patient?id=…`, e não `/clinics/patients/:id`, como dizia a nota. **Desvio:** a regra de composição do web (Core) só aceita rotas de vertical estáticas, e foi mantida. Um id que não é UUID nem chega ao servidor;
  - o nome na lista de pacientes e na lista de retornos leva à ficha.
- **A porta das telas novas** é a da agenda: o status ativo e as chaves da agenda **e** do catálogo. O catálogo dá os nomes de serviço e profissional e o fuso da unidade, e os dois papéis que leem a agenda já o têm.
- **Registro de atendimento:**
  - o botão do cartão da agenda abre o painel de escolha (`agenda/RegistroDeAtendimento.tsx`), e o registro direto, que gravava "avulso" com um clique, deixou de existir;
  - o painel segue todas as condições: nada marcado, a falha não vira "avulso", a recusa recarrega e desfaz a escolha, e sem `care:read` nenhuma consulta a pacotes;
  - o e2e da agenda da F2 passou a escolher "avulso" explicitamente.
- **Ficha, retornos e faltas** seguem as notas.
  - **A lista de retornos é uma só** (`retornos/ListaDeRetornos.tsx`), na tela e na ficha.
  - **O catálogo inclui os arquivados nas telas novas:** um pacote ou uma métrica pode citar um serviço arquivado. Para criar, só os ativos.
- **Testes de componente:** 19 novos (`continuidade.test.tsx`) e 2 de sessão (`session-isolation.test.tsx`):
  - a escolha sem pré-seleção, inclusive com um pacote só;
  - a falha que não vira avulso;
  - a recusa que recarrega e desfaz;
  - nenhuma consulta a pacotes sem `care:read`, no painel e na ficha;
  - a recarga que falha, sem dado antigo, na ficha, nos retornos e nas faltas;
  - a confirmação do pacote (o que fica congelado, e que o preço não é pagamento) e o envio em centavos inteiros;
  - o id inválido;
  - os motivos de cancelamento conforme a permissão e a origem;
  - a paginação dos candidatos;
  - "Sem dados" e 0 % distintos;
  - **sessão:** depois da troca de A, que lê pacotes, para B, que não lê, a ficha de B não tem a seção e nenhuma consulta a pacotes sai com B. A resposta antiga de pacotes de A, que chega depois do login de C, não aparece na ficha de C.
- **E2E (`clinics-continuidade.spec.ts`, 6 cenários, dados fictícios):**
  - o profissional cria o pacote e registra escolhendo-o, e o saldo cai de 10 para 9. A repetição do mesmo pedido não consome de novo, e a repetição com outra escolha dá 409;
  - a recepção fica sem pacotes e sem consulta, a API responde 403, e o cancelado clínico aparece genérico. A recepção cancela um retorno com motivo operacional, e só vê os motivos operacionais;
  - o link direto de um convidado (sem as chaves do Clinics) para as telas novas mostra a recusa, sem consulta ao vertical;
  - o retorno automático é vinculado pela recepção, atribuído e concluído pelo registro;
  - "Sem dados", 0 % legítimo e 50 %;
  - as telas novas num workspace sem o Clinics.

**Revisão da F3.3b (`reviewer`: mudanças necessárias; `security`: aprovado com ressalvas; sem P0) e o que mudou com ela:**

- **P1 do `reviewer` e P2 do `security`: o teste da resposta antiga de pacotes passaria sem a defesa.** As chaves de cache de A e de C não colidiam. Agora A e C têm o mesmo id de paciente.
  - **A prova:** uma mutação que tira as três proteções da ADR-050 juntas, mantendo o login funcional, derruba o teste de C.
    - **O que a mutação faz:** usa um cache único, só com a sessão atualizada na troca, sem remontagem, sem limpeza, sem época e sem escopo.
    - **Onde cai:** na asserção dos pacotes de C. A ficha de C fica presa à consulta de A, ainda a caminho na mesma chave, e nunca recebe os próprios pacotes.
    - **Correção na confirmação:** a primeira tentativa de mutação quebrava o próprio login, e os testes caíam antes das asserções. A frase anterior ("derruba os dois testes") não provava nada.
  - **O primeiro teste** continua verde sob essa mutação: ele prova o portão da permissão (nenhuma consulta a pacotes sai com B), e não o isolamento.
- **P1 do `reviewer`: o teste da recusa não provava que a escolha é desfeita.**
  - **Recusa com o pacote ainda elegível:** depois do 409, com o saldo de 5 caindo para 4, a opção volta desmarcada e com o saldo novo.
  - **Recarga em andamento:** enquanto ela não chega, não há opção nem confirmação.
  - **A agenda relida:** ela é relida pela própria recusa.
- **P1 do `reviewer`: o e2e não cobria três cenários do detalhamento.** Entraram os três:
  - a repetição que não consome;
  - a recepção cancelando com motivo operacional;
  - o link direto sem permissão.
- **P2, dos dois:**
  - **A recusa não relia a agenda.** Era uma regressão do `onSettled` antigo, e foi corrigida.
  - **Dois pacotes iguais tinham o mesmo rótulo.** A opção e o botão agora trazem a data e a hora de criação no fuso da unidade.
- **P2 do `reviewer`:**
  - **A lista de retornos cortava em 100 sem aviso.** Agora pede `limit` explícito e avisa quando chega ao teto.
  - **O erro do cancelamento de pacote aparecia atrás do painel.** Foi para dentro dele.
  - **Uma taxa positiva pequena aparecia como "0 %".** Agora aparece "< 0,1 %", e a quase total, "> 99,9 %".
- **Nits:**
  - os testes de componente usam o `QueryClient` de produção e recarregam por invalidação;
  - um horário sem o fuso da unidade é dito ("UTC" ou "horário indisponível");
  - os botões das linhas trazem o contexto no nome acessível;
  - os caminhos vêm das constantes;
  - as mensagens de serviços e pacotes estão separadas;
  - o preço inválido é avisado, com o teto do contrato;
  - o registro invalida também os retornos;
  - o "0 %" e o período do e2e são exatos.
- **Mantido e registrado (nit do `reviewer`):** os itens "Retornos" e "Faltas" da navegação pedem só `schedule:read`, e a página pede também `catalog:read`, como a "Agenda da clínica" já faz. O item de navegação é uma chave só, um tipo do Core. Os dois papéis do Clinics que leem a agenda têm as duas.
- **Mutações do web: 12, todas mortas,** cada uma pelo teste esperado, com a saída gravada na rodada final:
  - a recusa sem desfazer a escolha;
  - a confirmação durante a recarga;
  - a recusa sem reler a agenda;
  - a pré-seleção do pacote único;
  - a consulta a pacotes sem `care:read`, no painel e na ficha;
  - a falha permitindo registrar "avulso". A versão anterior dessa mutação era equivalente, porque o painel já esconde as opções na falha, e foi trocada por uma que de fato oferece e confirma "avulso";
  - a taxa sem a ponta de baixo e sem a ponta de cima;
  - o aviso do teto com exatamente 100 retornos;
  - o dado antigo depois de uma recarga que falha, na lista de retornos e nos pacotes.
- **Confirmação dos dois (`reviewer`: mudanças necessárias; `security`: aprovado com ressalvas; sem P0):**
  - **P1 do `reviewer` e P2 do `security`:** a prova da mutação de sessão, corrigida acima.
  - **P2 do `reviewer`:**
    - a taxa no limite exato de cima (1999 faltas em 2000) aparecia como "100 %", e agora aparece "> 99,9 %";
    - na ficha, dois pacotes iguais não se distinguiam. A linha, o botão de cancelar e a confirmação agora trazem a data e a hora de criação.
  - **Nits:**
    - a recusa de um pacote não reaparece no painel de outro;
    - o horário sem fuso diz "UTC" também no painel de registro, com um auxiliar só;
    - a lista pede 101 e mostra 100, e só avisa quando há mais;
    - a validação do pacote é a do esquema do contrato, sem repetir os limites;
    - a saída das mutações fica em arquivo.
- **Terceira passada do `reviewer` (aprovado com ressalvas, sem bloqueante):** os oito itens estão resolvidos.
  - **A mutação de sessão foi rodada de novo contra o teste final**, depois da bateria, e cai na mesma asserção, com o rótulo novo. O patch da mutação fica guardado para quem quiser repeti-la.
  - **Na ficha, com unidades em fusos diferentes, a data de criação vai em UTC** (e diz), para não divergir do painel de registro da agenda. Com um fuso só, vale o dele.
  - **A dica do total de sessões** não repete mais o limite do contrato.

- **Pendente de decisão do usuário (P2 do `security`), sem implementar nesta entrega de telas:**
  1. **A API ainda aceita o corpo vazio como "avulso".** Isso foi aprovado na F3.1, quando a tela registrava sem corpo, e deixou de ser necessário: a tela agora sempre manda `packageId` (`null` para avulso). Hoje, a escolha explícita depende só da tela. Uma aba aberta com a versão anterior, ou outro chamador, ainda registraria "avulso" com um clique. **Recomendação:** antes da ativação, exigir `packageId` no contrato (`null` explícito para avulso) e recusar o corpo vazio. Isso muda a decisão da F3.1, então só com a sua aprovação.
  2. **O saldo pode mudar sem invalidar a escolha.** Se o saldo cai de 7 para 5 entre a leitura e a confirmação, o pacote continua elegível e o servidor aceita, embora a tela tenha mostrado "7 → 6". O pacote não é trocado e nada vira "avulso", que é o essencial da condição, mas o "antes e depois" mostrado pode estar desatualizado. **Recomendação:** registrar como limitação aceita do protótipo. Se quiser garantir o saldo exibido, a alternativa é enviar o saldo esperado no registro e recusar quando divergir, o que também muda a API.

**Implementação da F3.1 (notas, 2026-10-21).**

- **O `dealId` do pacote fica fora da F3.1.** Uma FK composta para o `Deal` do Core travaria a exclusão de deals. A alternativa seria `SET NULL` só na coluna (`ON DELETE SET NULL ("dealId")`), que o Prisma não modela sem drift. Como o vínculo só serve ao fluxo comercial, ele volta com a F4, por ADR.
- **Os triggers do banco:**
  - **`ClinicsPackage_guard`** recusa:
    - nascer com consumo ou fora de `active`;
    - mudar paciente, serviço, total, preço, moeda, autoria ou criação;
    - consumir por outra coisa que não `+1`;
    - mudar o estado num consumo;
    - concluir sem consumo;
    - qualquer mudança num pacote encerrado.

    Na **última sessão**, ele mesmo passa o pacote a `completed` e escreve o `closedAt` pelo relógio do banco, **na mesma instrução** do consumo. No **cancelamento**, sem incremento, escreve o `closedAt`.

  - **`ClinicsAttendance_package_is_final`** recusa trocar, tirar ou pôr o pacote de um atendimento depois do registro.
  - **Um `CHECK` de estado** amarra: `active` com saldo, `completed` exatamente no total e encerramento só nos estados finais.
- **O consumo** é um `updateMany` condicional (`+1` com o pacote ativo, do mesmo paciente e do mesmo serviço), na transação do registro de atendimento. O estado ativo já implica saldo, porque a última sessão o conclui. Com zero linhas, o motivo é lido e a transação inteira volta, sem atendimento.
- **A repetição** é conferida antes da transição e também nos dois caminhos de corrida (a transição perdida e o unique por agendamento). Em todos, a mesma escolha devolve o registro, e uma escolha diferente é 409.
- **O cancelamento** repetido sobre um pacote cancelado devolve o estado atual. Sobre um pacote concluído, é 409.
- **A checagem de presença da porta E6** passa a doze consultas (a de ativação e as dos onze modelos, em paralelo). A medição local deu p50 de 0,83–0,88 ms e p95 de 0,93–1,05 ms, no patamar dos dez modelos. A dívida segue registrada.
- **A exclusão do workspace** leva pacotes e atendimentos vinculados em cascata, passando pelas FKs `NO ACTION`, com teste.
- **O runbook** ganhou a consulta de conferência da igualdade (§7.1).
- **Correções da revisão (`reviewer` e `security`, sem P0, P1 nem P2):**
  - **`care:write` pressupõe `care:read`.** As recusas do consumo dizem o estado do pacote, e a resposta da criação e do cancelamento é o próprio pacote. Por isso, consumir pacote no registro de atendimento, criar e cancelar exigem também `clinics:care:read`. Um teste estático fixa que, na matriz, todo papel com `care:write` tem `care:read`, e um papel customizado só com `care:write` registra apenas o avulso. A mensagem do 409 da repetição ficou neutra ("outra escolha"), sem citar pacote;
  - **a conclusão do pacote entra na trilha** (`clinics.package.completed`), na mesma transação do consumo da última sessão;
  - **regra estática:** só o serviço de pacotes e o registro de atendimento escrevem `ClinicsPackage`, e só o registro de atendimento escreve `ClinicsAttendance`. Um `INSERT` ou `DELETE` futuro de atendimento vinculado, fora desse caminho, quebra o teste, já que o banco só protege o `UPDATE`;
  - o teste da FK composta usa um agendamento real de A com o pacote de B, e isola a FK do pacote;
  - a migration termina com `RESET lock_timeout`, como as demais. _(Superado nos ajustes da liberação: a migration passou a ser transacional explícita, com `SET LOCAL` e `COMMIT`.)_
- **As baterias b48 e b49 falharam. O que foi comprovado e o que segue hipótese:**
  - **Comprovado, produto (regressão da F3.1):** a tela registra o atendimento **sem corpo** (`AgendaPage`), e o `ZodPipe` recusava o `undefined` com 400 "Dados inválidos". O e2e "`Profissional` registra o atendimento" falhou por isso nas duas baterias, com a mesma mensagem na tela. **Na b48, essa falha foi atribuída ao ambiente sem conferir a mensagem: erro de diagnóstico.** A lacuna escapou da integração porque o helper da suíte sempre mandava `{}`.
    - **A correção:** a rota aceita a ausência de corpo como avulso, e um corpo JSON passa pelo contrato estrito. Um corpo que o servidor não interpreta, como texto, formulário ou `chunked` sem JSON, é recusado com **415**. Antes ele chegaria como `undefined` e viraria avulso em silêncio, quando talvez escolhesse um pacote; o vínculo não se corrige depois. "Traz corpo" quer dizer `Content-Length > 0`, ou `Transfer-Encoding` acompanhado de `Content-Type`.
      - **O `Transfer-Encoding` sozinho não conta,** porque um proxy pode reenviar em `chunked` o POST vazio da tela, que não tem `Content-Type`. É um risco apontado pela conferência do `security`, não observado; o e2e local não passa pela cadeia de proxies do staging.
      - **O `type-is.hasBody` não serve,** porque responde sim para o `Content-Length: 0` que o navegador manda.
      - **Resíduo aceito:** um corpo `chunked` sem `Content-Type` vira avulso. Quase nenhum cliente manda isso. _(Recusado pelo usuário e superado pelos "Ajustes pedidos antes da liberação", abaixo: a ausência de corpo passou a ser decidida pelos bytes, não pelos cabeçalhos.)_
    - **Os testes novos:**
      - sem corpo nenhum, como a tela, e com um pacote elegível presente, o atendimento é avulso e nada é consumido;
      - um campo a mais continua 400;
      - texto e formulário dão 415, sem consumo, sem atendimento e com o agendamento intacto;
      - em `chunked`, por um POST cru: vazio e sem tipo é avulso, e `text/plain` dá 415.
    - **Os helpers** das suítes de pacotes e da agenda só mandam corpo quando o teste passa um, como o `api.post(path)` da tela. Com isso, a próxima rota que recuse a ausência de corpo aparece na integração.
  - **Ajustes da revisão do delta (`reviewer` e `security`, sem P0 nem P1):**
    - **O 415 acima** era o P2 dos dois.
    - **A exigência de `care:read` para consumir pacote** saiu da rota e passou ao serviço do registro, para valer a qualquer chamador futuro, como uma tool ou um job (princípio 10 do `CLAUDE.md`). O 403 continua antes de qualquer consulta.
    - **O id do pacote vai em minúsculas,** como o banco o devolve. Sem isso, repetir o mesmo pedido com o UUID em maiúsculas dava 409.
    - **O teste de isolamento agora tenta o consumo:** B registra um agendamento real de B com o pacote de A e recebe 404, sem consumo, sem atendimento e com o agendamento de B intacto.
    - **Resíduo aceito:** um papel com `care:write` e `schedule:read`, sem `care:read`, que repetisse sem corpo um registro feito com pacote receberia 409 em vez de 201, e assim saberia que a sessão saiu de um pacote. Esse papel não existe pelo produto: a matriz e o teste estático garantem que quem escreve atendimento também o lê, e não há API para compor papéis. Quando houver editor de papéis, a composição deve impor `care:write ⇒ care:read`.
  - **Comprovado, mecanismo do harness:** neste macOS, um servidor Node em `::` aceita uma porta que outro processo já ocupa em `127.0.0.1`, e a conexão a `127.0.0.1`, onde o supertest conecta, vai para o outro processo. A reprodução usou dois servidores Node e porta explícita.
    - Que a porta efêmera do `listen(0)` caia numa porta assim é plausível pela mesma regra, mas não foi reproduzido.
    - **Inferência, não observação direta:** é a causa provável das 25 falhas da b49-r1. Todos os testes da suíte de pacotes caíram no primeiro pedido, o login do owner, com 404, embora a rota exista e a mesma suíte tenha passado na r2 e isolada. Não foram capturados a porta, o corpo da resposta nem o processo dono.
    - **A correção:** o harness escuta em `127.0.0.1` (`test/integration/app.ts`), e assim a porta que o sistema escolhe está livre nesse endereço. Nenhum outro servidor de teste usa porta efêmera. O e2e sobe a API e o Vite em portas fixas, e com `reuseExistingServer: false` o Playwright falha de forma visível se a porta já responde.
  - **Comprovado, lentidão na b48:**
    - o e2e levou 9,8 min, contra 1,1 min na b49;
    - quatro telas sem relação entre si estouraram o tempo: contatos, sugestão de resposta, sinais e uso;
    - um teste da G3.3 também estourou, e uma reprodução isolada dessa suíte falhou por tempo em 2 testes;
    - com o mesmo código, o teste da G3.3 passou na r2 da b48, em 8 rodadas isoladas e nas duas rodadas da b49, e as quatro telas passaram no e2e da b49, que rodou uma vez;
    - o desvio de relógio estava normal (≤ 1,5 ms).
  - **Comprovado, banco:** o número de arquivos que cada checkpoint sincroniza acompanha as janelas de integração, com picos nelas e valores baixos fora. Ele vai de 18.230 a 613.733 e não cresce de forma contínua. O pico da b49 (613.733) superou o da b48 (541.695). Isso é coerente com os `TRUNCATE` do `resetDb`, que criam arquivos novos a cada teste, mas a causa não foi medida.
  - **Hipótese enfraquecida:** que esses checkpoints causaram a lentidão. O registro anterior afirmava isso como causa, sem prova. Contra ela:
    - o `total=150 s` é quase todo fase de escrita espaçada (`checkpoint_completion_target=0,9` de 300 s), comportamento normal; a sincronização em si durou 14,8 s;
    - durante o e2e da b48 não havia checkpoint em curso;
    - a b49 teve uma sincronização maior (17,8 s, 613.733 arquivos) sem falha atribuível a ela;
    - a b50 passou inteira com uma sincronização de 18,2 s e 590.250 arquivos no meio da integração, e o relógio de parede, num processo separado, não registrou lacuna.
  - **Indícios de outra hipótese,** a de a VM do Docker ou a máquina travarem por períodos:
    - com o banco ativo, o checkpoint por tempo esperado por volta de 17:15 UTC só começou às 17:34;
    - esse mesmo checkpoint levou 558 s para escrever 2.777 buffers (cerca de 22 MB);
    - a reprodução isolada que falhou caiu dentro dele.
  - **A causa da lentidão da b48 não foi identificada.** O número "~100 s parados" do registro anterior não tem origem verificável nos logs guardados e foi retirado.

  A lentidão e o `resetDb` são infraestrutura de teste, não produto, e estão registrados em `docs/MEMORY/technical-debt.md`; a mitigação é decidida em separado.

**Testes da F3.1** (dados fictícios; as corridas com a ordem forçada: a primeira transação pausa segurando a linha do pacote, e a segunda é vista esperando a trava em `pg_stat_activity`):

- **Integração, `clinics-packages` (31):**
  - **criação:**
    - o pacote nasce ativo com zero consumidas, e o preço ausente é `null`, não zero;
    - o zero só existe quando digitado, e a trilha registra só `hasPrice`;
    - as regras da criação: total de 1 a 100, sem campo a mais, serviço arquivado recusado;
  - **consumo:**
    - uma sessão por atendimento, com vínculo e trilha, e o avulso sem consumo;
  - **o transporte do corpo, por HTTP real** (`node:http`, com os cabeçalhos exatos), depois dos ajustes da liberação:
    - vazio de verdade, por `Content-Length: 0` (a tela) ou por `chunked` sem nenhum byte (um proxy): avulso, sem consumo, com um pacote elegível presente;
    - `chunked` com bytes e sem `Content-Type`, inclusive a escolha de um pacote ou um byte só: 415 com `Connection: close`, sem atendimento, transição, consumo nem trilha de sucesso;
    - a conexão que cai depois dos cabeçalhos `chunked`, sem byte nenhum: nada é registrado, e o mesmo agendamento segue aceitando o pedido vazio;
    - JSON válido com o pacote, com `Content-Length` ou `chunked`: consumo explícito;
    - JSON inválido ou fora do contrato (400) e tipo que ninguém interpreta (texto, formulário, XML ou bytes sem tipo: 415), sem efeito nenhum; depois, o pedido válido passa;
    - a última sessão conclui na mesma instrução;
    - o pacote de outro paciente ou serviço é recusado (400), o inexistente dá 404 e o cancelado dá 409, todos sem atendimento;
    - **rollback** depois do incremento, sem sobrar nada;
  - **repetição:**
    - a idêntica funciona com o pacote concluído e com o cancelado;
    - o id em maiúsculas é o mesmo pedido;
    - a escolha diferente é 409 nos três sentidos;
    - os registros simultâneos resultam em um consumo;
  - **corridas:**
    - o último saldo disputado: um 201 e um 409;
    - o consumo primeiro na última sessão: o cancelamento dá 409 e o pacote fica `completed`;
    - o consumo primeiro com saldo: o cancelamento comita depois;
    - o cancelamento primeiro: o consumo dá 409, sem atendimento e com o agendamento intacto;
    - o cancelamento repetido;
  - **banco:**
    - cada mudança proibida é recusada mesmo junto de um caminho legítimo (o `+1` ou o cancelamento);
    - os dois caminhos legítimos passam;
    - o vínculo do atendimento é imutável;
    - a cascata do workspace funciona;
  - **permissões e isolamento:**
    - a recepção não vê nem cria pacote, e a agenda não traz vínculo;
    - um papel que escreve atendimento sem lê-lo não consome, não cria nem cancela pacote, e registra só o avulso;
    - o `Profissional` opera o pacote;
    - o workspace B não vê, não cancela nem consome pacote de A, este último por um agendamento real de B;
    - a FK composta recusa o vínculo cruzado.

  A igualdade "consumidas = atendimentos vinculados" é conferida ao fim de cada cenário.

- **Suíte de restrição:** a presença pelo pacote restringe os dois consumidores.
- **Mutação:** cada uma das 11 abaixo derruba pelo menos um teste. As 8 de código compilam, e as 3 de banco trocam a função do trigger na base de teste e a restauram a partir da migration:
  - a escolha diferente aceita;
  - o consumo de outro paciente ou serviço;
  - o consumo sem exigir o pacote ativo;
  - o cancelamento de um concluído;
  - o atendimento sem o vínculo;
  - a recepção lendo pacote;
  - o consumo sem exigir a leitura do atendimento;
  - a conclusão sem trilha;
  - a última sessão sem concluir;
  - o total mutável;
  - o vínculo do atendimento mutável.

  **Mais 6 do delta,** todas mortas e cada uma pelo teste esperado (as três do critério por cabeçalhos ficaram sem objeto: esse código saiu nos ajustes da liberação):
  - sem o 415;
  - o "traz corpo" pelo critério do `hasBody`, que derruba o registro sem corpo da tela;
  - o `Transfer-Encoding` sozinho como corpo, que derruba o `chunked` vazio;
  - o `Transfer-Encoding` ignorado, que deixa passar o `chunked` em `text/plain`;
  - o serviço sem exigir `care:read`;
  - o id sem minúsculas.

  **Mais 4 dos ajustes da liberação,** todas mortas:
  - **a leitura aceitando bytes como vazio,** o fallback silencioso: derruba o `chunked` com bytes e o tipo não suportado;
  - **o fallback silencioso inteiro,** sem a camada e com o controller aceitando `undefined`: derruba os mesmos dois;
  - **sem a camada,** com o controller exigindo a prova: falha fechada; o pedido vazio da tela é recusado e derruba o teste do vazio;
  - **o limite em 1 byte:** derruba o `chunked` de um byte só.

  **Mais 4 da revisão do delta:**
  - **mortas:**
    - a queda da conexão aceita como vazio no `error`, que é o evento que chega primeiro: derruba o teste da conexão que cai;
    - sem o `Connection: close`: derruba o `chunked` com bytes;
  - **equivalentes em efeito, mantidas como defesa:**
    - a queda aceita no `close`: o Node emite `error` antes, e o `close` não decide;
    - sem checar a requisição já destruída: nenhum evento viria e nada seria registrado; a checagem evita a promessa pendurada. Isso não se provoca por HTTP de forma determinística.

  A primeira versão do teste de imutabilidade não derrubava "total mutável": a mudança isolada já era recusada pela regra "sem consumo, só cancelamento". O teste passou a juntar cada mudança proibida a um caminho legítimo.

**Ajustes pedidos antes da liberação do `395eca6` (decisão do usuário, 2026-10-21).** O push foi negado até dois ajustes delimitados; o desenho da F3.1 não muda.

1. **Corpo não interpretado nunca vira avulso.** O usuário recusou o resíduo "corpo `chunked` sem `Content-Type` vira avulso". A frequência desse cliente não muda o contrato: um pedido que contém a escolha de um pacote poderia terminar como atendimento avulso, sem correção possível nesta etapa. E a ausência de `Content-Type` não prova que vieram zero bytes.
   - **Decisão:** a ausência de corpo passa a ser decidida pelos **bytes**, na camada de leitura.
     - Um middleware (`common/corpo-opcional.middleware.ts`), aplicado só à rota do registro de atendimento, roda depois do parser JSON global.
     - Quando o parser não leu nada, o middleware lê o que sobrou do corpo com **limite de zero bytes**. Chegar ao fim sem nenhum byte é o pedido vazio, inclusive em `chunked`. O primeiro byte é conteúdo que ninguém interpretou: a resposta é 415, sem guardar o conteúdo e antes de qualquer efeito.
     - O middleware marca a requisição quando prova o vazio, e o controller só trata a ausência como avulso com essa marca. Se a rota mudar e o middleware deixar de valer, o pedido vazio é recusado (falha fechada), em vez de aceito às cegas.
   - **O parser global não muda:** o `json()` com o `verify` do corpo bruto continua igual, e a assinatura dos webhooks da Meta não passa por essa camada.
   - **Alternativas descartadas:**
     - **inferir pelos cabeçalhos** (`Content-Length`, `Transfer-Encoding`, `Content-Type`), como na versão anterior: os cabeçalhos não provam quantos bytes vieram;
     - **recusar todo corpo não interpretado em todas as rotas:** alcançaria uploads e webhooks, fora do escopo delimitado. Fica como possibilidade futura, com ADR próprio;
     - **um interceptor no handler:** também leria os bytes, mas a leitura do corpo é papel da camada de parsing, que roda antes dos guards, como o próprio `json()`.
   - **Consequência:** um corpo que não é JSON e traz bytes recebe 415 antes da autenticação, do mesmo jeito que um JSON malformado já recebe 400 do parser. Em nenhum dos dois casos algo é gravado.
   - **Detalhes da revisão do delta (`reviewer` e `security`, sem P0 nem P1):**
     - **Na recusa, o resto do corpo não é lido** (nada é guardado), e a resposta leva `Connection: close`. A conexão não serve para outro pedido; sem isso, ela ficava parada até o `keepAliveTimeout`, como os dois revisores mediram.
     - **Quando o cliente cai antes do fim,** o vazio não foi provado. O Node emite `error` (`ECONNRESET`) antes do `close`, e os dois respondem com a mesma recusa, em vez de um 500 no log.
     - **Uma requisição que já chega destruída,** ou cujo corpo já foi consumido, é recusada na hora: nenhum evento viria, e a promessa ficaria pendurada.
     - **Um `resume()`** garante a leitura mesmo depois de um `pause()` anterior.

2. **A recuperação da migration foi ensaiada, e o ensaio desmentiu o runbook.**
   - **Como:**
     - num banco descartável, com todas as migrations anteriores aplicadas, rodou-se o mesmo `prisma migrate deploy`, com uma config apontando para uma cópia das migrations;
     - a falha foi realista: outra sessão segurava `ROW EXCLUSIVE` em `Membership`, e o `ADD FOREIGN KEY` para `Membership` estourou o `lock_timeout` no meio da migration;
     - o estado foi conferido pelo `pg_dump --schema-only` inteiro, antes e depois, e por um inventário dos 23 objetos da migration (DEPLOY_STAGING §4).
   - **Comprovado:**
     - o Prisma 7.9.1 executa a migration **instrução por instrução, sem transação**, como mostra o `log_statement = all`;
     - a migration do `395eca6` falhou deixando **14 dos 23 objetos**: o enum, a tabela, a coluna do atendimento, 6 índices e 5 restrições. O registro ficou como falho;
     - o procedimento do runbook, `resolve --rolled-back` e repetir, **não recupera**: a repetição falha com `type "ClinicsPackageStatus" already exists` e deixa um segundo registro de falha.
   - **Decisão:** a migration passa a ser **transacional explícita**: `BEGIN`, `SET LOCAL lock_timeout = '5s'`, as instruções e `COMMIT`. Todas as instruções são compatíveis com transação; não há `CREATE INDEX CONCURRENTLY` nem `ALTER TYPE ... ADD VALUE`.
   - **Comprovado com a transação:**
     - a mesma falha no meio e uma falha forçada depois de todas as instruções deixam o schema **idêntico** ao de antes, pelo `pg_dump` inteiro, e o inventário em zero;
     - a recuperação (inventário zerado, `resolve --rolled-back`, `migrate deploy`) termina num schema idêntico ao da aplicação direta, e o `migrate diff` contra o schema do Prisma não acusa diferença.
   - **Efeito colateral, documentado no runbook:** com a transação abortada, o Prisma não consegue gravar o log da falha e mostra só "current transaction is aborted"; a coluna `logs` fica vazia. A causa real fica no log do Postgres. O registro da migration continua como falho, e o próximo deploy para com P3009, como deve.
   - **Os locks se acumulam até o `COMMIT`:** o `lock_timeout` vale por lock, e o pior caso soma as esperas, até cerca de 20 s com `ClinicsAttendance` bloqueada desde o `ADD COLUMN`. Sem acesso externo e com os jobs desligados, como manda o runbook, ninguém espera. Reordenar as instruções encurtaria esse tempo, mas exigiria refazer o ensaio; não foi feito.
   - **O ramo "inventário completo com registro falho" também foi ensaiado,** apontado pelo P2 do `reviewer`. É o caso em que o `COMMIT` passou e o processo morreu antes de o Prisma gravar o fim; foi simulado zerando o `finished_at` de uma aplicação bem-sucedida.
     - Com o inventário em 23 e o `migrate diff` vazio, o `resolve --applied` deixa o status em dia, e o deploy seguinte não tem nada a aplicar.
     - Pelo caminho às cegas (`--rolled-back` e repetir), a repetição falha, também ensaiada: `type "ClinicsPackageStatus" already exists` no log do Postgres, mais um registro de falha e nada duplicado.
   - **O inventário filtra `contype <> 'n'`:** no Postgres 18, cada NOT NULL também vira restrição, e a contagem de 23 deixaria de valer. O local e o staging usam o 17.
   - **Precisões pedidas pelo usuário na liberação do `f0783e2` (só no runbook; a migration publicada não muda):**
     - **Os "~20 s" são estimativa das esperas por lock, não limite da migration.** O `lock_timeout` só limita a espera para obter cada lock, e não o tempo de execução das instruções. A conta completa do pior caso dá cerca de 25 s de espera:
       - até 5 s na fila pelo lock exclusivo de `ClinicsAttendance`, porque um pedido na fila já bloqueia os seguintes;
       - até 5 s em cada uma das quatro FKs para tabelas existentes;
       - mais o tempo de execução, que nada limita.

       O comentário da migration publicada fica como está: "~20 s".

     - **Inventário completo e `migrate diff` vazio não bastam para marcar `--applied`.** O inventário confere só nomes, e o Prisma não modela funções, gatilhos nem CHECKs. No ensaio, uma base com o corpo de uma função, um CHECK e os eventos de um gatilho adulterados passou nos dois.
       - **O runbook passou a exigir a comparação do schema `public` inteiro** (`pg_dump --schema=public --schema-only`, sem dono nem privilégios) com uma base de referência montada no mesmo Postgres pelas migrations **até a que falhou**. A comparação acusou as três adulterações e deu igual na base íntegra.
       - **A comparação é um bloco único com falha fechada** (subshell com `set -euo pipefail`), depois da revisão do `reviewer` e do `security`. Ele só imprime "SCHEMA IGUAL" com os dois containers existentes, os dois dumps contendo a sentinela da migration e o `diff` vazio. Também recria a referência do zero e sempre a apaga.
       - **Ensaio do bloco, como está escrito no runbook**, com um Postgres 17 isolado e a imagem da API fazendo o papel dos containers:
         - placeholders sem trocar: interrompe;
         - base íntegra: "IGUAL", depois `--applied` e status em dia;
         - migration que falhou não sendo a última: interrompe;
         - CHECK adulterado: interrompe;
         - em nenhum caso a referência sobrou.
       - **Achado ao rodar os comandos exatos:** o dump sem `--schema=public` traz o schema `pgboss`, que a aplicação cria em tempo de execução, fora das migrations. Ele acusaria diferença em toda base em uso. Por isso a comparação se restringe ao `public`. Um objeto criado no `public` fora das migrations continua aparecendo, como uma tabela solta de experimento na base local de desenvolvimento.
   - **O runbook** (§4) deixa de afirmar que nada foi aplicado. Nunca se marca `rolled-back` sem provar o estado.
     - Na migration transacional, o inventário tem de dar zero.
     - Numa migration sem transação, o que inclui **todas as anteriores**, a falha pode deixar estado parcial. A recuperação então exige um plano revisado, feito em manutenção.
   - **Recomendação, ainda não adotada como regra:** que as migrations novas sejam transacionais explícitas sempre que as instruções permitirem, com a skill `create-migration` atualizada. Fica para decisão do usuário. _(Adotada como regra no ADR-051, decisão do usuário de 2026-10-21.)_
   - **Bases locais:** o arquivo mudou depois de aplicado em `veyra`, `veyra_test` e `veyra_e2e`, e o checksum foi atualizado nelas, como na correção anterior. A versão anterior e a transacional dão o mesmo schema (`pg_dump` inteiro). Nenhum outro ambiente tem esta migration, e a bateria a aplica do zero numa base nova.
   - **O histórico:** o commit local da F3.1 foi refeito com estes ajustes, para que nenhum commit publicado carregue duas versões da mesma migration.

- **Equivalente, sem mutação própria:** a repetição conferida antes da transição. Sem ela, a mesma repetição cai no caminho da transição perdida, que também devolve o registro sem consumir. A D1 (pago ou em aberto) continua em aberto. Se a validação desmentir uma hipótese, a parte correspondente muda ou sai antes do código.

**Delta da revisão 1** (o que mudou desde o `f00e873`):

| #   | Ponto               | Situação                          | O que mudou                                                                                                                                                                                                                                                              |
| --- | ------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Contador de sessões | aprovado, com precisão            | O `CHECK` garante só o intervalo. A igualdade "consumidas = atendimentos vinculados" depende da transação única e dos caminhos de escrita. Entraram a atomicidade exigida, os testes de rollback e de cancelamento concorrente e a imutabilidade do total e dos vínculos |
| 2   | Consumo explícito   | aprovado                          | A tela mostra qual pacote será consumido antes da confirmação. Repetir **com pacote diferente**, inclusive de avulso para pacote e de pacote para avulso, responde 409                                                                                                   |
| 3   | Preço do pacote     | revisto                           | Preço **total** explícito, digitado e confirmado na criação, e congelado. Não é mais cópia do preço do serviço                                                                                                                                                           |
| 4   | Retorno             | revisto                           | **Fica no Clinics**, com permissões do domínio, **sem `Task` do Core e sem ponte para o CRM**. Criação, conclusão, cancelamento e responsável são explícitos                                                                                                             |
| 5   | Taxa de faltas      | aprovada como hipótese de produto | Período e denominador explícitos. Sem atendidos nem faltas, a taxa é "sem dados". Os agendamentos passados sem desfecho aparecem junto                                                                                                                                   |
| 6   | Correção de consumo | fora do protótipo                 | Passa a ser **decisão obrigatória antes do piloto**. Uma correção futura preserva o histórico e audita o ajuste                                                                                                                                                          |

**Escopo** (o "pronto quando" da F3):

- conclusão repetida ou concorrente não consome duas sessões, e consumo além do total é recusado;
- sessões restantes e retornos pendentes corretos;
- quem tem só permissão de agenda não vê pacote nem saldo, nem pela API;
- nenhum conteúdo S em entidade do Core nem na auditoria;
- a taxa de faltas apurável.

**Entregas** (divisão aprovada). Cada uma tem ADR antes do código, `reviewer` e `security`, bateria completa e parada para revisão:

- **F3.1:** pacote e consumo de sessão no registro de atendimento, na API;
- **F3.2:** retorno no Clinics, na API;
- **F3.3:** a taxa de faltas na API, as telas de pacote, saldo, retornos e faltas, e o e2e.

#### Decisões propostas

1. **Pacote (`ClinicsPackage`, classe S).** Campos:
   - paciente e serviço, com FKs compostas `NO ACTION`;
   - total de sessões (`CHECK` de 1 a 100);
   - sessões consumidas (`CHECK 0 ≤ consumidas ≤ total`);
   - **preço total** opcional em centavos, com a moeda do serviço;
   - `dealId` opcional (FK composta), só como vínculo, sem copiar dado do deal;
   - estado (`active`, `completed`, `canceled`), `closedAt` e quem criou.

   Nenhum campo de texto (H7).

2. **Preço total explícito e congelado.** O preço do serviço é por sessão e não define o total de um pacote. O total é **digitado por quem cria**, aparece na confirmação e fica **congelado** (o total não muda depois da criação). Não se infere desconto, pagamento nem quitação: isso não é gestão financeira, e a D1 segue aberta. O campo é opcional, como no §8: sem total, o pacote não tem preço registrado.
3. **Contador de sessões, com a garantia exata.**
   - **O que o banco garante sozinho:** o `CHECK` mantém as consumidas no intervalo permitido. O consumo é **um único `UPDATE` condicional** (`consumidas = consumidas + 1` onde o pacote é do workspace, está `active` e `consumidas < total`). A trava de linha desse `UPDATE` serializa os consumos concorrentes, e com zero linhas afetadas a resposta é 409. Ao chegar ao total, a mesma instrução passa o estado a `completed`.
   - **O que depende da transação e dos caminhos de escrita: a igualdade "consumidas = atendimentos vinculados".** Ela vale porque:
     - **um caminho só escreve as duas coisas:** o registro de atendimento cria o atendimento com o vínculo, faz o incremento e grava a auditoria **na mesma transação**. Qualquer falha desfaz as quatro coisas, inclusive a transição para `attended`. Não existe recuo silencioso para "avulso";
     - **o total e os vínculos não mudam por edição genérica:** não há rota que altere o total, as consumidas ou o vínculo do atendimento. Um trigger no banco recusa mudar o total, mudar as consumidas por outra coisa que não `+1` com o pacote ativo, e mudar o `packageId` de um atendimento depois de criado. O único outro caminho de escrita no pacote é o cancelamento, que só muda o estado.

     Uma correção futura (item 9) muda essa regra com ADR próprio.

   - **Testes exigidos:**
     - concorrência no último saldo (um consumo, um 409);
     - registro repetido e concorrente no mesmo agendamento (um consumo);
     - **rollback**, com uma falha injetada depois do incremento: nada fica, nem o atendimento, nem o vínculo, nem o incremento, nem a auditoria;
     - **cancelamento concorrente com consumo**, nas duas ordens: se o cancelamento vem primeiro, o consumo é recusado e o atendimento não é registrado; se o consumo vem primeiro, o cancelamento comita depois, com as consumidas mantidas;
     - a tentativa de editar o total ou o vínculo recusada pelo banco;
     - a igualdade conferida ao fim de cada cenário;
     - mutação de cada garantia.

     Uma consulta de conferência da igualdade entra no runbook.
4. **Consumo explícito.**
   - **Pedido:** o registro de atendimento ganha `packageId` **opcional**. Sem ele, o atendimento é avulso. O servidor não escolhe pacote.
   - **Tela:** pode sugerir o pacote ativo, mas mostra com clareza **qual pacote será consumido**, com o saldo antes e depois, **antes da confirmação**.
   - **Validação:** o pacote precisa ser do mesmo paciente e do mesmo serviço do agendamento, e estar ativo e com saldo. Senão, o pedido é recusado sem efeito.
   - **Repetição:**
     - **o mesmo pedido** (mesmo agendamento, mesma escolha) devolve o atendimento existente, **sem novo consumo**;
     - **com escolha diferente** (outro pacote, de avulso para pacote ou de pacote para avulso) responde **409**, sem aplicar a nova escolha e sem fingir que aplicou.
   - **Vínculo:** `ClinicsAttendance.packageId` passa a existir, anulável, com FK composta `NO ACTION`.
5. **Encerramento.** `completed` vem automaticamente com a última sessão. `canceled` é manual (`clinics:care:write`): recusa os consumos seguintes e mantém as consumidas. A reabertura fica fora da F3.
6. **Retorno no Clinics (`ClinicsReturn`, classe S), sem `Task` do Core.** Um título neutro não elimina o que o contato, o responsável, o vencimento e o momento da criação revelam. Além disso, o `Profissional` não tem `tasks:*`. O retorno fica no domínio do Clinics, sem ampliar acesso ao CRM, e **a ponte para `Task` não é implementada nesta etapa.**
   - **Campos:**
     - paciente, serviço e unidade (FKs compostas `NO ACTION`);
     - o atendimento de origem (opcional, único);
     - a **data de vencimento**, local da unidade;
     - o estado (`pending`, `done`, `canceled`);
     - o **responsável** (membership, FK composta, opcional);
     - o agendamento que o cumpriu (opcional);
     - o motivo do cancelamento, por lista fechada (`patient_declined`, `not_needed`, `other`), sem texto livre;
     - quem e quando criou, concluiu ou cancelou.
   - **Criação, explícita nos dois caminhos:**
     - **automática** no registro de atendimento de um serviço com intervalo (`ClinicsService.returnIntervalDays`, anulável, `CHECK` de 1 a 365, H3), na mesma transação;
     - **manual**, por quem tem `clinics:care:write`.

     O vencimento é a data local de conclusão mais o intervalo.

   - **Conclusão:** manual, com o agendamento que cumpriu o retorno, quando houver.
   - **Cancelamento:** manual, com o motivo da lista.
   - **Reatribuição:** manual.
   - **Permissões, sem chave nova:**
     - **ver** a lista de retornos (paciente, serviço, vencimento, estado, responsável): `clinics:schedule:read`. Quem marca o retorno é a recepção, e a agenda já mostra paciente, serviço e estado de agenda. A lista **não** mostra o atendimento de origem nem pacote;
     - **criar manualmente**: `clinics:care:write`;
     - **concluir, cancelar e reatribuir**: `clinics:schedule:write` (recepção) **ou** `clinics:care:write` (profissional).
   - **Responsável explícito e capaz de operar.** Na atribuição, o servidor confere que o responsável tem `clinics:schedule:write` ou `clinics:care:write`. Na lista, um responsável que perdeu o acesso aparece como "sem acesso", para reatribuição. Sem responsável, o retorno fica "sem responsável", e nunca é atribuído a quem não consegue operá-lo.
   - **Vencido:** calculado pelo relógio do banco, no fuso da unidade (ADR-049).
   - **Fora do Core:** nenhum evento de outbox, nenhum webhook e nenhum uso pela IA.
7. **Taxa de faltas (hipótese de produto, H6).**
   - **Período:** datas locais `[de, até)` no fuso da unidade, convertidas no banco, pelo **início** do agendamento.
   - **Denominador explícito:** `atendidos + faltas`.
   - **Taxa:** `faltas / (atendidos + faltas)`. **Sem atendidos nem faltas, a taxa é "sem dados", nunca 0 %.**
   - **Mostrados junto**, para a taxa não parecer completa:
     - os **agendamentos passados ainda sem desfecho** (marcados, confirmados e chegados com início antes de agora, pelo relógio do banco);
     - os cancelados, à parte e fora da conta.
   - **Endpoint:** `GET /api/clinics/metrics/no-show?de&ate&unitId`, com recorte opcional por profissional ou serviço. Ele devolve **só agregados**, sem nenhuma pessoa.
   - **Permissão:** `clinics:schedule:read`.
   - **Persistência:** nenhuma. O cálculo usa o índice `(workspaceId, unitId, startsAt)`.
8. **Permissões** (resumo, sem chave nova):

   | O quê                                    | Permissão                                        |
   | ---------------------------------------- | ------------------------------------------------ |
   | Pacote: criar                            | `clinics:care:write` e `clinics:schedule:read`   |
   | Pacote: cancelar                         | `clinics:care:write`                             |
   | Pacote: ver e saldo                      | `clinics:care:read`                              |
   | Retorno: ver                             | `clinics:schedule:read`                          |
   | Retorno: criar manualmente               | `clinics:care:write`                             |
   | Retorno: concluir, cancelar e reatribuir | `clinics:schedule:write` ou `clinics:care:write` |
   | Taxa de faltas                           | `clinics:schedule:read`                          |

   A resposta da agenda continua omitindo no servidor, para quem só tem agenda, o vínculo com atendimento e pacote (§5).

9. **Correção de consumo: fora do protótipo, decisão obrigatória antes do piloto.** Com dados fictícios, a F3 não tem correção de um consumo errado. Isso **não** presume que a operação dispense a correção: a decisão é **obrigatória antes do piloto**. Se houver correção, ela **preserva o histórico e audita o ajuste**. O atendimento original nunca é apagado, e o ajuste é um lançamento próprio, com quem, quando e o motivo por lista fechada.
10. **Auditoria por allowlist, sem conteúdo S textual:**
    - pacote criado ou cancelado (ids, total de sessões, consumidas, estado, se há preço);
    - atendimento registrado (mais o `packageId`);
    - retorno criado, concluído, cancelado ou reatribuído (ids, vencimento, estado, motivo).
11. **Retenção e LGPD (§9.2, B3).** Nenhuma exclusão definitiva antes da decisão jurídica. As FKs para o paciente ficam `NO ACTION`, e excluir o contato de um paciente já é recusado.
12. **Integrar ou construir.** Não há ferramenta madura que dispense as invariantes no banco, então a opção é construir. A métrica é uma consulta agregada.
13. **Migration aditiva** (por entrega):
    - os modelos `ClinicsPackage` e `ClinicsReturn`;
    - as colunas `ClinicsAttendance.packageId` e `ClinicsService.returnIntervalDays`;
    - os triggers do item 3.

    Os modelos entram no registro do vertical (`WORKSPACE_MODELS`), no `check:fk` e na checagem de presença da porta E6. A dívida do tamanho dessa checagem será medida na F3.1.

**Fica fora da F3:**

- a D1;
- a validade do pacote;
- a reabertura;
- a ponte do retorno para `Task` do Core;
- a interface multiunidade;
- as notificações, que ficam para a F4;
- a correção de consumo (item 9, obrigatória antes do piloto).

**Decisões para a aprovação desta revisão:**

1. a garantia e os testes do contador (item 3), com o trigger de imutabilidade;
2. o 409 para a repetição com escolha diferente (item 4);
3. o preço total explícito (item 2);
4. o retorno no Clinics, com as permissões e o responsável capaz de operar (item 6). Em especial: a **lista de retornos visível com `clinics:schedule:read`**, para a recepção marcar o retorno, sem o atendimento de origem nem pacote;
5. a definição da taxa de faltas (item 7);
6. a correção de consumo como decisão obrigatória antes do piloto (item 9).

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
  - **Exceção posterior:** a F3.2 (ADR-048, adendo 7) usa `clock_timestamp()` no `ClinicsAttendance.recordedAt`. O registro pode esperar a trava do agendamento, e a prova da conclusão do retorno precisa do instante de depois da espera. Isso não muda o referencial dos claims.

**Alternativas.**

- **Varredura do despacho com corte calculado no Node.** Rejeitada: poria uma fila no relógio do Node e a exporia ao desvio entre instâncias.
- **Trigger também no outbox.** Desnecessário: `nextRetryAt` só é agendado pelo Node na criação, e o DEFAULT resolve.
- **Tolerância (folga de N segundos) nos claims.** Rejeitada: esconde o desvio sem eliminar o par misto.

## ADR-050 — Cache da tela por sessão: um cache por identidade e workspace, e resposta de outra sessão descartada

**Status:** aceito (pedido pela revisão de 2026-10-20, que bloqueou a publicação da F2.3 até esta correção) · **Data:** 2026-10-20

**Contexto.** O passe de `security` da F2.3 registrou como dívida, e a revisão de 2026-10-20 confirmou no código e transformou em bloqueio, um vazamento do cache do TanStack Query entre sessões na mesma aba:

- **O cache só era limpo no logout explícito.** O login só trocava o usuário da sessão (`setQueryData` de `/auth/me`).
- **Quase nenhuma chave identifica a sessão.** `['contacts', params]`, `['clinics', 'patients', 'search', busca]` e as demais não levam identidade nem workspace. A exceção é o status do Clinics, que leva a membership.
- **A expiração sem logout não limpava nada.** Com o refresh recusado, cada requisição falha com 401, mas a tela continua montada e `/auth/me` fica no cache (60 s). O recomeço vai para `/login` sem recarregar a página.
- **Consequência:** quem entra em seguida na mesma aba, inclusive em outro workspace, recebe do cache os dados da sessão anterior:
  - na hora, enquanto a consulta recarrega;
  - e, nas consultas com `staleTime` (a busca de paciente e a de contato do Clinics, 30 s), sem nem recarregar, podendo escolher o resultado.

  Vale para o CRM, mesmo com o Clinics desativado.

- **Requisição em voo:** a resposta de uma requisição da sessão anterior pode chegar depois do novo login e gravar no cache novo.
- **Outra aba:** os cookies são da origem, não da aba. Um login ou uma troca de workspace em outra aba muda a identidade das próximas respostas desta, sem que ela saiba.

**Decisão.**

1. **Escopo da sessão** é `userId:membershipId` (`-` sem workspace). `apps/web/src/lib/session-scope.ts` guarda três coisas:
   - o escopo atual: desconhecido, sem sessão ou um escopo;
   - uma **época**, que sobe a cada troca de sessão;
   - as requisições em voo.
2. **Um cache por sessão.** O `QueryClient` deixa de ser global. O `SessionQueryProvider` cria um novo a cada troca de sessão, semeado com o usuário quando ele já é conhecido, e remonta a árvore abaixo dele. O anterior é limpo (`clear()`, que também cancela retentativas) e descartado.
   - **Nada atravessa a troca:** nem consultas, nem mutações, nem estado local de componentes.
   - **É o mecanismo equivalente a pôr identidade e workspace em todas as chaves.** A separação é física, e não depende de cada uma das mais de 80 chaves do web nem de quem escrever a próxima.
3. **Quando a sessão troca:**
   - **resposta que emite sessão:** login, troca de workspace e aceite de convite. Todas passam por `setSessionCookies`, que marca a resposta com `X-Veyra-New-Session`, e o `lib/api.ts` troca a sessão ao ver a marca. O login troca sempre, mesmo que a identidade seja a mesma. Nenhuma tela precisa lembrar disso, e uma rota nova que emita sessão já vem coberta;
   - **logout;**
   - **perda de sessão:** o refresh responde 401 (expirou ou foi revogada). Falha de rede, 429 ou 5xx no refresh **não** derrubam a sessão; a requisição só falha. Um refresh que já estava em voo quando a sessão trocou não tem efeito nenhum, e o refresh seguinte **espera** ele terminar: o mesmo token apresentado duas vezes é reuso para o servidor, que derruba a família inteira (a troca de workspace não rotaciona o token). Entre abas da mesma origem, `navigator.locks` faz um refresh de cada vez. Só as **esperas** têm prazo: a de quem chama (15 s) e a pela trava entre abas (30 s). Estourou, a requisição falha e a sessão fica, como numa falha de rede. O pedido de refresh em si **nunca** é abortado: abortar no navegador não cancela a rotação no servidor, o `Set-Cookie` se perderia e o próximo refresh reapresentaria o token velho, o que é reuso. Ele segue segurando a trava até terminar e, quando o navegador oferece a trava (contexto seguro: staging e produção são HTTPS, ADR-046, e `localhost` também), nunca sai sem ela. O logout também não é abortado pela troca de sessão (a época continua conferida): abortado depois de o servidor revogar, o cookie de limpeza se perderia e o próximo refresh seria reuso. O custo, consciente, é o inverso: o navegador sempre aplica esse cookie de limpeza, e se um login de outra pessoa gravou cookie novo entre a execução do logout e a chegada da resposta, a limpeza apaga o cookie novo. Essa sessão cai no login na próxima requisição, sem reuso e sem vazamento. Para `/auth/me`, um 401 que o refresh não resolveu leva ao login de qualquer forma, e aí a aba troca (falha fechada);
   - **refresh ou `/auth/me` com outra identidade ou outro workspace.** Inclui a membership desativada: o refresh responde 201 **sem workspace**, e o escopo vira `userId:-`;
   - **resposta de outra sessão:** toda resposta autenticada traz `X-Veyra-Scope`, escrito pelo `JwtAuthGuard` com a identidade **revalidada** no banco. Se ele difere do escopo da aba, a resposta é descartada e a aba recomeça, relendo `/auth/me`. É o caso do login ou da troca de workspace em outra aba;
   - **a aba volta a ficar visível:** relê `/auth/me`. A aba que perdeu a sessão, ou cujo cookie mudou em outra aba, recomeça na hora, sem esperar o próximo clique. Uma aba em segundo plano não faz requisição nenhuma (o polling para), e sem isso mostraria a tela antiga até a primeira ação.
4. **Resposta de requisição antiga nunca chega a quem pediu.** `lib/api.ts` continua sendo o único lugar com fetch e anota a época no início de cada requisição. Na troca de sessão:
   - as requisições em voo são **abortadas**;
   - qualquer resposta que ainda chegue com época antiga é **descartada** com `SessaoEncerradaError`. Isso vale também para erros e para a repetição depois do refresh.

   O cache por sessão (item 2) já prende as consultas e mutações da árvore velha ao cache velho. **O que só a época faz** é o que fica fora dele, e é por isso que ela não é redundante:
   - impedir que um `/auth/me` ou um refresh atrasado volte a adotar a identidade anterior;
   - impedir que o escopo antigo de uma resposta atrasada seja lido como "o cookie mudou", o que derrubaria a sessão nova (por isso a época é conferida **antes** do escopo);
   - não entregar dado nem erro antigo a código que ainda espera a resposta.

   O login (`POST /api/auth/login`, exatamente) fica de fora, porque a resposta dele **é** a sessão nova. As consultas não retentam `SessaoEncerradaError`.

5. **A requisição declara de qual sessão é, e o servidor recusa a divergência.** Com o escopo conhecido, toda requisição do web leva `X-Veyra-Expected-Scope`. Depois de revalidar a sessão, o `JwtAuthGuard` compara esse valor com o escopo do cookie. Se forem diferentes, responde **409 antes de executar qualquer coisa**, já com o `X-Veyra-Scope` verdadeiro, e a aba recomeça na sessão do cookie.
   - **O que fecha:** a mutação de uma aba desatualizada. Os cookies são da origem, não da aba. Depois de um login ou de uma troca de workspace em outra aba, a próxima requisição da aba velha, que pode vir horas depois (o formulário preenchido e enviado na volta), seria executada com a identidade nova: autoria e auditoria em nome de outra pessoa, ou escrita no workspace errado. Numa recepção de clínica, duas contas no mesmo navegador são a regra.
   - **Sem o cabeçalho, nada muda:** login, refresh, rotas públicas e clientes de API com `Bearer` não o mandam.
   - **Exceção conhecida:** o download de anexo por link (`<a href>` no inbox) não passa pelo `lib/api.ts` e não leva o cabeçalho. Ele não vaza entre workspaces: o id do arquivo é do workspace, e o de outro dá 404. É só leitura, com a identidade do cookie.
   - **Só o logout que o servidor confirmou leva a aba a "sem sessão".** O de uma aba desatualizada recebe o 409 e recomeça na sessão do cookie. O que falha por rede ou 5xx mantém a sessão e avisa que não foi possível sair. Nenhum dos dois finge que o navegador saiu, com o cookie ainda vivo.

**Consequências.**

- Toda troca de sessão remonta a árvore: formulários e drawers abertos fecham. Numa troca de identidade, é o desejado.
- A expiração sem logout deixa de mostrar erros sobre a tela velha: a aba vai para o login, sem dado.
- Um cabeçalho a mais em toda resposta autenticada, com ids que a própria sessão já recebe em `/auth/me`. O CORS o expõe para o caso de origens diferentes; em staging, web e API são a mesma origem.
- Um cabeçalho a mais em toda requisição do web com sessão conhecida. Para origens diferentes, o CORS do Nest já reflete os cabeçalhos pedidos na pré-verificação.
- **Residual, anterior a este ADR e fora do cliente:** se a resposta de um refresh se perde depois de o servidor rotacionar (F5 ou aba fechada no meio, 504 do proxy enquanto a API ainda conclui), o próximo refresh reapresenta o token velho, e o servidor trata isso como reuso: derruba todas as sessões do usuário. Falha fechada, sem vazamento. Fica como dívida, com a decisão para um ADR próprio: separar o motivo da revogação (rotação ou logout), ou uma carência curta para o token recém-rotacionado.
- **Fora do escopo:** uma permissão perdida **dentro** da mesma sessão (só o `tokenVersion` mudou) não troca o cache. O servidor já nega as leituras novas, e o `/auth/me` em cache pode mostrar as permissões antigas por até 60 s. Não é vazamento entre sessões.

**Alternativas.**

- **Identidade e workspace em todas as chaves** (prefixo, ou `queryKeyHashFn` com o escopo). Rejeitada como mecanismo principal: depende de cada chave e de cada `setQueryData`, e não resolve a resposta em voo nem a troca em outra aba.
- **`queryClient.clear()` no login e na perda de sessão, com o mesmo client.** Rejeitada sozinha: os observadores montados guardam a referência à consulta removida, e uma resposta em voo volta a aparecer neles. O `onSuccess` de uma mutação antiga também escreveria no cache novo.
- **Recarregar a página na troca.** Limpa o cache, mas não impede a resposta em voo de ser tratada antes do reload, e depende de cada caminho de troca lembrar de recarregar.
- **Deixar a mutação da aba desatualizada como dívida.** Foi a primeira versão deste ADR. O passe de `security` mostrou que a janela vai até a próxima requisição da aba velha, e não até "logo depois da troca", e que a correção cabe em poucas linhas. Rejeitada.

**Testes.**

- **Web, unidade (`api` e `session-scope`):**
  - a resposta em voo que chega depois da troca é descartada, com e sem abort, inclusive o erro;
  - a resposta com outro `X-Veyra-Scope` é descartada e a aba recomeça, e a resposta atrasada com o escopo antigo não derruba a sessão nova;
  - o refresh com 401 é perda de sessão; com falha de rede, 429 ou 503, não é; sem workspace, troca; em voo durante uma troca, não tem efeito;
  - a requisição declara o escopo esperado, e o 409 recomeça a aba;
  - a marca de sessão emitida troca a sessão (login, aceite de convite, troca de workspace);
  - o login não é abortado, e a isenção dele é exata.
- **Web, o App inteiro na mesma aba, em StrictMode, com um servidor falso que responde como o real (escopo, 409, marca de sessão):**
  - duas sessões, em workspaces diferentes, com expiração sem logout; todo cache anterior fica vazio;
  - a busca global, com `staleTime` de 30 s, não reaparece para a sessão seguinte no mesmo termo;
  - a resposta antiga que chega depois do novo login não aparece;
  - a troca feita em outra aba, pela próxima requisição e pela volta da aba à frente;
  - logout pela tela; o logout de uma aba desatualizada, que não encerra a sessão da outra pessoa nem finge que o navegador saiu; e o logout que falha, que mantém a sessão e avisa.
- **Integração:** o cabeçalho reflete a identidade revalidada, muda com a troca de workspace e não existe em rota pública nem no 401; o escopo esperado divergente é recusado com 409 antes de executar; login, troca de workspace e aceite de convite marcam a sessão emitida.
- **E2E, navegador real:**
  - mesma aba: expiração por revogação no banco e login em outro workspace, sem nenhum dado da sessão anterior. Uma resposta antiga fica retida até depois do novo login e é **abortada** pela troca: o e2e afirma o abort pelo `requestfailed` do pedido retido; a resposta que chega mesmo assim é provada no Vitest;
  - duas abas: o formulário enviado pela aba desatualizada não grava nada.
- **Mutação:** cada mecanismo desfeito faz o teste dele falhar.

**Implementação (2026-10-20).**

- **Contratos:** `SESSION_SCOPE_HEADER`, `SESSION_EXPECTED_SCOPE_HEADER`, `SESSION_ISSUED_HEADER` e `sessionScopeKey`, a mesma chave no servidor e no web.
- **API:** o `JwtAuthGuard`, depois de revalidar a sessão, escreve `X-Veyra-Scope` e recusa com 409 o escopo esperado divergente; `setSessionCookies` marca a sessão emitida; o CORS expõe os dois cabeçalhos. Testes de integração no fluxo de auth e no aceite de convite.
- **Web:**
  - `lib/session-scope.ts`: escopo, época, requisições em voo e a troca de sessão;
  - `lib/api.ts`: um protocolo de sessão só, para JSON e upload. Declara o escopo esperado; aborta e descarta por época e por escopo; o refresh distingue 401 (sessão perdida) de rede, 429 e 5xx, e não tem efeito se a sessão trocou enquanto ele voava; a marca de sessão emitida troca a sessão;
  - `lib/session-query.tsx`: o `SessionQueryProvider`, que troca de `QueryClient`, remonta a árvore e relê `/auth/me` quando a aba volta a ficar visível;
  - `lib/session.ts`: o logout vira troca de sessão, e `/auth/me` adota ou troca o escopo;
  - lint: `fetch` fora de `lib/api.ts` é erro, inclusive `window.fetch` e `globalThis.fetch`.
- **Testes:** 31 de unidade, 8 com o App inteiro, 2 de integração (mais uma asserção no aceite de convite) e 2 e2e.
- **Mutação:** cada mecanismo desfeito faz o teste dele falhar:
  - sem cache novo por sessão;
  - sem época;
  - sem conferir o escopo do servidor;
  - sem abort;
  - refresh 401 sem perda de sessão;
  - qualquer falha de refresh como perda;
  - sem declarar o escopo;
  - guard sem conferir o escopo esperado;
  - refresh sem época;
  - troca de workspace sem troca de sessão;
  - isenção do login por prefixo;
  - sem reler a sessão quando a aba volta;
  - sem limpar o cache anterior;
  - sem esperar o refresh de outra época;
  - sem a trava entre abas;
  - sem prazo na espera pela trava;
  - sem prazo na espera de quem chama pelo refresh;
  - pedindo outro refresh com o de outra época ainda pendurado;
  - logout abortável pela troca de sessão;
  - logout que falha forçando "sem sessão";
  - adotando corpo de sessão sem validar.
- **Terceira rodada do `security` (2026-10-20),** sobre a versão com o 409 e a marca de sessão. Aprovou com ressalvas, e esta versão incorpora:
  - o refresh encadeado entre épocas: o seguinte espera o anterior, porque a troca de workspace não rotaciona o token e dois refreshes com o mesmo token derrubariam todas as sessões;
  - a trava entre abas, porque a releitura ao voltar à aba sincroniza duas janelas;
  - o corpo de sessão validado antes de trocar;
  - o texto sobre a marca no refresh, tratado por adoção;
  - o lint de `XMLHttpRequest`, `EventSource`, `WebSocket` e `navigator.sendBeacon`.
- **Confirmação final do `security` (2026-10-20):** aprovou, e entraram o prazo da trava entre abas e o lint dessas APIs também via `window`. O prazo que entrou também no **pedido** de refresh foi retirado na rodada seguinte do `reviewer`: abortar o pedido não cancela a rotação no servidor e levaria a reuso. O que tem prazo é a espera de quem chama. Fica como sugestão, sem mudança, um aviso na tela quando o logout de uma aba desatualizada a faz recomeçar na sessão de outra pessoa.
- **Revisão delta do `reviewer` (2026-10-20):**
  - o e2e passa a **afirmar** o abort (`requestfailed` do pedido retido);
  - o logout de aba desatualizada não força a tela de login;
  - o `/auth/me` só adota a sessão se a época não mudou, como o refresh;
  - a época nunca volta a zero, nem no reinício para testes;
  - a exceção do download por link está registrada;
  - na rodada seguinte: o pedido de refresh deixou de ser abortado (prazo só nas esperas, com teste), e o logout que falha mantém a sessão e avisa.
- **Quarta rodada do `security` (2026-10-20):** aprovou, e entraram:
  - o logout fora do abort;
  - o teste do refresh de outra época pendurado;
  - o aviso de que a pessoa continua conectada;
  - a premissa de HTTPS;
  - o caso do Safari sem `AbortSignal.timeout`;
  - o residual do reuso no servidor, registrado como dívida.
- **Revisão do `reviewer` (2026-10-20).** Aprovou com ressalvas, e esta versão incorpora:
  - o teste da busca com `staleTime`, que o texto citava sem existir;
  - o e2e descrito como "retido e abortado";
  - a seção 10 da ARCHITECTURE atualizada;
  - o papel próprio da época escrito no item 4;
  - a marca de sessão emitida no lugar dos caminhos literais (o aceite de convite também emite sessão);
  - a releitura da sessão quando a aba volta;
  - os testes do App em StrictMode, com 409 e conferindo a limpeza do cache anterior;
  - o protocolo único para JSON e upload;
  - o lint de `window.fetch` e `globalThis.fetch`.
- **Segunda rodada do `security` (2026-10-20).** Aprovou a primeira versão com ressalvas, e esta versão incorpora:
  - a mutação da aba desatualizada, que era dívida e virou o item 5 da decisão;
  - a correção do caso da membership desativada (refresh 201 sem workspace, não 401), com teste;
  - o refresh atento à época;
  - a isenção exata do login;
  - a troca de workspace centralizada;
  - a regra de lint;
  - a trava na função de reinício para testes.

  Ficaram como observação, sem mudança:
  - com escopo ainda desconhecido (aba recém-aberta), a aba aceita o escopo de qualquer resposta. As únicas requisições nesse estado são `/auth/me` e o login;
  - a perda de permissão dentro da mesma sessão (ver Consequências).

- **Achado dos testes: a ordem das conferências.** A primeira versão conferia o escopo do cabeçalho antes da época. Uma resposta atrasada da sessão encerrada, com o escopo antigo, era lida como "o cookie mudou" e derrubava a sessão nova. A época vem primeiro, com teste próprio.
- **Achado do e2e, defeito antigo do Core:** a tela de Contatos congelava a aba quando se digitava na busca antes da primeira resposta da lista.
  - **Causa:** `useReactTable` recebia um `[]` novo a cada render. O TanStack Table via "dados novos" e agendava em microtarefa a volta à página 0, num laço que não deixava a resposta da rede ser processada.
  - **Não tinha relação com a sessão:** reproduz com o código anterior a este ADR, e só aparecia com a rede ou a máquina lentas.
  - **Correção em commit próprio:** um vazio estável, com teste de regressão que não trava o runner se o defeito voltar.

## ADR-051 — Migrations novas: transação explícita, exceções justificadas e recuperação verificável

**Status:** aceito (decisão do usuário, 2026-10-21) · **Data:** 2026-10-21

**Contexto.** O ensaio da F3.1 (ADR-048 adendo 7, "Ajustes pedidos antes da liberação") mostrou que o `prisma migrate deploy` (Prisma 7.9.1) executa cada migration **instrução por instrução, sem transação**. Uma falha no meio deixa aplicado o que veio antes. O procedimento que o runbook ensinava, `resolve --rolled-back` e repetir, não recupera: a repetição falha nos objetos que já existem. A `20261021120000_clinics_packages` já saiu transacional, com a falha e a recuperação ensaiadas. As anteriores continuam como foram publicadas.

**Decisão.**

1. **Transação explícita por padrão.** Toda migration nova começa com `BEGIN;` e termina com `COMMIT;`. As configurações de sessão vão com `SET LOCAL` (por exemplo, `SET LOCAL lock_timeout = '5s'`), que vale só até o fim da transação; nada de `RESET`. O `prisma migrate dev` gera o SQL sem transação, por isso a migration é gerada com `--create-only`, editada e só então aplicada. Editar depois de aplicada muda o checksum.
2. **Exceções justificadas.** O critério: fica fora da transação só o que o Postgres recusa num bloco de transação ("cannot run inside a transaction block").
   - **Exemplos que cabem numa migration:** `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY` e `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`.
   - **Também recusados, mas sem lugar numa migration:** `VACUUM`, `CREATE/DROP DATABASE` e `ALTER SYSTEM`.
   - **Isolamento:** a exceção vai **isolada numa migration própria**, sem nada que dependa dela.
   - **Cabeçalho:** diz qual instrução é, por que não pode ir em transação e como se recupera a falha dela. Exemplo: um `CREATE INDEX CONCURRENTLY` que falha deixa um índice `INVALID`, que precisa ser removido antes de repetir.
   - **Valor novo de enum não é exceção.** O `ALTER TYPE ... ADD VALUE` roda em transação, mas o valor novo só pode ser usado depois do `COMMIT`. Quem precisa usá-lo divide o trabalho em duas migrations transacionais, a do valor antes da que o usa.
   - **Backfill longo** vai numa migration transacional própria, separada do DDL que trava tabela. A separação já existia na `20261021090100_message_dispatch_ai_origin_backfill`, que é anterior à regra e não tem `BEGIN` (é um `UPDATE` único, atômico por si).
3. **Recuperação verificável, antes do commit:**
   - **Inventário.** Uma consulta que lista os objetos que a migration cria (tipo, tabela, coluna, índice, restrição com `contype <> 'n'`, função e gatilho), com a contagem esperada. Ela vai para o `DEPLOY_STAGING` §4, em "Falha de migration".
   - **Falha forçada, ensaiada.** Numa cópia da migration, entra `DO $$ BEGIN RAISE EXCEPTION 'falha forçada'; END $$;` antes do `COMMIT`. Ela é aplicada pelo mesmo `prisma migrate deploy`, num banco descartável **com o prefixo `veyra_ensaio_`**, com as migrations anteriores. O `DATABASE_URL` e a config do ensaio vão explícitos em todo comando. A skill traz o bloco ensaiado, com essas travas. O deploy precisa falhar, o `pg_dump --schema=public --schema-only` precisa sair igual ao de antes, e o inventário precisa dar zero. Sem a falha forçada, o inventário precisa dar a contagem esperada e o `migrate diff` precisa sair vazio. Numa exceção do item 2, ensaia-se a falha da própria instrução isolada e a recuperação descrita no cabeçalho.
   - **Cabeçalho.** Diz o que a migration faz, que locks pede e a estimativa das esperas por lock. O `lock_timeout` limita cada espera, não a soma nem a execução. O cabeçalho remete ao §4 para a falha: nunca `rolled-back` às cegas.
4. **Migrations publicadas não mudam.** Nenhuma é reescrita para entrar na regra, e nenhum checksum é ajustado. As antigas pendentes num deploy seguem o runbook: estado parcial exige plano revisado.

**Alternativas descartadas.**

- **Seguir sem transação** e tratar o estado parcial caso a caso, com um plano manual a cada falha, sob pressão e em manutenção. O ensaio mostrou que o caminho padrão trava.
- **Um bloco `DO $$ ... $$` por migration.** É atômico como instrução única, e o Prisma registraria o erro real. Mas põe DDL dentro de plpgsql, com aspas aninhadas, é difícil de revisar e obriga a reescrever à mão o SQL que o Prisma gera.
- **Reescrever as migrations já publicadas.** Mudaria checksums em ambientes que já as aplicaram; o usuário vetou.

**Consequências.**

- **Falha sem estado parcial:** uma migration nova que falha não deixa nada aplicado. A recuperação é ler a causa, conferir o inventário zerado, rodar `resolve --rolled-back` e o deploy (§4, ensaiado).
- **Erro real fora do Prisma:** na falha, o Prisma mostra só "current transaction is aborted" e não grava o log. A causa fica no log do Postgres.
- **Locks até o `COMMIT`:** a migration segura os locks até o fim, e as esperas se somam. Migration em tabela muito escrita roda em manutenção, como manda o runbook.
- **Mais trabalho por migration:** o ensaio da falha forçada e o inventário entram no checklist da skill `create-migration` e no do agente `database`. O Definition of Done do `CLAUDE.md` (§6) não muda sem decisão do usuário. Se ele quiser, a linha seria "migration nova transacional, com inventário e falha forçada ensaiada (ADR-051)".
- **Futuro, não decidido:** um hook que pergunte quando uma migration nova não tem `BEGIN`. Hoje a regra vale pela skill e pela revisão.

### Adendo 1 (2026-10-22) — a evidência corresponde ao que a migration muda (decisão do usuário)

O dump só de schema não prova o rollback de um backfill, e o "inventário zero" vale para objetos novos, não para qualquer migration. A recuperação verificável do item 3 passa a pedir a evidência do tipo de mudança:

- **Objetos novos:** inventário em zero depois da falha forçada e com a contagem completa depois da aplicação.
- **Objetos existentes alterados** (coluna nova em tabela existente; índice, gatilho, função ou restrição em tabela existente): a comparação das **definições anteriores e finais**. Depois da falha forçada, o `pg_dump --schema=public --schema-only` sai idêntico ao de antes. Depois da aplicação, a diferença entre os dois dumps é o efeito inteiro da migration, e precisa conter só o que ela declara.
- **Migration de dados** (backfill, correção): a conferência **dos dados**.
  - A base descartável é semeada com linhas representativas.
  - Uma consulta de conferência (contagem, soma ou `md5` das linhas afetadas) dá o mesmo resultado antes e depois da falha forçada.
  - Depois da aplicação, a consulta dá o resultado esperado, escrito antes do ensaio.

A skill `create-migration` traz o bloco de ensaio com as três evidências: os ganchos de dados são opcionais, e a diferença de definições sai sempre, para conferência. O bloco foi ensaiado na `20261021120000_clinics_packages` (objetos novos) e numa migration sintética de dados, numa cópia temporária do repositório: a falha deixou os dados intactos, e o resultado esperado errado interrompeu o ensaio.

**Definition of Done:** o `CLAUDE.md` (§6) ganha a linha aprovada: "migration nova conforme ADR-051, com atomicidade ou exceção justificada e recuperação ensaiada".

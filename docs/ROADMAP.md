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

- **9.1.a — Ingestão ✅** endpoint público com assinatura sobre o corpo bruto (ADR-037), roteamento pelo número, dedupe por `wamid`, janela de atendimento (`lastInboundAt`) separada de consentimento (ADR-038), recibos deduplicados e ordenados pelo provedor (ADR-039), mídia apenas referenciada com coleta agendada.
- **9.1.b — Envio ✅** `MessageDispatch` reservado antes da chamada com a reserva de quota atrelada, classificação de falha em tabela isolada (retentável/permanente/ambígua), `unknown_after_dispatch` sem reenvio automático, política revalidada no worker, template registrado manualmente e exigido fora da janela, coleta de mídia com lease/fencing pelo transporte autenticado, e `messages_sent` cobrada.
- **9.1.c — UI ✅** canal e janela restante na lista do inbox; janela, opt-in e motivo do bloqueio acima do compositor; compositor trocando para template quando a janela fecha; estado de despacho por mensagem; tela de Uso mostrando o plano **efetivamente aplicado** (ADR-041) e a procedência de cada teto. A UI **mostra o veredito do servidor** (`GET /api/conversations/:id/send-policy`), nunca recalcula política.
- **Validação contra WABA real 🔜** (`docs/WABA_VALIDATION.md`) — pré-requisito da 9.2 e de qualquer piloto: a 9.1 foi construída contra transporte falso, e os testes provam coerência interna, não aceitação pela Meta.
- **9.2 — Privacidade operacional ✅**
  - **Retenção de `AiRun.result` ✅** (ADR-042): o conteúdo derivado de conversa expira por prazo próprio (`AI_RESULT_RETENTION_DAYS`, 90 dias) no job diário; a linha do run permanece, com custo e trilha.
  - **Scanner de antivírus ✅** (ADR-043): ClamAV atrás da porta `FILE_SCANNER`, varredura com lease/fencing, quarentena TERMINAL com a linha preservada como evidência e os bytes removidos após a transação, com confirmação do driver. Sem `CLAMAV_HOST` nada é liberado: o arquivo fica `pending`, que não sai para fora.
- **9.3 — Sugestão de resposta** ✅: a capacidade de IA entra AQUI, junto do canal, porque agora existe para onde enviar. Ação externa continua sendo `AiProposal` aprovada por humano. Entregue: rascunho estruturado sem ferramenta de escrita, proposta `send_message` pendente, aprovação delegando ao serviço de envio na MESMA transação do CAS da proposta, política reavaliada no aceite (proposta sobrevive a `pending`), autoria `ai`/`user` conforme edição, RBAC cumulativo e painel de revisão no inbox (ADR-044).

**Pronto quando:** conversa real de WhatsApp entra e sai do Veyra com opt-in verificado; arquivo sem scan não sai para canal externo; `AiRun.result` expira por idade.

## Entrega 10 — Veyra Clinics para estética (piloto vertical) 🚧

Vertical como **extensão** do Core (ADR-036, ADR-015 e §3.8 do CLAUDE.md): o Core continua sem conhecer o vocabulário clínico. Público inicial: **clínicas de estética no Brasil, com uma unidade**. Escopo nos **ADR-047** (contrato de extensão) e **ADR-048** (domínio e classificação de dados), **aceitos em 2026-10-19** (aprovação documental da F0).

A tese comercial do ADR-036 se mantém (`lead → WhatsApp → agendamento → confirmação → atendimento → retorno/reativação`). As métricas **faltas, conversão e pacientes recuperados** são **hipóteses não validadas** (ADR-048, H6). O product owner revisa o fluxo do produto, mas isso **não conta** como validação operacional: sem alguém de uma clínica revisando, H1–H7 seguem explicitamente não validadas.

- **F0 — Hipóteses e decisões ✅** ADR-047 e ADR-048 **aceitos em 2026-10-19**. A aprovação é **documental**: aprova o desenho e as decisões, não código nem migrations. Ficaram decididos:
  - o contrato de extensão com seis pontos;
  - o ciclo de vida da ativação e da restrição (desativar não levanta a restrição, e as liberações de IA ficam suspensas);
  - a matriz de permissões com o papel `Profissional`, que consulta a agenda e registra atendimento, sem marcar horários;
  - a restrição de todos os contatos por consumidor, sem liberação para webhooks;
  - a recusa provisória de exclusão.

  **Continuam pendentes, fora da engenharia:**
  - validação operacional de H1–H7 com alguém de uma clínica (a revisão do PO não conta);
  - avaliação jurídica do ADR-048 §9.2;
  - D1 (pago/em aberto), D2 (salas), D7 (um papel por membro) e D8 (profissional vê todos os atendimentos);
  - os bloqueios B1–B4. Sem eles, **nenhum dado real de paciente e nenhum piloto clínico**.

- **F1 — Fundação do vertical 🚧** Dividida em três entregas, cada uma com revisão própria:
  - **F1.a — pontos de extensão no Core ✅ (publicada):** E1, E2 (checagem de boot e teste de concessão), E4 e E6, com o schema em `prisma/schema/`, a barreira de lint e o teste de fronteira, sem vertical composto. Decisões de implementação no adendo 1 do ADR-047; a pendência sobre o lado oposto da relação no schema do Core foi decidida no adendo 2, item 1.
  - **F1.b — esqueleto do vertical 🚧** (plano aprovado; decisões nos adendos 2 e 3 do ADR-047). **Entrega 1, fotografia dos contatos no outbox: publicada.** **Entrega 2: implementada, em revisão.** Inclui o schema do vertical (`ClinicsSettings`, `ClinicsUnit`, `ClinicsContactRelease`), a CLI de ativação e desativação, o papel `Profissional`, a porta real do E6, a API de status e de liberação para IA e a garantia, no banco, de que evento terminal do outbox não é reaberto. O vertical está composto e **desativado em todo workspace, inclusive em staging**. O E5 foi movido para a F1.c.
  - **F1.c — catálogo da clínica 🔜.**

  Escopo e critérios da F1 como um todo: Os seis pontos de extensão do Core (ADR-047), incluindo a **restrição de conteúdo por contato (E6)** com a regra "restrito por padrão"; a barreira de dependência; a CLI de ativação e desativação com o ciclo de vida do ADR-047 §4, criando o papel `Profissional`; as sete permissões; a liberação de contato pela API; unidade, serviço, profissional e horários. Sala só se D2 for decidida a favor.
  **Pronto quando:**
  - workspace sem o vertical ativo recebe 403 nas rotas do Clinics (404 no caso residual de chave presente com o vertical desativado; adendo 2 do ADR-047, item 4) e não pode receber nenhuma chave `clinics:*` por nenhum caminho;
  - `enable` e `disable` repetidos convergem para o mesmo estado, sem segundo papel `Profissional`; depois de `disable` não resta nenhuma `clinics:*` em papel algum, o papel continua existindo e as sessões antigas caem;
  - contatos criados **antes** da ativação ficam restritos no commit da ativação, sem backfill, e falha ao consultar a presença do vertical equivale a "restrito";
  - **desativar não levanta a restrição:**
    - com o Clinics `disabled`, a IA continua recusando em todos os pontos, inclusive contatos criados depois da desativação, e webhooks continuam sem eventos de contato;
    - liberações de IA ficam suspensas até a reativação;
    - a porta do E6 não filtra por status (teste de regressão) e continua restringindo mesmo sem `ClinicsSettings` enquanto houver dados do vertical;
    - nada no vertical apaga `ClinicsSettings`;
  - **IA, em toda a superfície:**
    - cada capacidade (resumo, sugestão de resposta, próxima ação, explicação de lead score) recusa contato restrito sem chamar o provedor nem reservar quota;
    - chamada ao cliente de LLM sem declarar os contatos é recusada;
    - resultados e propostas persistidos de contato restrito não são devolvidos por nenhum endpoint, inclusive os gerados antes da ativação;
    - aprovação e despacho de mensagem da IA reconferem e recusam;
    - contato liberado para IA que vira paciente volta a ser recusado em todos esses pontos (depende de `ClinicsPatient`: entra na F2);
  - **webhooks:** para cada tipo de evento, nada ligado a contato de workspace com o Clinics é entregue, **inclusive de contato liberado para IA** e inclusive evento pendente de antes da ativação; deal ou tarefa sem contato, e workspaces sem o Clinics, seguem entregues;
  - a porta do E6 falhando equivale a "restrito" para os dois consumidores;
  - o Core não importa `verticals/` (lint + teste de fronteira);
  - teste P0 de isolamento em cada modelo, e FK composta recusa profissional ou membership de outro workspace;
  - `reviewer` + `security` aprovaram as mudanças no Core.

- **F2 — Paciente e agenda 🔜** `ClinicsPatient` sobre `Contact` e `ClinicsAppointment` com sobreposição impedida pelo banco.
  **Pronto quando:**
  - agendar exige profissional habilitado para o serviço;
  - **dois agendamentos concorrentes no mesmo horário resultam em exatamente um**;
  - paciente de outro workspace é recusado pelo banco, e o workspace A não lista a agenda do B;
  - excluir um contato com perfil de paciente é **recusado com 409** (provisório aprovado, ADR-048 §9.1). Exclusão e anonimização definitivas só depois da decisão jurídica;
  - contato liberado para IA que ganha perfil de paciente volta a ser restrito na mesma transação; tela mínima de liberação para IA no Clinics.
- **F3 — Atendimento e continuidade 🔜** `ClinicsAttendance` separado da agenda; chegada, conclusão e falta; pacote com consumo de sessão; retorno como `Task` do Core com título neutro.
  **Pronto quando:**
  - quem tem só permissão de agenda (Member/recepção) não vê atendimento, pacote nem saldo, nem pela API; o papel `Profissional` registra atendimento mas não agenda, e não lê o CRM do Core;
  - conclusão repetida ou concorrente não consome duas sessões, e consumo além do total é recusado;
  - sessões restantes e retornos pendentes estão corretos;
  - nenhum conteúdo S aparece em entidade do Core nem na auditoria;
  - a taxa de faltas é apurável.
- **F4 — Fluxo comercial 🔜** Confirmação e reativação pelo WhatsApp com aprovação humana, e conversão a partir do pipeline.
  **Pronto quando:** as três métricas são apuráveis com dados do piloto.

**Dependências externas:**

- A **validação contra WABA real** é dependência **só da F4**, na parte que envia confirmações pelo WhatsApp. Ela **não bloqueia** a F0 nem as fases operacionais F1–F3.
- **Dado real de paciente** em qualquer ambiente depende de levantar os bloqueios **B1–B4** do ADR-048 §10:
  - texto clínico digitado por pessoas nas superfícies do Core;
  - a regra "restrito por padrão" implementada e provada;
  - a decisão jurídica sobre exclusão e retenção;
  - a gestão de equipe pela interface.

  Até lá, staging e testes usam somente dados fictícios.

- **Equipe (B4 e D7), dependências explícitas para um piloto com equipe.** A criação do papel `Profissional` não as resolve:
  - não há convite nem troca de papel pela interface (só pela API), e não existe edição de papéis;
  - cada membro tem um só papel.

  Para F1–F3, a premissa é que Member cobre a recepção e `Profissional` cobre a consulta à agenda e o atendimento. **D7 é reaberta antes da F4** se alguma função precisar combinar o Clinics com o CRM ou o Inbox do Core. A gestão de equipe é lacuna do Core e precisa de entrega própria antes do piloto.

- **Integrações existentes:** ativar o Clinics num workspace faz os webhooks já configurados deixarem de receber qualquer evento ligado a contato (ADR-048 §6.5). Isso precisa ser comunicado a quem opera o workspace antes da ativação.

**Fora desta entrega:** prontuário, prescrição, pagamento online, financeiro e administração como módulos, equipamentos, fotos e texto clínico livre (condições para voltarem: ADR-048 §7), multiunidade na interface, e visibilidade restrita aos próprios atendimentos do profissional.

**Pronto quando (entrega):** a equipe de uma clínica cadastra um paciente e um serviço, agenda com o profissional certo, registra o atendimento e acompanha sessões e retorno, com permissões adequadas e sem planilha; com dados reais do piloto, as três métricas são apuráveis.

## IA além disso — por demanda, não por pacote

`oportunidade parada` entra quando houver consultas e retornos reais para observar. `intenção`, `limpeza de dados` e `previsão de pipeline` nascem de sinais do piloto. Capacidade sem demanda observada não é roadmap (ADR-036).

## Fora do MVP (backlog consciente)

Registro público/self-service (gatilho: ADR-014), RLS (ADR-013), **canal de e-mail** (o WhatsApp vem primeiro — Entrega 9), prontuário médico completo no Clinics, financeiro e administração do Clinics, relatórios avançados, mobile, i18n além de pt-BR, exportação LGPD self-service (endpoint administrativo primeiro).

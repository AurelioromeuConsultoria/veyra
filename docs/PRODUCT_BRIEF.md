# PRODUCT_BRIEF — Veyra

## 1. Problema

Empresas de serviços que vendem por relacionamento (clínicas, imobiliárias, consultorias, agências) usam CRMs genéricos que não falam a língua do seu negócio, ou sistemas verticais fracos em CRM (sem pipeline real, sem automação, sem IA útil). O resultado é o mesmo: leads esquecidos, follow-up manual, dado espalhado e nenhuma inteligência acionável.

## 2. Posicionamento

O Veyra ataca isso com uma arquitetura de dois níveis:

- **Veyra Core** — um CRM SaaS multi-tenant com as capacidades universais de relacionamento comercial, IA nativa e qualidade de engenharia de produto internacional.
- **Verticais** — produtos completos construídos **sobre** o Core (o primeiro provável: **Veyra Clinics**), que adicionam o vocabulário e os fluxos do nicho sem reimplementar CRM.

A tese: construir o CRM uma vez, com isolamento de tenant e IA estruturais, e originar verticais rapidamente por extensão — nunca por fork ou duplicação.

## 3. Capacidades do Core (universais, e somente elas)

| Área                | Capacidades                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Identidade e acesso | Workspace, usuários globais, convites, memberships, equipes, RBAC por permissões                |
| Relacionamento      | Contatos, empresas, tags, campos personalizados                                                 |
| Vendas              | Pipelines, estágios, oportunidades (deals)                                                      |
| Trabalho            | Tarefas, notas, atividades, timeline                                                            |
| Comunicação         | Conversas, mensagens, canais                                                                    |
| Organização         | Agenda, notificações, arquivos                                                                  |
| Plataforma          | Automações, webhooks, integrações, auditoria, billing, limites/quotas                           |
| Inteligência        | Módulo `intelligence`: capacidades de IA sobre os dados do workspace, via ferramentas auditadas |

## 4. O que o Core NUNCA modela

O Core não conhece **paciente, prontuário, imóvel, visitante** nem qualquer outro conceito vertical. Não há colunas "reservadas", enums "para o futuro clínico" nem módulos dormentes. Se um conceito só faz sentido em um nicho, ele pertence ao vertical.

Teste rápido para saber se algo entra no Core: _"Uma consultoria B2B, uma imobiliária e uma clínica usariam isso do mesmo jeito?"_ Se não, é vertical.

## 5. Como um vertical estende o Core — exemplo Veyra Clinics

| Conceito do Clinics    | Mecanismo de extensão                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Paciente               | Extension table 1:1 sobre `Contact` (`ClinicsPatient.contactId → Contact`, mesmo `workspaceId`, FK composta) |
| Profissionais de saúde | Extensão de `Membership`/`User` com dados do conselho e especialidade                                        |
| Unidades               | Entidade própria do vertical, tenant-scoped                                                                  |
| Serviços/procedimentos | Entidade própria, ligada a deals/agenda do Core                                                              |
| Agenda clínica         | Especialização da agenda do Core (slots, salas, profissional)                                                |
| Confirmação e no-show  | Automações do Core + estados próprios do vertical                                                            |
| Retorno e reativação   | Capacidades de IA do Core parametrizadas pelo vertical                                                       |

Regras da extensão (detalhadas em `docs/ARCHITECTURE.md`):

1. Vertical importa serviços do Core; o Core **nunca** importa o vertical.
2. Extension tables 1:1 com FK composta (`workspaceId, contactId`) garantem isolamento e integridade.
3. Custom fields do Core cobrem atributos simples; extension tables cobrem estrutura.
4. O vertical se registra por composição no bootstrap da aplicação — o Core não tem registro de plugins "consciente" de domínios.

## 6. IA como produto, não como feature

A IA aparece para o usuário como **sinais, insights e próximas ações** embutidos no fluxo de trabalho — não como um chat genérico. Capacidades iniciais (contratos em `docs/AI_ARCHITECTURE.md`):

1. Resumo de conversa
2. Extração de intenção
3. Sugestão de resposta
4. Próxima ação recomendada
5. Lead scoring explicável
6. Detecção de oportunidade parada
7. Limpeza de dados (duplicatas, campos inconsistentes)
8. Previsão de pipeline

No MVP, toda ação externa proposta pela IA exige aprovação humana.

## 7. Usuários e fases

- **Fase atual (fundação):** nenhum usuário; documentação e arquitetura.
- **MVP:** workspaces provisionados de forma controlada (sem registro público) para operações de vendas/atendimento pequenas e médias; convites para membros.
- **Depois:** onboarding self-service — somente após billing, quotas, rate limit e política antiabuso (decisão registrada em ADR).

## 8. Requisitos não-funcionais inegociáveis

- Isolamento de tenant fail-closed provado por teste (P0).
- Auditoria de mutações relevantes com minimização de dados.
- LGPD: minimização, exportação e exclusão planejadas desde o modelo.
- Aparência internacional, premium e deliberada (`docs/DESIGN_DIRECTION.md`).
- Custo de IA rastreado por workspace desde o primeiro run.

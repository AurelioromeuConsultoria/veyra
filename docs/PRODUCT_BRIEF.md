# PRODUCT_BRIEF — Veyra

## 1. Problema

Empresas de serviços que vendem por relacionamento (clínicas, imobiliárias, consultorias, agências) usam CRMs genéricos que não falam a língua do seu negócio, ou sistemas verticais fracos em CRM (sem pipeline real, sem automação, sem IA útil). O resultado é o mesmo: leads esquecidos, follow-up manual, dado espalhado e nenhuma inteligência acionável.

## 2. Posicionamento

O Veyra ataca isso com uma arquitetura de dois níveis:

- **Veyra Core** — um CRM SaaS multi-tenant com as capacidades universais de relacionamento comercial, IA nativa e qualidade de engenharia de produto internacional.
- **Verticais** — produtos completos construídos **sobre** o Core (o primeiro: **Veyra Clinics**, para **clínicas de estética no Brasil**, piloto decidido no ADR-036 e com escopo proposto no ADR-048), que adicionam o vocabulário e os fluxos do nicho sem reimplementar CRM.

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

> **Estado (2026-10-19):** o escopo abaixo está nos ADR-047 (contrato de extensão) e ADR-048 (domínio e classificação de dados), **aceitos** na aprovação documental da F0. Essa aprovação cobre o desenho, não código nem migrations. Sem a validação das hipóteses, a avaliação jurídica e os bloqueios B1–B4 resolvidos, não há dado real de paciente nem piloto clínico. Nenhuma validação com a operação de uma clínica foi feita: fluxo, métricas e necessidades são **hipóteses não validadas** (ADR-048, H1–H7). A revisão do product owner **não conta** como validação operacional.

Primeiro público: **clínicas de estética no Brasil, começando com uma unidade**, sem impedir várias no futuro.

| Conceito do Clinics      | Mecanismo de extensão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Paciente                 | Extension table 1:1 sobre `Contact` (`ClinicsPatient`, FK composta `(workspaceId, contactId)`), só com campos operacionais mínimos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Profissional             | Entidade própria do vertical (`ClinicsProfessional`), **sem exigir login**. Associação **opcional** a uma `Membership` por FK composta. Não estende `User`, que é global (ADR-003)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Unidade                  | Entidade própria. Nasce com uma; o modelo já admite várias                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Serviço/procedimento     | Entidade própria com duração e preço em centavos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Agenda                   | **Modelo próprio** (`ClinicsAppointment`), dono do horário, com sobreposição impedida pelo banco. **Não depende de `CalendarEvent`**; a interface pode reaproveitar componentes da agenda do Core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Atendimento              | **Modelo próprio** (`ClinicsAttendance`), separado da agenda e sob permissão própria: quem agenda não vê, por isso, o que aconteceu no atendimento                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pacote de sessões        | Entidade própria com consumo de sessão por atendimento concluído (hipótese H2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Retorno e follow-up      | `Task` do Core, criada pelo vertical com título **neutro** (sem nome de procedimento)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Sala                     | **Em aberto** até a revisão do fluxo (H5, D2). Equipamentos ficam fora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Ativação                 | Por workspace, só por CLI administrativa, idempotente e reversível; desativar revoga as permissões e **não apaga dados** (ADR-047 §4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Papéis                   | Owner e Admin recebem acesso completo ao vertical; Member faz o papel de **recepção** (agenda, sem atendimento); papel de sistema **`Profissional`** criado na ativação (consulta a agenda e registra atendimento, sem marcar horários e sem CRM; dar escrita de agenda sem limitá-la aos próprios horários permitiria alterar a clínica inteira, então isso só é reaberto se a operação validar a necessidade). O `Profissional` vê **todos** os atendimentos e pacotes da clínica, não só os próprios: o Core não tem restrição por profissional (D8). O papel não é editável, porque o produto ainda não permite editar papéis. Um papel por membro e a falta de gestão de equipe no web seguem como dependências do piloto (ADR-048 §5) |
| Funil comercial          | Pipelines e deals do Core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Confirmação e reativação | Envio do Core pelo WhatsApp, com aprovação humana. É a única parte que depende da validação contra a WABA real                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

**Fora do MVP do Clinics:** prontuário, prescrição, pagamento online, módulos de financeiro e administração, equipamentos, **fotos e texto clínico livre**. Se fotos ou texto clínico se mostrarem essenciais, voltam como decisão futura com as condições de acesso, proteção e retenção do ADR-048 §7. O preço de serviços e pacotes fica preservado como **possibilidade** do modelo, sem virar módulo financeiro; marcar "pago/em aberto" continua **em aberto** até a revisão do fluxo (ADR-048, D1).

**Dado sensível.** O ADR-048 §6 classifica os dados do vertical em três classes:

- **C — configuração:** não identifica pessoa (unidade, serviço, preço).
- **P — pessoal:** identifica uma pessoa, mas não a liga a saúde (profissional; o próprio contato).
- **S — sensível:** liga uma pessoa a procedimento, atendimento ou continuidade de tratamento. É dado de saúde (LGPD art. 11) mesmo sem prontuário.

Para a classe S existe uma **fronteira técnica**, e não só orientação:

- **Quem é restrito.** Num workspace com o Clinics, **todo contato é restrito por padrão**: leads, contatos que já existiam na ativação e os que vierem depois. A restrição é derivada a cada checagem da **presença** do vertical no workspace, sem marca por contato, e falha fechada. **Desativar o Clinics não a levanta**: enquanto houver o vertical ou dados dele no workspace, a restrição continua, e as liberações de IA ficam suspensas até a reativação. Os controles são **separados por consumidor**, e uma liberação para IA não libera webhooks.
- **IA.** Um contato só volta a usar IA por **liberação explícita, autorizada e auditada** como "sem relação com o Clinics", que perde efeito se o contato virar paciente. A restrição é conferida em toda a superfície de IA:
  - antes de qualquer conteúdo ir ao provedor;
  - ao ler resultados e propostas já guardados;
  - ao aprovar uma proposta;
  - ao despachar mensagem escrita pela IA.

  Na prática, a IA fica indisponível para as conversas da clínica no MVP.

- **Webhooks.** No MVP, **nenhum evento ligado a contato** de um workspace com o Clinics é entregue, inclusive para integrações já existentes, e não há liberação para isso. Uma exceção futura exige autorização própria. Workspaces sem o Clinics não são afetados.
- **Modelos e permissões próprios**, e o vertical nunca grava conteúdo S em entidade do Core.

O que a fronteira não garante, texto clínico digitado por pessoas em notas e conversas do Core, está registrado como **bloqueio para dados reais**, e não como risco aceito.

**Exclusão.** Por enquanto, excluir um contato com perfil de paciente é **recusado** (409). A política definitiva de exclusão e retenção **depende de avaliação jurídica** (ADR-048 §9) e não será implementada antes dela. Até que os bloqueios B1–B4 do ADR-048 §10 sejam levantados, nenhum dado real de paciente entra em ambiente algum.

Regras da extensão (detalhadas em `docs/ARCHITECTURE.md`; pontos de composição propostos no ADR-047):

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

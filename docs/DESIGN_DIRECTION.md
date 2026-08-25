# DESIGN_DIRECTION — Veyra

O Veyra deve parecer um produto internacional, premium e deliberado. Cada escolha visual existe por uma razão que este documento registra. O Norteie é referência de **método** (tokens, disciplina de acento, tipografia com papéis) — nunca de identidade: paleta, voz e assinaturas visuais do Veyra são novas.

## 1. Direção

**"Mineral"** — a metáfora é pedra polida e tinta: superfícies claras e minerais (off-whites quentes, cinzas de calcário), texto em grafite profundo, um único acento disciplinado. Um instrumento de trabalho sério e calmo, denso quando precisa ser, nunca barulhento.

- **Modo claro mineral é o padrão.** CRM se usa 8 horas por dia sob luz de escritório; claro-padrão comunica ferramenta profissional (Linear, Stripe Dashboard aos poucos entenderam isso ao contrário — nós começamos certo para o nosso público).
- **Dark mode sofisticado** como opção: não é inversão automática — é uma paleta noturna própria (grafites azulados profundos, o mesmo acento recalibrado), definida junto com a clara nos mesmos tokens.
- **Duas densidades deliberadas:**
  - **Visão executiva** — dashboards e visões de resumo: respiro, hierarquia tipográfica forte, poucos números grandes, insights de IA em destaque.
  - **Modo operacional denso** — tabelas, pipeline, inbox, timeline: alta densidade de informação, linhas compactas, colunas configuráveis, teclado em primeira classe. Densidade é feature, não falha estética.

## 2. Anti-padrões (o que o Veyra nunca parece)

| Anti-padrão                                                              | Por que é proibido                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Vibe coding (gradientes roxos, glow, emoji em heading)                   | Genérico, data o produto em 6 meses                     |
| Glassmorphism exagerado / blur decorativo                                | Custo de legibilidade sem função                        |
| Dashboard genérico (cards iguais, 4 KPIs aleatórios, donut sem pergunta) | Todo gráfico responde uma pergunta ou sai               |
| Conjunto de componentes prontos sem hierarquia                           | shadcn é primitivo, não identidade                      |
| Dark-admin preto + verde ácido                                           | Identidade do template, não do produto                  |
| IA como chat flutuante desconectado                                      | IA aparece como sinais/insights/próximas ações no fluxo |
| Skeleton screens infinitos e spinners gigantes                           | Perceived performance é design                          |

## 3. Tipografia — três papéis (fixados)

Fontes instaladas por npm (`@fontsource*`), servidas pelo próprio bundle: offline, reprodutível e sem CDN de terceiros. Tokens: `--font-display`, `--font-sans`, `--font-mono`.

| Papel          | Fonte                                                                   | Uso                                                                                                        |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Display**    | **Familjen Grotesk Variable** (`@fontsource-variable/familjen-grotesk`) | Títulos de página, números-herói, wordmark. Peso 620–650, tracking −0,018 a −0,022em                       |
| **UI / corpo** | **Instrument Sans Variable** (`@fontsource-variable/instrument-sans`)   | Todo o resto. Deliberadamente **não é Inter** — Inter é o default de todo dashboard gerado por IA          |
| **Dados**      | **IBM Plex Mono** (`@fontsource/ibm-plex-mono`, estático 400/500/600)   | Dinheiro, datas, IDs, eyebrows/labels em caixa alta e qualquer coluna numérica — sempre com `tabular-nums` |

> Nota: não existe pacote variável publicado de IBM Plex Mono; usa-se a versão estática (subsets latin/latin-ext nos pesos 400/500/600), como o próprio §3 previa.

**Escala fixa** (tokens `--text-*`; um componente escolhe um degrau, nunca inventa um tamanho):

| Degrau                         | Tamanho    | Papel                                     |
| ------------------------------ | ---------- | ----------------------------------------- |
| `display-lg`                   | 28px       | Número-herói, marca em tela cheia         |
| `display-md`                   | 22px       | Título de página                          |
| `display-sm`                   | 18px       | Título de painel, cabeçalho de conversa   |
| `body`                         | 14px       | Corpo padrão                              |
| `body-sm`                      | 13px       | Corpo denso (tabela, thread, card)        |
| `data` / `data-sm` / `data-xs` | 12/11/10px | Dado em mono: valores, carimbos, eyebrows |

Regra: os três papéis não se substituem. Número de dinheiro nunca em display; título nunca em mono; eyebrow é dado (mono, caixa alta, `letter-spacing` 0,12em), não título.

## 4. Cor — paleta fechada e disciplina

Implementação: tokens CSS-first (Tailwind v4 `@theme`), claro em `:root`, dark por classe `.dark` (`apps/web/src/index.css`). A paleta abaixo é a **definitiva** — mudança de direção exige ADR.

| Token             | Claro     | Escuro    | Papel                                                                                          |
| ----------------- | --------- | --------- | ---------------------------------------------------------------------------------------------- |
| `--background`    | `#f6f3ed` | `#0d1219` | Calcário quente / grafite azulado profundo — nunca branco puro, nunca preto                    |
| `--surface`       | `#fdfcfa` | `#1b2532` | Cartão, painel, balão recebido                                                                 |
| `--surface-2`     | `#ede8de` | `#26323f` | Hover, campo, trilho, chip                                                                     |
| `--border`        | `#e1dbcf` | `#33404f` | Hairline padrão                                                                                |
| `--border-strong` | `#cfc7b6` | `#4a5867` | Divisor deliberado, trilho de scroll, marcador de vazio                                        |
| `--foreground`    | `#1d2321` | `#e6ebf1` | Grafite de texto (14,4:1 no claro; 15,7:1 no escuro)                                           |
| `--muted-fg`      | `#4f564f` | `#a8b3c1` | Secundário — 6,9:1 no claro e 8,8:1 no escuro (7,3:1 sobre `--surface`: AAA no denso)          |
| `--accent`        | `#1c5a56` | `#5fb6ac` | **Verde-abissal: a única cor de marca.** Ação primária, foco, marcador ativo, wordmark         |
| `--accent-hover`  | `#174b48` | `#72c3ba` | Estado hover da ação primária                                                                  |
| `--accent-active` | `#123c3a` | `#4e9d94` | Estado pressionado                                                                             |
| `--accent-fg`     | `#f6faf8` | `#08100f` | Texto sobre o acento (7,5:1 e 8,0:1)                                                           |
| `--positive`      | `#2c6a45` | `#68c48d` | Ganho, dinheiro confirmado                                                                     |
| `--negative`      | `#9c2b24` | `#f0847c` | Perda, falha, janela em risco (< 2h)                                                           |
| `--warning`       | `#845310` | `#dcac57` | Atenção: janela 2–6h, teto de plano, entrega não confirmada                                    |
| `--info`          | `#1d5a85` | `#86bee4` | Informação neutra                                                                              |
| `--ai`            | `#8f4a22` | `#e59a69` | **Cobre queimado** — proveniência de IA. Quente, distinto do acento, lê como anotação à margem |

Regras: acento nunca em fundo de área grande; semânticos nunca para "dar cor"; contraste AA mínimo em texto normal, AAA (≈7:1) em texto denso do modo operacional. Tint de superfície sempre por opacidade do próprio token (8–12%), nunca por um hex novo.

**Separação de plano no escuro (medida, não estimada).** A primeira paleta noturna era cinza quase acromática e colocava `--surface` a 1,07:1 de `--background`: no inbox escuro, o painel da lista e a área da thread liam como a mesma superfície. Os neutros noturnos agora carregam azul (matiz ≈ 215) e a escada é explícita — `--surface` 1,21:1 e `--surface-2` 1,44:1 sobre o fundo, `--border` a 1,78:1. Hierarquia por contraste de superfície + hairline; sombra continua reservada a camada flutuante. Texto normal ≥ 4,5:1 e denso ≈ 7:1 sobre o plano em que de fato aparece — medir de novo a cada mexida na paleta.

**Por que cobre em `--ai`, e não violeta:** violeta é o clichê de "IA" em todo produto do mercado — datar o Veyra em seis meses seria de graça. O cobre é quente, distingue-se do verde da marca à primeira vista e tem a semântica certa: anotação à margem de um texto que continua sendo do usuário.

## 5. Superfícies e forma

- Raio contido (8–12px em cards, 6–8px em controles) — nada de pill generalizado.
- Profundidade por contraste de superfície e hairlines, não por sombras pesadas; sombra só em camadas flutuantes (popover, dialog, drag).
- Movimento: 150–200ms ease-out, entrada com stagger sutil; `prefers-reduced-motion` desliga tudo; nenhuma animação em loop exceto indicadores de processamento.
- Foco visível global (`:focus-visible` com anel no acento) — teclado é cidadão de primeira classe no modo operacional.

**Contêiner nunca fica oco.** Uma coluna de kanban com um card não se estica até o rodapé da viewport: altura pelo conteúdo com piso utilizável (~200px), e a zona de soltura cresce **enquanto o arrasto dura** (`Pipeline.tsx`). Densidade é feature; vazio estrutural não é.

**Corte de conteúdo sempre se anuncia.** Quando uma faixa rola na horizontal (board de pipeline), a borda recebe esmaecimento para o fundo **apenas quando há conteúdo além** — mais um controle de rolagem rotulado (`Ver próximas etapas`), que também é o caminho de teclado para as etapas terminais. Barra decorativa permanente, nunca.

**Vazio ancorado recebe marco, não invenção.** A thread do inbox continua ancorada embaixo (convenção de conversa); o topo do bloco carrega um marco **verdadeiro** — a data em que a conversa foi criada quando toda a história está em tela, ou o aviso de que só a página mais recente está carregada. Nunca um placeholder que finja um dado que o servidor não deu.

## 6. IA na interface

A IA aparece em três formas, sempre marcadas com o token `--ai` e rotuladas com a proveniência:

1. **Sinais** — chips/badges em linhas de tabela e cards de deal ("parado há 12 dias", "alta intenção de compra").
2. **Insights** — cards curtos na visão executiva, com o "porquê" explicável (fatores do score, evidência do resumo) a um clique.
3. **Próximas ações** — sugestões acionáveis no contexto (rascunho de resposta no inbox, próxima tarefa no deal), sempre com aprovar/editar/descartar — nunca ação executada sem gesto humano no MVP.

Nunca: chat genérico flutuante, "✨ pergunte à IA" onipresente, resultados sem explicação.

### 6.1 Assinaturas visuais (implementadas)

Duas formas são exclusivas do Veyra e reaparecem sempre iguais:

1. **Medidor de janela** (`components/ui/window-meter.tsx`) — a janela de 24h do canal externo é a coisa mais característica do produto. Vira uma hairline de 2px que se esvazia sob o cabeçalho da conversa, com o tempo exato em mono, e um chip compacto na linha da lista. Urgência por cor: **> 6h** neutro, **2–6h** `--warning`, **< 2h** `--negative`, **fechada** estado explícito ("fechada · só template"). O instante vem do servidor (`SendPolicyDto.windowExpiresAt`); o cliente só lê o relógio — política de envio nunca é recalculada na tela (ADR-038).
2. **Marca de proveniência da IA** (`components/ui/ai.tsx`, utilitário `.ai-mark`) — tudo que o modelo escreveu recebe um filete de 2px em cobre à esquerda e um selo "IA" em mono caixa-alta: painel de rascunho no inbox, selo de autoria na thread, card de resumo e fila de propostas em Sinais.

## 7. Voz do produto

pt-BR direta e profissional. Botões dizem o que fazem ("Criar oportunidade", "Enviar proposta"). Vazios orientam a próxima ação ("Nenhum contato ainda — importe uma lista ou crie o primeiro"). Erros dizem o que aconteceu e o que fazer, sem culpa e sem humor forçado. Terminologia consistente com o glossário do domínio (deal = "oportunidade" na UI).

## 8. Processo

- Todo componente novo nasce dos primitivos acessíveis (Radix/shadcn à la carte — só os necessários) + tokens; nunca de cópia de template.
- Telas de referência (pipeline, inbox, tabela de contatos, dashboard executivo) recebem mock antes de código na Fase de UI.
- Este documento evolui por ADR quando a direção mudar. A paleta final e as fontes escolhidas estão registradas em §3 e §4 com os valores exatos; a implementação vive em `apps/web/src/index.css` (tokens) e `apps/web/src/components/ui/` (primitivos).

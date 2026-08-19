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

## 3. Tipografia — três papéis (fontes a validar na Fase 2 de UI)

| Papel          | Uso                                             | Direção de escolha                                                                                                                                                                     |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Display**    | Títulos de página, números-herói de dashboards  | Grotesca contemporânea com personalidade discreta (candidatas: Söhne-like open source — ex. Inter Display ajustada, General Sans, Switzer) — peso 600–700, tracking levemente negativo |
| **UI / corpo** | Todo o resto                                    | Sans humanista neutra e altamente legível em 13–14px (candidatas: Inter, Instrument Sans — **não** repetir o par do Norteie por identidade)                                            |
| **Dados**      | Valores monetários, datas, IDs, eyebrows/labels | Mono com `tabular-nums` obrigatório em qualquer coluna numérica (candidatas: IBM Plex Mono, Commit Mono)                                                                               |

Regra: os três papéis não se substituem. Número de dinheiro nunca em display; título nunca em mono.

## 4. Cor — tokens e disciplina

Implementação: tokens CSS-first (Tailwind v4 `@theme`), claro como `:root`, dark via classe. Paleta exata definida na Fase de UI; a estrutura e a disciplina definem-se agora:

| Token                                                | Papel                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--background`                                       | Fundo mineral (off-white quente no claro; grafite azulado profundo no dark)                                                                                                                                                   |
| `--surface` / `--surface-2`                          | Cards/painéis e hover/campos                                                                                                                                                                                                  |
| `--border`                                           | Hairlines de baixo contraste                                                                                                                                                                                                  |
| `--foreground` / `--muted-fg`                        | Grafite de texto e secundário                                                                                                                                                                                                 |
| `--accent` / `--accent-fg`                           | **A única cor de marca** — gasta com parcimônia: ação primária, foco, marcador ativo, assinatura da marca. Direção: um tom mineral profundo (verde-abissal, azul-ardósia ou cobre queimado — decidir com testes de contraste) |
| `--positive` / `--negative` / `--warning` / `--info` | Semânticos: dinheiro/ganho, perda/atraso, atenção, informação — nunca decorativos                                                                                                                                             |
| `--ai`                                               | Sinal de inteligência: um matiz próprio e sutil que marca insights/sugestões de IA (borda/ícone), para o usuário reconhecer proveniência sem estridência                                                                      |

Regras: acento nunca em fundo de área grande; semânticos nunca para "dar cor"; contraste AA mínimo em texto normal, AAA em texto denso do modo operacional.

## 5. Superfícies e forma

- Raio contido (8–12px em cards, 6–8px em controles) — nada de pill generalizado.
- Profundidade por contraste de superfície e hairlines, não por sombras pesadas; sombra só em camadas flutuantes (popover, dialog, drag).
- Movimento: 150–200ms ease-out, entrada com stagger sutil; `prefers-reduced-motion` desliga tudo; nenhuma animação em loop exceto indicadores de processamento.
- Foco visível global (`:focus-visible` com anel no acento) — teclado é cidadão de primeira classe no modo operacional.

## 6. IA na interface

A IA aparece em três formas, sempre marcadas com o token `--ai` e rotuladas com a proveniência:

1. **Sinais** — chips/badges em linhas de tabela e cards de deal ("parado há 12 dias", "alta intenção de compra").
2. **Insights** — cards curtos na visão executiva, com o "porquê" explicável (fatores do score, evidência do resumo) a um clique.
3. **Próximas ações** — sugestões acionáveis no contexto (rascunho de resposta no inbox, próxima tarefa no deal), sempre com aprovar/editar/descartar — nunca ação executada sem gesto humano no MVP.

Nunca: chat genérico flutuante, "✨ pergunte à IA" onipresente, resultados sem explicação.

## 7. Voz do produto

pt-BR direta e profissional. Botões dizem o que fazem ("Criar oportunidade", "Enviar proposta"). Vazios orientam a próxima ação ("Nenhum contato ainda — importe uma lista ou crie o primeiro"). Erros dizem o que aconteceu e o que fazer, sem culpa e sem humor forçado. Terminologia consistente com o glossário do domínio (deal = "oportunidade" na UI).

## 8. Processo

- Todo componente novo nasce dos primitivos acessíveis (Radix/shadcn à la carte — só os necessários) + tokens; nunca de cópia de template.
- Telas de referência (pipeline, inbox, tabela de contatos, dashboard executivo) recebem mock antes de código na Fase de UI.
- Este documento evolui por ADR quando a direção mudar; a paleta final e as fontes escolhidas serão registradas aqui com os valores exatos.

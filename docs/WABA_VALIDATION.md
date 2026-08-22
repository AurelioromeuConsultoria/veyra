# Validação contra WABA real — Entrega 9.1

A 9.1 inteira foi construída contra um transporte falso. O código está coberto por
333 testes, e isso prova **coerência interna**, não que a Meta aceita o que
mandamos. Este roteiro existe para trocar suposição por evidência antes de
qualquer piloto de clínica (ADR-039).

Quem executa precisa de credencial real, então isto não é automatizável aqui.
Cada item diz **o que capturar** — sem a evidência, o item não está validado.

## 0. O que já foi resolvido sem WABA

- **Formato do destinatário.** Guardamos `+E.164` na conversa (correto para
  exibir e comparar) e o transporte agora envia **só dígitos**, que é exatamente
  o `wa_id` que a Meta emitiu na ingestão. Devolver ao provedor o identificador
  que ele mesmo gerou elimina a dúvida; havia teste unitário antes disso ser
  decidido, e ele foi ajustado junto.

## 1. Preparação

Variáveis no ambiente da API (nunca em DTO, log ou commit — SECURITY.md §8):

| Variável             | Onde obtém                  | Para quê                                       |
| -------------------- | --------------------------- | ---------------------------------------------- |
| `META_APP_SECRET`    | App da Meta → Configurações | HMAC do webhook, conferido sobre o corpo BRUTO |
| `META_VERIFY_TOKEN`  | você escolhe                | desafio `GET` de assinatura do webhook         |
| `META_GRAPH_VERSION` | opcional (default `v21.0`)  | fixar a versão da Graph API                    |

Cadastro do canal (ato administrativo, sem endpoint — ADR-037):

```
pnpm --filter @veyra/api channel:whatsapp \
  --slug <workspace> --phone-number-id <id> --waba <id>
```

**O token nunca vai na linha de comando.** `argv` é legível por outros usuários da
máquina em `ps` e fica no histórico do shell — não imprimir depois não desfaz
isso. Por padrão o script **pergunta sem eco**; `--token` é recusado com um aviso
para rotacionar o que acabou de ser exposto. Para automação existe `--token-stdin`:

```
# o `printf` evita o newline; prefira ler de um gerenciador de segredos
printf '%s' "$TOKEN" | pnpm --filter @veyra/api channel:whatsapp \
  --slug <workspace> --phone-number-id <id> --waba <id> --token-stdin
```

Mesmo assim, `TOKEN` numa variável de ambiente do shell pode acabar no histórico
dependendo de como foi atribuída — no uso manual, deixe o script perguntar.

O token vai **cifrado** (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) e nunca é impresso.
Reexecutar com o mesmo `--phone-number-id` **rotaciona** o token; se o número já
pertencer a outro workspace, o script **para** — reatribuir entregaria as
mensagens daquele número ao tenant errado. Os três caminhos foram verificados
contra banco real.

O webhook precisa ser alcançável pela Meta (túnel HTTPS em desenvolvimento). URL:
`POST /api/channels/whatsapp/webhook`; a mesma rota responde ao `GET` de
verificação.

## 2. Itens a validar, com a evidência de cada um

| #   | O que                       | Como saber que passou                                                                         | Se falhar                                                                                      |
| --- | --------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | **Assinatura do webhook**   | mensagem recebida aparece na conversa; alterar um byte do corpo passa a devolver 401          | conferir se algum proxy do túnel reescreve o corpo — a assinatura é sobre o corpo bruto        |
| 2   | **Roteamento por número**   | mensagem cai no workspace do `phone_number_id`, e não em outro                                | `ChannelCredential.phoneNumberId` é unique global; conferir cadastro                           |
| 3   | **Janela de 24h**           | `GET /api/conversations/:id/send-policy` responde `free_form` logo após a mensagem do contato | comparar `lastInboundAt` com o `timestamp` do provedor (é limitado ao presente)                |
| 4   | **Envio livre**             | texto chega no aparelho; `MessageDispatch` fica `sent` com `externalId` (wamid)               | ver `errorCode`; a classificação está isolada em `meta-errors.ts`, corrigir lá                 |
| 5   | **Recibos**                 | `MessageStatusEvent` recebe `sent`/`delivered`/`read` na ordem do provedor, sem duplicar      | conferir fuso: o timestamp é do provedor, não `now()`                                          |
| 6   | **Template fora da janela** | com opt-in registrado, template aprovado é aceito e chega                                     | **formato de template é a maior incógnita**: nome, `language`, e ordem dos parâmetros de corpo |
| 7   | **Recusa sem opt-in**       | fora da janela e sem consentimento, a política bloqueia e o envio devolve 400                 | —                                                                                              |
| 8   | **Mídia recebida**          | imagem vira `FileObject` `pending` anexado à mensagem, coletado pelo job                      | conferir host da CDN: a allowlist aceita `graph.facebook.com` e `*.fbsbx.com`                  |
| 9   | **Erro ambíguo**            | forçar timeout (rede) deixa `unknown_after_dispatch` **sem reenviar**                         | é o comportamento desejado: duplicar é pior que pendente                                       |
| 10  | **Quota**                   | com `messages_sent` no teto, a política diz "cota esgotada" e o envio devolve 402             | —                                                                                              |

## 3. Obstáculo conhecido no caminho

`pnpm --filter @veyra/api provision` (criar workspace) **trava no boot** —
defeito pré-existente, registrado em `docs/MEMORY/technical-debt.md`. Se o
ambiente ainda não tem workspace, isso bloqueia o passo 1. As CLIs de plano e de
canal foram corrigidas (faltava o adaptador do Prisma 7 e, no plano, o `dotenv`);
o provisionamento carrega o `AppModule` inteiro e é outro problema.

## 4. Regra durante a validação

Uma mensagem entregue em duplicidade para um número real é dano que não se
desfaz. Use **um número de teste seu** para os itens 4, 6 e 9 — nunca um número
de paciente. O item 9 é justamente o que provoca incerteza de propósito.

## 5. Depois

Registrar o resultado de cada item aqui mesmo, com data. Item que falhar vira
correção **antes** da 9.2: construir scanner e retenção sobre uma integração não
comprovada empilha camada sobre suposição.

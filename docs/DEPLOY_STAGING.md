# DEPLOY_STAGING — Veyra em `veyra-staging.malachdigital.com.br`

Staging é ambiente de **dado fictício**. Nunca receba conversa, arquivo ou
contato de paciente real aqui: o transporte do WhatsApp é falso, o consentimento
de IA é decisão de teste e a retenção não foi dimensionada para dado clínico.

## 1. O ambiente, medido

Diagnóstico de 25/08/2026 (`deploy/staging/diagnose.sh`):

|               |                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------- |
| Host          | Ubuntu 24.04.3, x86_64, 96 GB de disco (66 livres), no ar há 208 dias                    |
| Memória       | **7,8 GB total, ~4,0 GB disponíveis, 1,4 GB de swap já em uso**                          |
| Orquestração  | Coolify 4.3.11, ~40 containers                                                           |
| Proxy         | **Traefik v3.6** (`coolify-proxy`), dono de 80/443/8080 — não há nginx no host           |
| Rede do proxy | `coolify` · entrypoints `http`/`https` · certresolver `letsencrypt`                      |
| Faixas em uso | 10.0.0.0/24 a 10.0.6.0/24                                                                |
| Vizinhos      | VerboPlus (produção e staging), Evolution API, MinIO, GlitchTip, cloudflared, 6 Postgres |

## 2. Convivência com o que já roda na VPS

- **Um proxy só.** O Veyra NÃO sobe proxy e **não publica porta nenhuma** —
  nem em loopback. O Traefik alcança o container de entrada pela rede
  `coolify`, e o roteamento é por LABELS (é assim que o Traefik se configura;
  não há arquivo de site).
- **Projeto, rede e volumes próprios**, todos prefixados `veyra-staging`.
  Nenhum recurso compartilhado com outro projeto.
- **Nenhuma porta de banco publicada.** O Postgres do Veyra existe só dentro da
  rede do projeto. (O VerboPlus tem Postgres com porta pública nesta VPS; não
  repetimos o padrão.)
- **Faixa de IP fixada** (`172.28.7.0/24`), fora da sequência 10.0.x que o
  Coolify usa.
- **ClamAV fica DESLIGADO por padrão** (perfil `scanner`). Com ~4 GB
  disponíveis e swap já em uso, ligar um serviço que pede 1,5–2 GB residentes
  arriscaria empurrar o VerboPlus de produção para swap. Sem scanner, arquivo
  fica `pending` e não sai para canal externo — a degradação segura do ADR-043,
  que em staging com dado fictício não custa nada.
- **Nada de `docker system prune`.** Ele apaga volume e imagem dos vizinhos.
  Para limpar o Veyra, use os comandos com `-p veyra-staging`.

## 2.1 Diagnóstico (rode ANTES de tudo, e sempre que a VPS mudar de forma)

```bash
scp deploy/staging/diagnose.sh usuario@77.37.43.5:/tmp/
ssh usuario@77.37.43.5 'bash /tmp/diagnose.sh' > diagnostico.txt
```

Somente leitura. Rode de novo sempre que a VPS mudar de forma. As respostas
que decidem a configuração:

| Pergunta                           | Onde aparece              | O que muda                                                                                                                                 |
| ---------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| O proxy é do host ou container?    | seção `PROXY REVERSO`     | host → trecho em `deploy/staging/proxy/`; container → override `docker-compose.proxy-network.yml` + `PROXY_NETWORK`                        |
| Qual porta de loopback está livre? | seção `PORTAS 8080-8099`  | `WEB_BIND_PORT` no `.env`                                                                                                                  |
| Que faixas de IP as redes já usam? | seção `REDES`             | se `172.x` colidir, fixe outra faixa em `networks.veyra.ipam`                                                                              |
| Qual a arquitetura do host?        | seção `HOST` (`uname -m`) | `clamav/clamav:1.4` **não publica imagem arm64**: em host ARM o scanner precisa de outra imagem, e sem scanner todo arquivo fica `pending` |

## 3. Provisionamento inicial (uma vez), pelo Coolify

O Veyra entra como **recurso do Coolify**, no mesmo caminho do resto da casa
(decisão da operação, ADR-046). O painel passa a ser dono de três coisas que,
em compose puro, seriam nossas: o nome do projeto, o roteamento no Traefik e
**as variáveis de ambiente**.

### 3.1 Criar o recurso

No painel (`https://coolify.verboplus.com.br`):

1. **Novo projeto** → nome `veyra`, ambiente `staging`.
2. **Nova resource** → tipo **Docker Compose** a partir do repositório
   `AurelioromeuConsultoria/veyra`, branch `main`.
3. **Base directory** `/` e **Docker Compose Location**
   `deploy/staging/docker-compose.yml`.

### 3.2 Domínio

No serviço **`web`**, defina a variável que o Coolify lê para gerar as labels
do Traefik e pedir o certificado:

```
SERVICE_FQDN_WEB_8080=https://veyra-staging.malachdigital.com.br
```

Não acrescente labels de Traefik à mão: duas regras para o mesmo host fazem o
roteamento depender da ordem de leitura do proxy.

### 3.3 Variáveis e segredos

Todas no painel, no recurso (não no serviço), marcando como **build-time = não**.
A lista completa e comentada está em `deploy/staging/.env.example`; o mínimo:

| Variável                                              | Observação                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `VEYRA_HOST`                                          | `veyra-staging.malachdigital.com.br`                                                                             |
| `VEYRA_ENV`                                           | `staging` — **é o que autoriza o transporte falso**                                                              |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | senha gerada, nunca reaproveitada                                                                                |
| `JWT_SECRET`                                          | ≥32 caracteres, `openssl rand -base64 48`                                                                        |
| `TOKEN_ENCRYPTION_KEY`                                | **independente** do JWT                                                                                          |
| `ADDRESS_LOCK_KEY`                                    | **independente** e ESTÁVEL; rotação só em manutenção (`docs/SECURITY.md` §8)                                     |
| `OUTBOUND_APPROVAL_KEY`                               | **independente**, a mesma em todos os processos; trocar invalida as aprovações pendentes (`docs/SECURITY.md` §8) |
| `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN`       | valores de TESTE, nunca os do app real                                                                           |
| `META_TRANSPORT_MODE`                                 | `fake` — nada sai para a Meta (ADR-046)                                                                          |
| `MAINTENANCE_MODE`                                    | **obrigatória**, `true` ou `false`: `true` só na janela de manutenção (ADR-053, §14)                             |
| `ANTHROPIC_API_KEY`                                   | com chave, a IA funciona e o custo é real                                                                        |
| `CLAMAV_HOST`                                         | **vazio** (scanner desligado, ver §2)                                                                            |
| `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` / `AWS_*`     | backup; pode ficar vazio até você decidir o destino                                                              |

> **Mudança de regra, e ela é sua para aceitar.** O pedido original dizia
> "segredos exclusivamente em arquivo fora do repositório, por exemplo
> `/opt/veyra-staging/.env`". Com o Coolify, eles passam a viver **no banco de
> dados do Coolify** — que fica na mesma VPS e é acessível a quem entra no
> painel. Continua fora do repositório e fora de log, mas a superfície mudou:
> quem tem o painel tem os segredos. Se preferir manter o arquivo, veja §11.2.

### 3.4 Primeiro deploy

Botão **Deploy**. O Coolify clona, constrói as três imagens e sobe. Acompanhe
o log do deploy — a primeira construção leva alguns minutos.

### 3.5 Schema, catálogo e workspace

Pelo **terminal do Coolify** no container `api` (ou por `docker exec` no host):

```bash
npx prisma migrate deploy                 # schema
node dist/cli/seed-permissions.js         # catálogo de permissões
node dist/cli/provision.js \
  --name "Veyra Staging" --slug staging --owner-email voce@exemplo.com
```

O token do convite aparece **uma única vez** — copie na hora.

### 3.6 Anote os nomes reais

O Coolify prefixa volumes e rede com o id do recurso. Antes de precisar
restaurar, guarde os nomes:

```bash
docker volume ls | grep -i veyra
docker ps --format '{{.Names}}' | grep -i veyra
```

## 4. Deploy de atualização

1. **Backup antes**, se a atualização trouxer migration (§5).
2. No painel, aponte o recurso para a tag/commit desejado — nunca deixe em
   `main` flutuante: deploy que muda sozinho quando alguém empurra código não
   é deploy, é surpresa.
3. **Deploy**.
4. Assim que o container `api` subir, rode a migration pelo terminal:

```bash
npx prisma migrate deploy
curl -fsS https://$VEYRA_HOST/api/health
```

**A ordem importa.** O Prisma exige schema compatível no boot, então o ideal é
migrar ANTES do código novo assumir. Como o Coolify sobe tudo de uma vez, a
janela entre o container novo e a migration é real: para migration destrutiva,
faça em duas etapas (código que tolera as duas formas → migration → limpeza),
como manda o hook de migration destrutiva.

**Migration antes do código** porque o Prisma exige schema compatível no boot.
Migration destrutiva quebra essa ordem: nesse caso, deploy em duas etapas
(código que tolera as duas formas → migration → limpeza), como manda o hook de
migration destrutiva.

**Migration que precisa vir ANTES do código (`20261020010000_scheduling_clock`,
ADR-049).** O código novo deixa de enviar `updatedAt` ao criar o despacho do
WhatsApp, e só o DEFAULT desta migration cobre o NOT NULL. Na janela em que o
container novo já sobe e a migration ainda não rodou, todo envio falharia (500,
nada enviado nem cobrado). Rode-a ANTES de apontar o recurso para o commit novo,
num container avulso da imagem nova (`run --rm --no-deps api npx prisma migrate
deploy`, como no §9). O código antigo funciona com ela aplicada. Antes do primeiro
deploy dela num ambiente novo, confira `SHOW timezone` no banco: o esperado é
`UTC`. A aplicação fixa a sessão em UTC pela própria URL e, com o banco
alcançável no boot, recusa subir se a sessão não estiver em UTC.

**Migration que estoura `lock_timeout`.** Migrations em tabela muito escrita
(`20261019200000_outbox_subject_contacts`,
`20261019210000_outbox_terminal_is_final` e
`20261020010000_scheduling_clock`, sobre `OutboxEvent` e `MessageDispatch`) e as que criam
FK para tabela muito escrita (`20261019220000_clinics_foundation`, que trava
`Contact`, `Membership` e `Workspace`, e `20261019230000_clinics_catalog`, que
trava `Membership` e `Workspace`, durante o `ADD FOREIGN KEY`) fixam
`lock_timeout = 5s`, assim como a `20261021120000_clinics_packages`, que trava
`Membership` e `Workspace`, e a `20261022120000_clinics_returns` (F3.2), que
trava também `ClinicsAppointment`, `ClinicsAttendance`, `ClinicsService`,
`ClinicsPatient` e `ClinicsUnit`. Esta última estima no cabeçalho até cerca de
55 s de espera por locks (onze esperas possíveis de 5 s), mais a execução: é
estimativa, não limite. Os dois locks exclusivos dela ficam por último. Se uma transação longa estiver segurando a tabela, a
migration falha em vez de travar todas as escritas da aplicação. O Prisma a
registra como falha, e o próximo `migrate deploy` para com **P3009**. No
próprio deploy, uma migration sem transação mostra **P3018** com a causa; a
transacional mostra só "current transaction is aborted" (abaixo).

O `lock_timeout` **só limita a espera para obter cada lock**, não o tempo de
execução das instruções, que nada nesta migration limita. Na transacional, os
locks obtidos ficam presos até o `COMMIT`, e as esperas se somam. Na
`clinics_packages`, a **estimativa** das esperas por lock no pior caso é de
cerca de 25 s:

- até 5 s na fila pelo lock exclusivo de `ClinicsAttendance`. Um pedido na
  fila já bloqueia os pedidos seguintes;
- até 5 s em cada uma das quatro FKs para tabelas existentes (`Workspace`,
  `ClinicsPatient`, `ClinicsService` e `Membership`), com `ClinicsAttendance`
  já bloqueada.

A esse total soma-se o tempo de execução, que aqui é curto (tabela nova vazia,
índice sobre as linhas de `ClinicsAttendance`), mas sem limite. O comentário da
migration fala em "~20 s"; o número acima é a conta completa. **Não é limite da
migration:** é estimativa das esperas. Por isso o deploy é feito em
manutenção, sem acesso externo e com os jobs desligados. Qualquer outra falha
de migration segue o mesmo procedimento, abaixo.

**Falha de migration: o que fica no banco.** O `prisma migrate deploy` executa
cada migration **instrução por instrução, sem transação**. Isso foi ensaiado em
2026-10-21 (ADR-048 adendo 7). Por isso:

- **Migration sem transação explícita** (todas até
  `20261021090100_message_dispatch_ai_origin_backfill`): uma falha no meio
  **deixa aplicado o que veio antes**. No ensaio, a primeira versão da
  `20261021120000_clinics_packages` falhou deixando 14 dos seus 23 objetos.
  Repetir depois do `resolve --rolled-back` falhou com
  `type "ClinicsPackageStatus" already exists`. Uma migration de instrução única
  não fica pela metade, mas confira o estado mesmo assim.
- **Migration transacional**, com `BEGIN` e `COMMIT` no arquivo (a
  `20261021120000_clinics_packages` e, pelo ADR-051, toda migration nova; cada
  uma traz o seu inventário nesta seção): a falha desfaz tudo, como o ensaio
  comprovou. O Prisma mostra só "current transaction is aborted" e não grava o
  log; **a causa real está no log do Postgres**.

**Procedimento. Nunca marque `rolled-back` às cegas:** o `migrate resolve` só
muda o registro da migration e não desfaz nenhum objeto.

1. **Permaneça em manutenção**, com o acesso bloqueado. Não religue o código
   antigo (§5).
2. **Leia a causa** na saída do Prisma e no log do Postgres. A instrução que
   falhou vem nas linhas seguintes ao `ERROR`:

   ```bash
   docker logs --since 30m <container-db> 2>&1 | grep -A4 ERROR | tail -40
   ```

   Num `lock_timeout`, ache a transação longa que segurava a tabela, pelo
   console do banco (como no passo 3 do deploy da guarda):

   ```sql
   SELECT pid, now() - xact_start AS duracao, state, left(query, 80) AS consulta
     FROM pg_stat_activity
    WHERE xact_start < now() - interval '5 seconds'
    ORDER BY xact_start;
   ```

3. **Prove o estado** da migration que falhou, que o
   `npx prisma migrate status` aponta, pelo inventário dos objetos dela. Para a
   `20261021120000_clinics_packages`:

   ```sql
   -- inventário da 20261021120000_clinics_packages: 0 linhas = nada ficou;
   -- 23 = inteira; qualquer outro número = estado parcial
   SELECT 'tipo' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname = 'ClinicsPackageStatus'
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relname = 'ClinicsPackage' AND c.relkind = 'r'
   UNION ALL SELECT 'coluna', 'ClinicsAttendance.packageId' FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relname = 'ClinicsAttendance' AND a.attname = 'packageId' AND NOT a.attisdropped
   UNION ALL SELECT 'indice', c.relname::text FROM pg_class c
     WHERE c.relkind = 'i' AND (c.relname LIKE 'ClinicsPackage\_%' OR c.relname = 'ClinicsAttendance_workspaceId_packageId_idx')
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     WHERE (co.conname LIKE 'ClinicsPackage\_%' OR co.conname = 'ClinicsAttendance_workspaceId_packageId_fkey')
       AND co.contype <> 'n'  -- no Postgres 18, cada NOT NULL também vira restrição
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('clinics_package_guard', 'clinics_attendance_package_is_final')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('ClinicsPackage_guard', 'ClinicsAttendance_package_is_final')
   ORDER BY 1, 2;
   ```

   Para a `20261022120000_clinics_returns` (F3.2):

   ```sql
   -- inventário da 20261022120000_clinics_returns: 0 linhas = nada ficou;
   -- 37 = inteira; qualquer outro número = estado parcial
   SELECT 'tipo' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname IN ('ClinicsReturnStatus', 'ClinicsReturnCancelReason')
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relname = 'ClinicsReturn' AND c.relkind = 'r'
   UNION ALL SELECT 'coluna', c.relname || '.' || a.attname FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE NOT a.attisdropped
       AND ((c.relname = 'ClinicsService' AND a.attname = 'returnIntervalDays')
         OR (c.relname = 'ClinicsAttendance' AND a.attname = 'recordedAt'))
   UNION ALL SELECT 'indice', c.relname::text FROM pg_class c
     WHERE c.relkind = 'i' AND (c.relname LIKE 'ClinicsReturn\_%'
       OR c.relname IN ('ClinicsAppointment_return_link_key', 'ClinicsAttendance_return_proof_key'))
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     WHERE (co.conname LIKE 'ClinicsReturn\_%' OR co.conname = 'ClinicsService_returnIntervalDays_check')
       AND co.contype <> 'n'  -- no Postgres 18, cada NOT NULL também vira restrição
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('clinics_return_guard', 'clinics_attendance_recorded_at')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('ClinicsReturn_guard', 'ClinicsAttendance_recorded_at')
   ORDER BY 1, 2;
   ```

   Para a `20261023120000_conversation_sender_and_phone_identity` (F4.1a,
   ADR-052), com **18 objetos**. Ela tem um procedimento próprio, antes e
   depois do `migrate deploy`:

   - **antes:** `pnpm --filter @veyra/api identity:diagnose`. Se ele apontar
     grupos que violariam o único de conversa aberta, a migration vai falhar
     inteira; o tratamento é humano (encerrar ou religar a conversa a mais),
     e nada é corrigido sozinho;
   - **a ingestão e os escritores de telefone PARADOS** do deploy até o fim das
     verificações (decisão de 2026-10-23, ADR-052 desvio 12): o webhook sem
     responder 2xx, para a Meta reentregar — a janela de reentrega dela fica a
     confirmar na F4.5, e a parada precisa caber nela —, e a edição e a
     importação de contatos fora do ar;
   - **depois da migration:** `pnpm --filter @veyra/api phones:normalize`, que
     preenche as formas normalizadas dos telefones e a segunda chave. Sem ele,
     o contato sem forma normalizada só coincide como "possível" e a mensagem
     iria à área RAI. A CLI só grava o contato cujos telefones não mudaram
     durante a leitura, e conta os pulados; com tudo parado, pulados deve dar
     zero — se não der, rodar de novo e conferir;
   - **as verificações**, ainda com tudo parado: o inventário abaixo, o
     `identity:diagnose` de novo (nenhum grupo) e o `phones:normalize` de
     novo, que não deve alterar nada. Só então a ingestão e os escritores
     voltam;
   - **a variável `ADDRESS_LOCK_KEY`** precisa estar no ambiente ANTES do
     deploy: sem ela, a API não sobe (§3.3).

   ```sql
   -- inventário da 20261023120000_conversation_sender_and_phone_identity: 0 linhas =
   -- nada ficou; 18 = inteira; qualquer outro número = estado parcial
   SELECT 'tipo' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname = 'ConversationSender'
   UNION ALL SELECT 'coluna', c.relname || '.' || a.attname FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE NOT a.attisdropped
       AND ((c.relname = 'Workspace' AND a.attname = 'phoneRegion')
         OR (c.relname = 'Contact' AND a.attname IN ('phonesNormalized', 'phoneMatchKeys'))
         OR (c.relname = 'Conversation'
           AND a.attname IN ('senderStatus', 'senderIdentifiedAt', 'openMark', 'unidentifiedOpenMark'))
         OR (c.relname = 'FileObject' AND a.attname = 'conversationRestricted'))
   UNION ALL SELECT 'indice', c.relname::text FROM pg_class c
     WHERE c.relkind = 'i' AND c.relname IN (
       'Contact_phoneMatchKeys_idx',
       'Conversation_workspaceId_channelId_contactId_externalAddres_key',
       'Conversation_workspaceId_channelId_externalAddress_unidenti_key')
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     WHERE co.conname IN (
       'Workspace_phoneRegion_check',
       'Conversation_sender_check',
       'Conversation_openMark_check',
       'Conversation_unidentifiedOpenMark_check')
       AND co.contype <> 'n'
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname = 'conversation_marks'
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname = 'conversation_marks'
   ORDER BY 1, 2;
   ```

   Para a `20261026120000_consents_and_stop_block` (F4.1b, ADR-052 item 5),
   com **52 objetos**. As tabelas são novas e vazias; o que ela escreve em
   dado existente é o preenchimento das chaves novas nos papéis `owner`,
   `admin` e `member` do Core, com os pré-requisitos, o livro
   (`PermissionBackfill`) e a auditoria (`role.permission_backfilled`). Só
   acréscimo: nenhuma concessão é removida. Depois dela:

   - **o envio por template fica indisponível** (`template_flow_unavailable`)
     até a F4.1c, e um despacho de template pendente vai a `failed_permanent`
     com esse motivo; o consentimento da 9.1 não autoriza mais nada;
   - **nenhuma finalidade existe**: elas são criadas, quando houver, pela CLI
     `pnpm --filter @veyra/api consents:purpose`;
   - **a conferência**: o inventário abaixo, e o número de linhas do livro
     igual ao das concessões auditadas, somado ao das chaves que o papel já
     tinha;
   - **a imagem anterior NÃO serve de rollback operacional** (decisão do
     usuário, ADR-052): ela desliga o pedido de parar — o código anterior não
     conhece o `StopBlock`, e tudo voltaria a sair para os números bloqueados,
     inclusive a IA — e volta a aceitar template com o consentimento da 9.1.
     **Em falha depois desta migration, permanece a manutenção**: a correção
     vem para a frente, numa imagem nova, nunca pela anterior;
   - **a idempotência** passa a considerar a membership no hash: uma
     `Idempotency-Key` gravada antes do deploy pode dar 409 durante a retenção
     (24 h). O cliente que recebe 409 não troca a chave sozinho para repetir.

   ```sql
   -- inventário da 20261026120000_consents_and_stop_block: 0 linhas = nada ficou;
   -- 52 = inteira; qualquer outro número = estado parcial. As chaves do catálogo
   -- são DADO (a semeadura também as escreve) e ficam fora: confira-as à parte
   SELECT 'tipo' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname IN ('ConsentOrigin', 'ConsentPurposeCategory', 'ConsentRevocationReason')
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relkind = 'r' AND c.relname IN (
       'ConsentPurpose', 'Consent', 'StopBlock', 'ConsentReceiptCounter', 'PermissionBackfill')
   UNION ALL SELECT 'indice', c.relname::text FROM pg_class c
     WHERE c.relkind = 'i' AND (c.relname LIKE 'ConsentPurpose\_%' OR c.relname LIKE 'Consent\_%'
       OR c.relname LIKE 'StopBlock\_%' OR c.relname LIKE 'ConsentReceiptCounter\_%'
       OR c.relname LIKE 'PermissionBackfill\_%')
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     WHERE (co.conname LIKE 'ConsentPurpose\_%' OR co.conname LIKE 'Consent\_%'
       OR co.conname LIKE 'StopBlock\_%' OR co.conname LIKE 'ConsentReceiptCounter\_%'
       OR co.conname LIKE 'PermissionBackfill\_%')
       AND co.contype <> 'n'  -- no Postgres 18, cada NOT NULL também vira restrição
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('consent_guard', 'stop_block_guard')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('consent_guard', 'stop_block_guard')
   ORDER BY 1, 2;
   ```

   Para a `20261026150000_dispatch_canceled` (F4.1c-1, ADR-052), com **4
   objetos**: o valor `canceled` do tipo `DispatchState`, as colunas
   `MessageDispatch.cancelRequestedAt` e `MessageDispatch.cancelReason` e a
   restrição `MessageDispatch_cancel_check`. Nenhum estado gravado muda. Junto com
   ela, a partir desta versão:

   - **o `phones:normalize` passa a revogar** o consentimento ativo de número
     que não é exato do contato (`number_removed`), na mesma transação,
     inclusive o deixado pela versão anterior da CLI, que não revogava; e
     normaliza cada workspace numa transação só, com a trava dos escritores em
     massa exclusiva. **Durante a passada de um workspace**, nada espera sem
     limite, mas quase tudo que mexe com telefone daquele workspace desiste:
     - a ingestão espera só o prazo dela e falha. Os outros workspaces do
       mesmo POST continuam sendo processados enquanto houver prazo do lote,
       mas a resposta à Meta é de erro, sem confirmação parcial: a reentrega
       traz o lote inteiro, e os itens já processados são deduplicados;
     - a resposta de pessoa e o envio da IA não começam e voltam pela
       retentativa do outbox;
     - importar (em até 2 s), criar ou editar contato com telefone, excluir
       contato, identificar, conceder, parar e desbloquear respondem 409 em
       até 10 s, sem efeito. **Um pedido de parar recusado assim precisa ser
       registrado de novo**;
     - editar um contato sem telefone e excluir uma empresa também dão 409 em
       até 10 s, porque a passada segura as linhas dos contatos.

     A medida no ambiente de teste foi de algumas centenas de milissegundos por
     mil contatos. É uma medida, não uma garantia: medir no staging antes da
     produção.

     **Rodar na janela de manutenção, sem ativar nem desativar vertical
     durante a passada.** A ativação entra na fila da trava do workspace e
     amplia a espera de todos os pedidos dele.

     A guarda do envio da IA segura a trava compartilhada pela chamada
     inteira (até uns 23 s), mais que a espera de 10 s da passada. **No
     deploy, a passada roda com `DISABLE_JOBS=true`** (passo 4 da manutenção),
     sem envio nenhum. Fora dele, num workspace com envio da IA contínuo, a
     passada pode falhar seguidas vezes: pause os envios antes. Um workspace
     sem a trava no prazo é relatado só com o tipo e o código do erro e
     pulado, sem nada mudar; a CLI segue para o próximo e sai com erro, e
     rodar de novo retoma. A transação tem 60 s de prazo de ociosidade: a CLI
     que cai não segura a trava;

   - **a importação de contatos** espera os escritores e leitores de telefone
     do workspace por até **2 s** (depois, 409 sem efeito, e a pessoa tenta de
     novo). O prazo é curto porque, enquanto ela espera a trava exclusiva, os
     pedidos novos da compartilhada do workspace esperam atrás dela — e a
     guarda do envio da IA segura a compartilhada pela chamada inteira.

   ```sql
   -- inventário da 20261026150000_dispatch_canceled: 0 linhas = nada ficou;
   -- 4 = inteira; qualquer outro número = estado parcial
   SELECT 'valor' AS k, e.enumlabel::text AS nome FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'DispatchState' AND e.enumlabel = 'canceled'
   UNION ALL SELECT 'coluna', c.relname || '.' || a.attname FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     WHERE NOT a.attisdropped AND c.relname = 'MessageDispatch'
       AND a.attname IN ('cancelRequestedAt', 'cancelReason')
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     WHERE co.conname = 'MessageDispatch_cancel_check'
   ORDER BY 1, 2;
   ```

   Para a `20261026200000_template_versions` (F4.1c-2, ADR-052 item 4), com
   **27 objetos**: os tipos `TemplateCategory`, `TemplateParameterFormat` e
   `TemplateVersionStatus`; as tabelas `MessageTemplateVersion` e
   `TemplateReview`, com 12 restrições (2 chaves, 6 FKs — 4 compostas e 2
   para o workspace — e 4 CHECKs) e 6 índices; e as funções e os gatilhos `template_version_guard` e
   `template_review_guard`. As tabelas nascem vazias, e nada que já existe
   muda. Ela **não abre envio**: o envio por template continua recusado
   (`template_flow_unavailable`). O cadastro das versões é pela CLI
   `templates:register`, que lê o catálogo da Meta com a credencial do canal;
   com o transporte falso, o catálogo também é falso: ele só traz os
   templates fictícios `demo_*` da WABA fictícia (F4.4b, ADR-048 adendo 12),
   e para qualquer outra WABA o cadastro não acha nada. Contra uma WABA real,
   o cadastro só depois da liberação de dados reais.

   A WABA do canal não muda na rotação do token sem `--trocar-waba` (§7).

   ```sql
   -- inventário da 20261026200000_template_versions: 0 linhas = nada ficou;
   -- 27 = inteira; qualquer outro número = estado parcial
   SELECT 'tipo' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname IN ('TemplateCategory', 'TemplateParameterFormat', 'TemplateVersionStatus')
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relkind = 'r' AND c.relname IN ('MessageTemplateVersion', 'TemplateReview')
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     JOIN pg_class c ON c.oid = co.conrelid
     WHERE c.relname IN ('MessageTemplateVersion', 'TemplateReview') AND co.contype <> 'n'
   UNION ALL SELECT 'indice', i.relname::text FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE c.relname IN ('MessageTemplateVersion', 'TemplateReview') AND NOT x.indisprimary
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('template_version_guard', 'template_review_guard')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('template_version_guard', 'template_review_guard')
   ORDER BY 1, 2;
   ```

   Para a `20261027120000_business_outbound` (F4.1c-3, ADR-052 itens 6 a 9),
   com **23 objetos**: o valor `business_outbound` do `ContentUseKind`; o
   único `Consent_workspaceId_id_key`; a tabela `OutboundApproval`, com 14
   restrições (a chave, 9 FKs compostas ou para o workspace e 4 CHECKs) e 4
   índices, entre eles o único do `approvalHash` (uma aprovação por prévia); e
   a função e o gatilho `outbound_approval_guard`. A tabela nasce
   vazia, e nada que já existe muda. **A variável `OUTBOUND_APPROVAL_KEY`
   precisa estar no ambiente ANTES do deploy:** sem ela, a API não sobe. Com o
   transporte falso, o envio do negócio exercita o caminho inteiro sem que
   nada saia; o template só aparece no compositor depois de cadastrado e
   revisado. Em staging, o catálogo falso só tem os templates fictícios da
   WABA fictícia, cadastrados e revisados pelo `templates:demo` (F4.4b).

   ```sql
   -- inventário da 20261027120000_business_outbound: 0 linhas = nada ficou;
   -- 23 = inteira; qualquer outro número = estado parcial
   SELECT 'enum' AS k, e.enumlabel::text AS nome FROM pg_enum e
     JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'ContentUseKind' AND e.enumlabel = 'business_outbound'
   UNION ALL SELECT 'indice', i.relname::text FROM pg_class i
     WHERE i.relkind = 'i' AND i.relname = 'Consent_workspaceId_id_key'
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relkind = 'r' AND c.relname = 'OutboundApproval'
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     JOIN pg_class c ON c.oid = co.conrelid
     WHERE c.relname = 'OutboundApproval' AND co.contype <> 'n'
   UNION ALL SELECT 'indice', i.relname::text FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE c.relname = 'OutboundApproval' AND NOT x.indisprimary
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname = 'outbound_approval_guard'
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname = 'outbound_approval_guard'
   ORDER BY 1, 2;
   ```

   Para a `20261028120000_business_outbound_vertical_origin` (F4.2, ADR-048
   adendo 9), com **4 objetos**: a coluna `originMark` da `OutboundApproval`,
   o único `OutboundApproval_workspaceId_originRef_originMark_key`, a restrição
   `OutboundApproval_originMark_check` e a `MessageDispatch_cancel_check`
   **com** o motivo `origin_invalidated`. A restrição do cancelamento é
   trocada, e não criada: a de antes, só com `stop_requested`, não conta.
   Antes de qualquer mudança, a migration confere que nenhuma aprovação tem
   origem de vertical e, se houver, falha inteira. O Prisma relata só
   "current transaction is aborted"; a causa aparece aplicando o arquivo pelo
   `psql` com `ON_ERROR_STOP`, como no ensaio.

   ```sql
   -- inventário da 20261028120000_business_outbound_vertical_origin:
   -- 0 linhas = nada ficou; 4 = inteira; outro número = estado parcial
   SELECT 'coluna' AS k FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'OutboundApproval' AND column_name = 'originMark'
   UNION ALL SELECT 'indice' FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'OutboundApproval_workspaceId_originRef_originMark_key'
   UNION ALL SELECT 'check' FROM pg_constraint WHERE conname = 'OutboundApproval_originMark_check'
   UNION ALL SELECT 'motivo' FROM pg_constraint
     WHERE conname = 'MessageDispatch_cancel_check'
       AND pg_get_constraintdef(oid) LIKE '%origin_invalidated%';
   ```

   Para a `20261028150000_clinics_outreach` (F4.2, a parte do Clinics, ADR-048
   adendo 9), com **19 objetos**: o enum `ClinicsOutreachKind`; a tabela
   `ClinicsOutreachRequest`, com 8 restrições (a chave, 4 FKs compostas ou para
   o workspace e 3 CHECKs) e 5 índices, entre eles os dois únicos da marca de
   ativo e o da varredura; e as duas funções e os dois gatilhos do pedido (a
   guarda e a recusa da exclusão). A tabela nasce vazia, e nada que já
   existe muda. As FKs seguram, até o COMMIT, as escritas em
   `ClinicsAppointment`, `ClinicsReturn`, `Membership` e `Workspace`. **Com o
   Clinics desativado no staging, a varredura roda e não acha nada; a porta do
   E7 responde "não vale" em workspace sem o vertical ativo.**

   ```sql
   -- inventário da 20261028150000_clinics_outreach: 0 linhas = nada ficou;
   -- 19 = inteira; qualquer outro número = estado parcial
   SELECT 'enum' AS k, t.typname::text AS nome FROM pg_type t
     WHERE t.typname = 'ClinicsOutreachKind'
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relkind = 'r' AND c.relname = 'ClinicsOutreachRequest'
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     JOIN pg_class c ON c.oid = co.conrelid
     WHERE c.relname = 'ClinicsOutreachRequest' AND co.contype <> 'n'
   UNION ALL SELECT 'indice', i.relname::text FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE c.relname = 'ClinicsOutreachRequest' AND NOT x.indisprimary
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('clinics_outreach_request_guard', 'clinics_outreach_request_no_delete')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('ClinicsOutreachRequest_guard', 'ClinicsOutreachRequest_no_delete')
   ORDER BY 1, 2;
   ```

   Para a `20261028200000_clinics_deal_link_and_confirmation` (F4.3, ADR-048
   adendo 10), com **16 objetos**: as colunas `confirmedAt` e
   `confirmationTracked` do agendamento; a tabela `ClinicsAppointmentDeal`, com
   5 restrições (a chave e 4 FKs) e 4 índices; e as duas funções e os dois
   gatilhos (a confirmação e a guarda do vínculo). A migration marca os
   agendamentos que já existem fora de `scheduled` como sem rastreio da
   confirmação, sem inventar data: um `UPDATE` sobre a agenda, pequeno.

   ```sql
   -- inventário da 20261028200000_clinics_deal_link_and_confirmation:
   -- 0 linhas = nada ficou; 16 = inteira; outro número = estado parcial
   SELECT 'coluna' AS k, column_name::text AS nome FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'ClinicsAppointment'
       AND column_name IN ('confirmedAt', 'confirmationTracked')
   UNION ALL SELECT 'tabela', c.relname::text FROM pg_class c
     WHERE c.relkind = 'r' AND c.relname = 'ClinicsAppointmentDeal'
   UNION ALL SELECT 'restricao', co.conname::text FROM pg_constraint co
     JOIN pg_class c ON c.oid = co.conrelid
     WHERE c.relname = 'ClinicsAppointmentDeal' AND co.contype <> 'n'
   UNION ALL SELECT 'indice', i.relname::text FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE c.relname = 'ClinicsAppointmentDeal' AND NOT x.indisprimary
   UNION ALL SELECT 'funcao', p.proname::text FROM pg_proc p
     WHERE p.proname IN ('clinics_appointment_confirmation', 'clinics_appointment_deal_guard')
   UNION ALL SELECT 'gatilho', tg.tgname::text FROM pg_trigger tg
     WHERE tg.tgname IN ('ClinicsAppointment_confirmation', 'ClinicsAppointmentDeal_guard')
   ORDER BY 1, 2;
   ```

   Para outra migration, monte o inventário do mesmo jeito, a partir das
   instruções do arquivo: cada `CREATE` e cada `ADD CONSTRAINT`.

   **Os passos 4 e 5 usam a `clinics_packages` como exemplo** (23 objetos).
   Para a `clinics_returns`, troque pelo nome dela e por 37 objetos. No bloco do
   passo 5, use `NOME=20261022120000_clinics_returns` e
   `SENTINELA='TABLE public."ClinicsReturn"'`.

4. **Inventário zerado (nada ficou):** remova a causa (por exemplo, espere ou
   encerre a transação longa que segurava a tabela) e então, no container da
   API:

   ```bash
   docker exec -it <container-api> npx prisma migrate resolve --rolled-back 20261021120000_clinics_packages
   docker exec -it <container-api> npx prisma migrate deploy
   ```

   Depois, o inventário precisa dar 23 linhas, e o `migrate status` não pode
   ter pendências.

5. **Inventário completo (23) com o registro falho:** o `COMMIT` passou, mas o
   processo morreu antes de o Prisma gravar o fim, por exemplo porque a sessão
   do `docker exec` caiu. **Nunca** `--rolled-back`: repetir falha, porque os
   objetos já existem (ensaiado).

   **A contagem e o `migrate diff` não bastam para marcar `--applied`.** O
   inventário confere só os nomes. O Prisma não modela funções, gatilhos nem
   CHECKs, então o `migrate diff` não os vê. No ensaio, uma base com o corpo
   de uma função, um CHECK e os eventos de um gatilho adulterados deu
   inventário 23 e `migrate diff` vazio. Antes de marcar, **compare o schema
   `public` inteiro com uma base de referência** montada no mesmo Postgres
   pelas migrations da imagem nova **até a que falhou**. O dump só de
   schema (`pg_dump --schema-only`) traz as definições completas: corpo das
   funções, gatilhos com eventos e momento, CHECKs, defaults, índices e FKs.

   O bloco abaixo roda no host, colado inteiro no terminal. Ele roda num
   subshell com `set -euo pipefail`: uma falha interrompe o bloco sem fechar a
   sessão.
   Troque os dois nomes antes de rodar. Ele **só imprime "SCHEMA IGUAL"** se:

   - os dois containers existem;
   - a referência foi montada até a migration certa;
   - os dois dumps saíram e contêm a sentinela da migration;
   - o `diff` é vazio.

   Placeholder não trocado, container errado, dump vazio, referência sem a
   migration ou qualquer diferença interrompem o bloco **sem** essa linha. Ele
   sempre recria a referência do zero e a apaga depois dos dumps.

   ```bash
   (
   set -euo pipefail
   DB_CT='<container-db>'                                 # os nomes da §3.6
   API_CT='<container-api>'
   NOME=20261021120000_clinics_packages                    # a migration que falhou
   SENTINELA='TABLE public."ClinicsPackage"'              # um objeto que ela cria
   D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
   docker inspect "$DB_CT" "$API_CT" > /dev/null

   # 1. a referência: banco novo, com as migrations da imagem nova ATÉ a que falhou
   docker exec "$DB_CT" sh -euc 'dropdb --if-exists -U "$POSTGRES_USER" veyra_referencia; createdb -U "$POSTGRES_USER" veyra_referencia'
   docker exec -e NOME="$NOME" "$API_CT" sh -euc '
     rm -rf /tmp/ref; mkdir -p /tmp/ref/migrations
     cp prisma/migrations/migration_lock.toml /tmp/ref/migrations/
     for m in prisma/migrations/*/; do m=${m%/}; cp -R "$m" /tmp/ref/migrations/; [ "${m##*/}" = "$NOME" ] && break; done
     [ -d "/tmp/ref/migrations/$NOME" ]
     printf "export default { schema: \"%s/prisma/schema\", migrations: { path: \"/tmp/ref/migrations\" }, datasource: { url: process.env.DATABASE_URL } };\n" "$PWD" > /tmp/ref/prisma.config.ts
     U=$(printf %s "$DATABASE_URL" | sed -E "s#/[^/?]*([?].*)?\$#/veyra_referencia\1#")
     case "$U" in */veyra_referencia|*/veyra_referencia\?*) ;; *) echo "URL da referência inválida" >&2; exit 1 ;; esac
     DATABASE_URL="$U" npx prisma migrate deploy --config /tmp/ref/prisma.config.ts
     rm -rf /tmp/ref'

   # 2. o schema `public` dos dois (as extensões e o `pgboss`, que a aplicação cria, ficam fora)
   docker exec "$DB_CT" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --schema=public --schema-only --no-owner --no-privileges' \
     | grep -vE '^--|^\\(un)?restrict' | sed '/^$/d' > "$D/alvo.sql"
   docker exec "$DB_CT" sh -c 'pg_dump -U "$POSTGRES_USER" -d veyra_referencia --schema=public --schema-only --no-owner --no-privileges' \
     | grep -vE '^--|^\\(un)?restrict' | sed '/^$/d' > "$D/referencia.sql"
   docker exec "$DB_CT" sh -c 'dropdb -U "$POSTGRES_USER" veyra_referencia'

   # 3. os dois dumps existem, têm a migration, e são iguais
   grep -qF "$SENTINELA" "$D/alvo.sql"
   grep -qF "$SENTINELA" "$D/referencia.sql"
   diff "$D/alvo.sql" "$D/referencia.sql"
   echo 'SCHEMA IGUAL À REFERÊNCIA'
   )
   ```

   - **"SCHEMA IGUAL À REFERÊNCIA":** marque como aplicada, ainda em
     manutenção:

     ```bash
     docker exec -it <container-api> npx prisma migrate resolve --applied 20261021120000_clinics_packages
     ```

   - **Qualquer outro desfecho:** **não** marque. É estado a investigar com
     plano revisado, como o do passo 6.
     - Um objeto criado no `public` fora das migrations também aparece aqui;
       na base local de desenvolvimento, uma tabela solta de experimento
       apareceu assim.
     - As extensões e o schema `pgboss`, que a aplicação cria em tempo de
       execução, ficam fora da comparação. A falta de uma extensão aparece
       nos objetos que dependem dela, como o EXCLUDE que usa o `btree_gist`.
     - Se a referência ficar para trás numa interrupção, o próximo uso do
       bloco a apaga.

   **Esse ramo foi ensaiado inteiro,** com um Postgres 17 isolado e a imagem
   da API fazendo o papel dos dois containers:

   - a recuperação com `--applied`, o caminho às cegas e as adulterações que só
     a comparação viu;
   - o **bloco acima, extraído deste arquivo** e só com os nomes trocados:
     - placeholders sem trocar: interrompe;
     - base íntegra, colada com o recuo do arquivo: "IGUAL", seguido de
       `--applied` e status em dia;
     - migration que falhou não sendo a última: a referência para nela, sem
       a sentinela, e o bloco interrompe;
     - CHECK adulterado: o `diff` mostra e o bloco interrompe;
   - uma versão anterior do bloco também cobriu container errado e referência
     velha de uma tentativa anterior.

   Em nenhum caso a referência sobrou.

6. **Estado parcial**, numa migration sem transação que falhou no meio: **não**
   marque `rolled-back` nem repita. O caminho é um plano revisado, ainda em
   manutenção. Ou se desfaz exatamente o que foi aplicado e só então se marca
   `rolled-back`, ou se completa o que faltou e se marca `--applied`. Os dois
   exigem revisão antes de executar.

**Extensão `btree_gist`.** A `20261019230000_clinics_catalog` cria a extensão
(`CREATE EXTENSION IF NOT EXISTS`), usada pela regra de horários sem
sobreposição. É uma extensão confiável: basta o usuário da migration ter
`CREATE` no banco. No compose de staging, ele é o `POSTGRES_USER` da imagem
oficial, dono do banco, e funciona sem ajuste. Num Postgres gerenciado, confira
esse privilégio antes do deploy.

**Conexões da guarda de uso externo (ADR-047 adendo 7, G1).** Cada instância
da API abre até **10 conexões a mais** com o Postgres: 5 do pool de guarda e 5
do pool de registro, além das 10 do Prisma. Confira `max_connections` (o padrão
do Postgres é 100) contra o número de instâncias e o que mais usa o mesmo
servidor. As duas migrations da G1 (`20261020200000_content_use` e
`20261020200100_content_use_overran_deadline`) são aditivas e rodam ANTES do
código, como as demais. A reconciliação dos usos roda a cada minuto com os
jobs ligados. Desde a G3, os três usos passam pela guarda: a geração de IA, o
envio da mensagem de origem da IA e a entrega de webhook. A entrega abre uma
guarda por destino e por tentativa, em sequência, então cada worker usa uma
sessão de guarda por vez. A G3.3 não traz migration.

Duas condições do banco valem para a guarda (ADR-047 adendo 7 §3.5):

- **Durabilidade.** Não é preciso criar réplica: o Postgres único continua
  válido. A condição vale só se um dia houver replicação com failover. Um commit
  confirmado não pode se perder: failover só para
  réplica **síncrona**. Com réplica assíncrona, um registro de uso comitado
  pode sumir no failover, e o critério G′ deixa de valer. Hoje o staging tem
  um Postgres só (o serviço `db` do compose), sem réplica e sem pooler, com a
  API ligada direto nele. Qualquer réplica futura entra com essa condição.
- **Conexão direta ou pooler em modo sessão.** Os pools da guarda e do
  registro fixam parâmetros de sessão pela URL (`statement_timeout`,
  `idle_in_transaction_session_timeout`, `synchronous_commit`, keepalive). Um
  pooler em modo transação (PgBouncer `pool_mode = transaction`) os descarta
  sem aviso. Só o pool principal confere a sessão no boot (UTC); para os da
  guarda, a condição é deste runbook.

**Prazo de leitura do proxy (G3.1).** Uma geração de IA sob a guarda pode levar
mais de 98 s: espera por sessão, travas, reconferência, registro, os 60 s do
provedor, a desistência e a persistência. O nginx do `web` usa
`proxy_read_timeout 120s`. Qualquer proxy à frente dele (o da VPS, o do Coolify)
precisa de um prazo de leitura igual ou maior. Se cortar antes, a pessoa recebe
504 com o run já gravado e cobrado, e paga de novo ao repetir.

> **BLOQUEIO antes de qualquer deploy desta atualização** (decisão do usuário,
> 2026-10-21; ADR-048 adendo 6). **Atualização de 2026-10-29:** a barreira
> contínua é o `MAINTENANCE_MODE` (ADR-053), e o roteiro que a usa é o §14. O
> texto abaixo descreve a situação de antes dela. A **barreira contínua de manutenção** ainda não
> existe. O procedimento abaixo **detecta** uma rota aberta depois do deploy, mas
> não **impede** o acesso durante toda a janela, e detectar não cumpre a
> exigência. Não use este procedimento num deploy até a barreira estar
> implementada e comprovada: um modo de manutenção na aplicação, ou uma
> barreira externa independente. O proxy compartilhado não é alterado sem
> diagnóstico e autorização.

**Deploy da guarda de uso externo (da G3.2 em diante): pausar, classificar,
subir sem jobs, migrar, retomar.** "Migration antes do código", sozinha, **não
fecha** a janela da G3.2 (decisão de 2026-10-21, ADR-047 adendo 7 §9). Entre a
migration e a subida do código novo, o código antigo continua no ar: aprova
rascunhos da IA, que nascem sem a origem de IA, e envia pela regra antiga,
porque não lê a coluna nova. Três regras:

- **o acesso externo fica bloqueado durante toda a manutenção**, inclusive
  depois de a API e o `web` novos subirem. `DISABLE_JOBS` desliga os workers,
  mas **não bloqueia requisições nem a geração de IA pela API**. Uma falha de
  schema também não é barreira de manutenção. A barreira é o bloqueio do acesso,
  conferido de fora;
- **o código antigo nunca roda com o schema novo**;
- **nada sai antes das migrations**.

Use os nomes reais da §3.6. A ordem obrigatória:

1. **Backup** (§5), pelo container `backup`.
2. **Bloquear o acesso externo e pausar aprovações e envios.**
   1. No painel, **retire o domínio do serviço `web`** (a variável
      `SERVICE_FQDN_WEB_8080` da §3.2). Sem domínio, nenhum deploy desta
      manutenção gera rota no Traefik para o Veyra.
   2. No host, pare só a API e o `web`, como na restauração do §6. **Não use o
      Stop do recurso no painel**: ele para o compose inteiro, banco incluído, e
      os passos seguintes precisam do banco.

      ```bash
      docker stop <container-web> <container-api>
      ```

   3. **Confira de fora** (de outra máquina) que o Veyra não responde:

      ```bash
      curl -sS -o /dev/null -w '%{http_code}\n' https://veyra-staging.malachdigital.com.br/api/health
      ```

      **Qualquer 2xx interrompe a manutenção:** ela não começa sem o bloqueio
      conferido.

   Com isso nenhuma requisição chega, nenhuma aprovação é feita e nenhum worker
   envia. Os eventos ficam pendentes no outbox, que nunca se edita por SQL
   (§7.2).

3. **Classificar o que estava em andamento**, pelo console do banco, antes de
   qualquer migration. As variáveis do `psql` são lidas DENTRO do container (o
   shell do host não as tem). Anote os números:

   ```bash
   docker exec -it <container-db> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
   ```

   ```sql
   -- despachos pendentes ou em voo, por estado e marcador de despacho
   SELECT "state", ("dispatchedAt" IS NOT NULL) AS marcado, count(*)
     FROM "MessageDispatch"
    WHERE "state" IN ('reserved', 'failed_before_send', 'sending')
    GROUP BY 1, 2;
   -- usos de conteúdo ainda autorizados. SÓ se a G1 já estiver aplicada: antes
   -- dela a tabela não existe, e esta consulta falha
   SELECT "kind", count(*) FROM "ContentUse" WHERE "status" = 'authorized' GROUP BY 1;
   ```

   - `sending` **com** marcador: o envio pode ter saído. Depois da retomada,
     a varredura o marca `unknown_after_dispatch` e nunca o reenvia. A
     triagem decide; se a guarda provou que ele não saiu, aparece "Não saiu".
   - `reserved`, `failed_before_send` e `sending` **sem** marcador: saem
     depois da retomada, já pela regra nova.
   - Uso `authorized`: a reconciliação decide pela prova depois da retomada.
     Nada se edita à mão.
   - As consultas deste passo só usam colunas anteriores à G3.2. A contagem
     dos despachos de **cobertura limitada** vem no passo 5, depois das
     migrations: antes delas, as colunas da G3.2 não existem.

4. **Subir o código novo SEM os jobs.** No painel, defina `DISABLE_JOBS=true`
   no recurso, aponte para o commit novo e faça o **Deploy**, ainda **sem o
   domínio do `web`**. A API nova sobe sem worker do outbox, sem varreduras e
   sem reconciliação: nenhum envio e nenhuma entrega de webhook. O deploy
   recria os containers; releia os nomes (§3.6). Em seguida:
   1. **Pare o `web` de novo**, assim que o deploy terminar. Ele não é preciso
      até a retomada, e sem ele não há entrada nenhuma, qualquer que seja a
      rota que o painel tenha gerado:

      ```bash
      docker stop <container-web>
      ```

   2. **Confira as labels** dos containers recriados. Nenhum pode ter regra
      `traefik.http.routers`, porque o Coolify pode gerar um domínio padrão
      quando o do serviço está vazio:

      ```bash
      docker inspect <container-web> <container-api> --format '{{.Name}} {{json .Config.Labels}}' | grep -i 'traefik.http.routers' && echo 'ROTA ENCONTRADA'
      ```

      **Rota encontrada é incidente:** o Veyra pode ter ficado alcançável entre
      o fim do deploy e o novo stop do `web`. **Pare imediatamente o container
      que tiver a rota**, inclusive a `api`, e só então registre e investigue,
      antes de seguir.

   3. **Confira de fora outra vez** (o mesmo `curl` do passo 2: nada de 2xx).
   4. A saúde se confere por dentro:

      ```bash
      docker exec <container-api> curl -fsS http://127.0.0.1:3001/api/health
      ```

   O código antigo não volta a rodar. **Se o Deploy falhar**, não rode as
   migrations nem religue o container antigo: **permaneça em manutenção**, com
   o acesso bloqueado, até definir uma recuperação compatível (§5).

5. **Migrations**, no container novo da API (como na §3.5), e a conferência do
   preenchimento. O deploy recria o container: releia o nome dele antes
   (`docker ps --format '{{.Names}}' | grep -i veyra`, como na §3.6). Entre as
   migrations estão `20261021090000_message_dispatch_ai_origin` e o
   preenchimento `20261021090100_message_dispatch_ai_origin_backfill`:

   ```bash
   docker exec -it <container-api> npx prisma migrate status
   docker exec -it <container-api> npx prisma migrate deploy
   ```

   O `status` lista as pendentes antes. **Se o `deploy` falhar**, siga "Falha
   de migration" (acima), ainda em manutenção: nada de marcar `rolled-back` e
   repetir às cegas.

   ```sql
   -- precisa dar 0: despacho pendente de rascunho da IA sem a origem de IA
   SELECT count(*) FROM "MessageDispatch" d
    WHERE d."state" IN ('reserved', 'failed_before_send', 'sending')
      AND d."fromAiProposal" = false
      AND EXISTS (SELECT 1 FROM "AuditLog" a
                   WHERE a."workspaceId" = d."workspaceId"
                     AND a."entityType" = 'message'
                     AND a."entityId" = d."messageId"
                     AND a."action" = 'message.created_from_ai_proposal');
   ```

   Em seguida, a contagem da transição (G4), que só funciona com as colunas da
   G3.2 já criadas e a origem já preenchida:

   ```sql
   -- despachos pendentes de origem da IA ANTERIORES à G3.2: cobertura limitada
   -- (sem a fotografia da aprovação; reconferem só o contato da conversa).
   -- Conte-os à parte; a mensagem livre de pessoa não entra
   SELECT count(*) FROM "MessageDispatch" d
     JOIN "Message" m ON m."workspaceId" = d."workspaceId" AND m."id" = d."messageId"
    WHERE d."state" IN ('reserved', 'failed_before_send', 'sending')
      AND d."approvalContactIds" IS NULL
      AND (m."authorType" = 'ai' OR d."fromAiProposal");
   ```

   Esses despachos não são tratados como conferidos com a fotografia da
   aprovação; a verificação de transição da G4 os conta à parte.

6. **A cadeia de proxies**: os prazos de leitura de todos os proxies à frente do
   `web` (G3.1, acima). Os 120 s do proxy não mudam os 60 s do provedor.
7. **Retomar.** No painel, volte `DISABLE_JOBS=false`, **devolva o domínio do
   `web`** e faça o **Redeploy** do mesmo commit, que sobe o `web` de novo. Depois,
   `curl -fsS https://$VEYRA_HOST/api/health`. Só então o acesso, os envios e
   as entregas voltam, já sob a regra nova, e a reconciliação da subida examina
   os usos `authorized`.

**Resíduo da barreira de acesso.** Entre o fim do deploy do passo 4 e o novo
stop do `web`, se o Coolify tiver gerado uma rota padrão, o `web` fica
alcançável por segundos. A conferência das labels detecta o caso, mas não o
evita. **Por isso o deploy está bloqueado** (aviso no início desta seção) até a
barreira contínua existir. As opções são um modo de manutenção na própria
aplicação, que recuse toda requisição externa enquanto ligado, como
`DISABLE_JOBS` faz com os workers, ou uma barreira externa independente e
comprovada.

**Cobertura limitada dos despachos antigos.** Os despachos aprovados antes da
G3.2 têm `approvalContactIds` nulo: reconferem só o contato atual da conversa.
O preenchimento lhes dá a origem de IA, mas não a fotografia da aprovação. Não
os trate como conferidos com ela; a verificação de transição da G4 os conta à
parte.

## 5. Rollback

**Voltar a um commit anterior não é rollback seguro desde a guarda de uso
externo** (ADR-047 adendo 7 §9; decisão do usuário, 2026-10-21). Um código
anterior às proteções novas faz o que a guarda passou a impedir:

- gera com IA, envia mensagem e entrega webhook sem registro, sem travas e sem
  reconferência;
- deixa o rascunho editado sair sem a origem de IA;
- grava despachos sem a origem nem os contatos da aprovação.

O Coolify guarda os deploys anteriores, mas o **Redeploy** de um commit anterior
só vale para um commit que tenha **as mesmas proteções** e seja compatível com o
schema aplicado. Por isso o recurso aponta para tag/commit, nunca para `main`.

**Em falha, permaneça em manutenção.** Desde o ADR-053, a manutenção é a
barreira da própria API: `MAINTENANCE_MODE=true`, que barra toda requisição
com 503 e não sobe os jobs, mais o `web` parado e o domínio retirado. Ela entra
como na etapa C do §14: os containers parados antes de tudo, e a imagem
protegida, que já sobe em manutenção, por um **Deploy**. Só saia dela quando a
recuperação compatível estiver definida:

- uma correção para frente, num commit novo com as proteções;
- ou a restauração do banco (§6), seguida de um código com as proteções que
  seja compatível com ele.

Religar o container antigo para "voltar ao ar" reabre a regra antiga e não é
recuperação. **Voltar à barreira é sempre um Deploy** do mesmo commit com
`MAINTENANCE_MODE=true`, seguido de parar o `web`. Nunca Start, Restart nem
Rollback do Coolify: o container guarda o ambiente de quando foi criado (talvez
com `false`), e o Rollback volta a uma imagem anterior, talvez de antes do
ADR-053, que ignora a variável.

**Migration não tem rollback automático, e isto é deliberado**: `migrate deploy`
não desfaz. Se uma migration falhar ou deixar o banco num estado que o código
com as proteções não aceita, a volta é pela restauração de banco (§6), sempre
em manutenção e seguida de um código com as proteções. Por isso todo deploy
com migration começa pelo snapshot da janela, com a escrita já congelada,
conferido por inteiro (§14, passo C2). O `backup.sh` sob demanda não serve para
isso: ele aplica a retenção, e o snapshot dele não é marcado como o da janela.

## 6. Backup e restauração

O backup roda diariamente às `BACKUP_AT` (UTC) num container próprio: dump
lógico do Postgres + storage, cifrados pelo restic, para um destino **externo à
VPS**. Backup no mesmo disco que ele protege não é backup.

Pelo terminal do Coolify, no container `backup`:

```bash
/usr/local/bin/backup.sh            # sob demanda
/usr/local/bin/restore.sh listar    # o que existe no destino
```

**A restauração do banco é sempre num banco NOVO, trocado pelo nome**
(ADR-046 adendo 1). O `restore.sh` nunca restaura sobre o banco vivo: recusa o
nome dele e o de qualquer banco que já exista, cria o banco novo e restaura
numa transação só. Restaurar por cima de um banco já migrado falharia sempre,
porque as tabelas novas têm FK para as do dump, ou deixaria objetos que o dump
não conhece. Restaurar é manutenção, do começo ao fim.

**Um snapshot anterior ao congelamento desfaz o que veio depois dele,**
inclusive o que protege o acesso: sessões revogadas (`RefreshToken` e
`tokenVersion`), memberships removidas ou desativadas, senhas trocadas e
exclusões de dados (LGPD). O mesmo vale para o storage, que traz de volta
arquivos apagados. No staging, com dados fictícios, a restauração prevista é a
do snapshot da janela (§14), tirado com a API parada: a diferença é zero.
Restaurar um snapshot mais antigo exige, antes da retomada, revogar todas as
sessões e reaplicar o que foi revogado ou excluído depois dele. Esse
procedimento ainda não existe nem foi ensaiado (dívida registrada, com
gatilho, em `docs/MEMORY/technical-debt.md`), e até lá não se restaura snapshot
antigo com acesso de pessoas reais.

Antes do passo 2, confira o espaço livre no host (`df -h /var/lib/docker`). A
restauração cria uma segunda cópia inteira do banco no mesmo cluster, e disco
cheio derruba também o banco vivo.

No host, com os nomes reais que você anotou na §3.6:

1. **A barreira** (§14, passo C1): `MAINTENANCE_MODE=true` e
   `DISABLE_JOBS=true` no painel, o domínio do `web` retirado, e
   `docker stop <container-web> <container-api>`. O `db` e o `backup` seguem
   de pé. De fora, nenhum 2xx em `/api/`.
2. **Restaure num banco novo.** O nome só aceita `a-z`, `0-9` e `_`:

   ```bash
   docker exec <container-backup> /usr/local/bin/restore.sh banco <snapshot-id> <banco>_restaurado_<AAAAMMDD>
   ```

   Em qualquer falha (dump truncado, erro do `restic` ou do `pg_restore`), o
   banco novo é descartado, e o vivo não foi tocado.

3. **Confira o banco novo antes de trocar:** as contagens do PO-2 (§14) e, para
   o snapshot da janela, as anotadas no passo C2. Contagens iguais são uma
   conferência a mais, não prova de equivalência.

   ```bash
   docker exec <container-db> sh -c 'psql -U "$POSTGRES_USER" -d <banco>_restaurado_<AAAAMMDD> -Atc "SELECT count(*) FROM _prisma_migrations" -Atc "SELECT max(migration_name) FROM _prisma_migrations" -Atc "SELECT count(*) FROM pg_constraint" -Atc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal" -Atc "SELECT count(*) FROM \"Workspace\"" -Atc "SELECT count(*) FROM \"User\""'
   ```

4. **Troque pelo nome, numa transação só,** conectado ao `postgres`, nunca ao
   banco que vai ser renomeado. O banco antigo fica guardado para diagnóstico,
   e só sai com autorização, depois de o INC fechar:

   ```bash
   printf '%s\n' \
     "SELECT count(pg_terminate_backend(pid)) AS encerradas FROM pg_stat_activity WHERE datname = :'vivo' AND pid <> pg_backend_pid();" \
     'BEGIN;' 'ALTER DATABASE :"vivo" RENAME TO :"falho";' 'ALTER DATABASE :"novo" RENAME TO :"vivo";' 'COMMIT;' \
     | docker exec -i <container-db> sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v vivo="$POSTGRES_DB" -v novo=<banco>_restaurado_<AAAAMMDD> -v falho=<banco>_falho_<AAAAMMDD>'
   ```

   O SQL vai por `printf`, e não por heredoc: copiado com a indentação do
   roteiro, o terminador de um heredoc não fecharia.

   Se alguém reconectar entre o encerramento e a troca, o `ALTER` falha ("is
   being accessed by other users"), e a transação desfaz as duas trocas: rode
   de novo. Nenhum momento fica sem um banco com o nome do vivo.

5. **Volte pela etapa C do §14, a partir do passo 5:** o **Deploy** do commit
   com as proteções, com `MAINTENANCE_MODE=true`; as migrations pendentes,
   pelo estado real; as conferências; e só então a retomada (etapa E).

**Nunca `docker start` nos containers antigos.** O `web` antigo ainda carrega
as labels do Traefik com o domínio, e religá-lo reabre a rota no meio da
manutenção. A API antiga sobe com o ambiente de quando foi criada, talvez com
`MAINTENANCE_MODE=false`, ou de um commit anterior ao ADR-053, que ignora a
variável (§5).

**A restauração do storage.** O volume é montado somente-leitura no `backup`,
então a cópia de volta vai por um container temporário, com o volume real
montado para escrita (os nomes saem da §3.6). As credenciais do destino vêm do
próprio container `backup`, por `--env-file`, sem passar pelo histórico do
shell. O `restic` recria o caminho original (`data/storage`) dentro do destino:
por isso a restauração vai para um diretório temporário e é copiada para a raiz
do volume. A mesma regra de manutenção vale aqui: comece pelo passo 1 acima,
com o serviço parado, e volte pelo passo 5. No bash do host:

```bash
IMG=$(docker inspect <container-backup> --format '{{.Config.Image}}')
docker run --rm --user 0 -v <volume-storage>:/alvo \
  --env-file <(docker exec <container-backup> env | grep -E '^(RESTIC_REPOSITORY|RESTIC_PASSWORD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=') \
  "$IMG" sh -c 'restore.sh storage <snapshot-id> /tmp/r && cp -a /tmp/r/data/storage/. /alvo/'
```

Os arquivos mais novos que o snapshot continuam no volume, sem linha no banco
restaurado.

**Teste a restauração antes de precisar dela,** sempre fora do staging: o
ensaio de restaurabilidade é o PO-2 do §14, num Postgres descartável e sem
rede. Um ensaio trimestral é o que distingue backup de esperança.

**As falhas, desde o ADR-046 adendo 1:**

- **O backup:**
  - o repositório só é inicializado quando não existe (código 10 do `restic`); a senha errada (12), o destino fora do ar ou um lock são falha, nunca um `init` por cima;
  - o dump vai pelo próprio `restic` (`--stdin-from-command`), que não grava snapshot se o `pg_dump` falhar, nem no meio do fluxo;
  - um storage com arquivo ilegível faz o `restic` gravar um snapshot incompleto (código 3): ele é removido pelo id, e o ciclo falha;
  - uma falha encerra o ciclo sem mensagem de sucesso e sem a retenção;
  - cada ciclo do agendador é um processo próprio (`/bin/sh backup.sh`): a falha fica no log como "ciclo falhou (código N)", e o próximo horário tenta de novo;
  - a retenção mantém os snapshots com a tag `janela` (`--keep-tag janela`), que saem à mão;
  - o cálculo da espera lê os campos do relógio sem o zero à esquerda: antes, `08` e `09` (octais inválidos no shell) derrubavam o laço nesses horários.
- **`backup.sh --ciclo`** roda um ciclo como o agendador e sai sempre com 0: a falha fica só no log. Para conferir à mão, use `backup.sh` sem argumento, que devolve o código.
- **A restauração** é num banco novo e numa transação só: um dump truncado, um erro do `restic` (mesmo depois de entregar o fluxo inteiro) ou do `pg_restore` descartam o banco novo, e o vivo não é tocado.
- **Um `restic dump` interrompido deixa um lock no repositório.** Quando quem lê o fluxo para antes do fim (um `pg_restore` que sai no começo, um `head`), o `restic` morre sem soltar o lock, e a retenção do ciclo seguinte falha com "repository is already locked". O ciclo falha de forma visível, mas os seguintes também falham, até o lock sair. A recuperação, ensaiada na imagem: `docker exec <container-backup> restic unlock`, sem `--remove-all`. Ele remove só os locks velhos, inclusive o de um processo que já terminou no mesmo container. Nunca use `--remove-all` com um ciclo em curso.
- **Os testes de falha** rodam na imagem do próprio Dockerfile, com um Postgres e um repositório descartáveis, no Docker local. As falhas são provocadas por comandos substitutos no `PATH` da imagem (o `pg_dump` que cai no meio, o `restic` que falha só no `backup` ou que sai com erro depois do fluxo, o `sleep` do agendador que não dorme):

  ```bash
  sh deploy/staging/backup/testes/falhas.sh   # termina com TESTES_DE_FALHA_OK
  ```

## 7. Operação do dia a dia

**A WABA do canal não muda na rotação do token** sem `--trocar-waba`
(`channel:whatsapp`, F4.1c-2): as versões de template ficam presas à WABA de
onde saíram, e trocá-la diverge todas na próxima releitura, que pedem cadastro e
revisão de novo. Um erro de digitação ali custaria isso. Desde a F4.4c (ADR-048
adendo 13), o cadastro é uma CLI compilada, na imagem (`node
dist/cli/channel-whatsapp.js` no container da `api`), e a recusa tem teste de
integração.

```bash
# logs (json-file, 10 MB × 5 por container — rotação no próprio Docker)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml logs -f api
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml logs --since 1h backup

# saúde
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml ps
curl -fsS https://$VEYRA_HOST/api/health

# console do banco (nunca exposto para fora)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"

# CLIs administrativas (plano, canal, provisionamento)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml exec api node dist/cli/provision.js --help
```

### 7.1 Veyra Clinics: fica DESATIVADO em staging

A imagem já traz o vertical composto (ADR-047 adendo 3), mas ele só existe num
workspace depois da CLI de ativação. **Não rode `enable` em staging.** Ativar
lá, ou usar dados reais, segue bloqueado pelas hipóteses H1–H7 e pelos
bloqueios B1–B4 do ADR-048. Os comandos ficam aqui para quando houver
autorização explícita:

```bash
# NÃO EXECUTAR em staging sem autorização registrada
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  exec api node dist/verticals/clinics/cli/clinics.js enable  --slug <slug>
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  exec api node dist/verticals/clinics/cli/clinics.js disable --slug <slug>
```

O que `enable` faz, e não se desfaz sozinho:

- todo contato do workspace passa a ser restrito para IA;
- **webhooks ativos deixam de receber qualquer evento de contato**, inclusive
  exclusões (a CLI diz quantos são);
- **desativar não levanta a restrição, nunca.** A própria linha de ativação
  (`ClinicsSettings`) conta como presença do vertical e não é apagada por
  nenhum comando. A restrição só deixa de existir com a exclusão do workspace
  (ADR-047 §4). Ativar "só para testar" é irreversível neste sentido.

Para conferir que nenhum workspace foi ativado:

```bash
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT count(*) FROM "ClinicsSettings"'
```

O resultado esperado é `0`.

**Conferência do contador de sessões dos pacotes (ADR-048 adendo 7, F3.1).** O
`CHECK` do banco garante só o intervalo das consumidas. A igualdade com os
atendimentos vinculados vem do caminho único de escrita e dos triggers. Esta
consulta precisa dar 0; outro valor é incidente:

```sql
SELECT count(*) FROM "ClinicsPackage" p
 WHERE p."consumedSessions" <> (SELECT count(*) FROM "ClinicsAttendance" a
                                 WHERE a."workspaceId" = p."workspaceId"
                                   AND a."packageId" = p."id");
```

### 7.2 Outbox: nunca editar, reabrir nem copiar evento por SQL

O banco recusa tirar um evento de `delivered` ou `dead` (trigger
`OutboxEvent_terminal_is_final`). **Não contorne isso com INSERT.** Uma cópia
manual de evento nasceria sem a fotografia de contatos e fora da validação do
`enqueue`, e poderia entregar a um webhook conteúdo de contato restrito
(SECURITY §7-B). Reenvio manual não existe; criar um exige ADR.

## 8. Desmontar só o Veyra

Pelo painel: **Stop** preserva os volumes; **Delete** do recurso remove os
containers e pergunta sobre os volumes.

Nunca `docker system prune -a` nesta máquina: ele alcança VerboPlus e Norteie.

## 9. Validação local desta pilha

Antes de encostar na VPS, a pilha inteira foi construída e exercitada nesta
mesma configuração (projeto e volumes próprios, publicando só em loopback):
imagens construídas do zero, migrations aplicadas de dentro do container,
catálogo semeado, workspace provisionado pela CLI da imagem de produção,
`/healthz` e `/api/health` respondendo pelo nginx de entrada, e **um ciclo
completo de perda e restauração**: workspace apagado do banco, restaurado do
snapshot, de volta com o catálogo íntegro.

Repita quando mexer em Dockerfile ou no backup:

> **`--project-directory .` é obrigatório.** Os contextos de build são relativos
> à RAIZ do repositório, porque é assim que o Coolify roda o compose. Sem essa
> opção, o Docker resolve a partir da pasta do arquivo e o build falha com
> "Dockerfile not found".

```bash
cd <raiz-do-repo>
C="docker compose --project-directory . --env-file <seu-env-local> -p veyra-local -f deploy/staging/docker-compose.yml"
$C build
$C up -d db
$C run --rm --no-deps api npx prisma migrate deploy
# ... e o ciclo de restauração da §6, que é o único jeito de saber que o backup presta
```

## 10. O que staging NÃO faz

- **Não envia WhatsApp de verdade.** `META_TRANSPORT_MODE=fake` (depende do ADR
  proposto — enquanto ele não existir, staging fica sem credencial de canal e o
  envio falha com `no_credential`, que também não vaza nada para fora).
- **Não tem o Veyra Clinics ativado** (§7.1).
- **Não recebe dado real de paciente.** É regra de operação, não técnica: quem
  colar um export de produção aqui quebra a premissa do ambiente.
- **Não é referência de desempenho.** Divide CPU e disco com os outros projetos.

## 11. Se um dia sair do Coolify

O mesmo arquivo serve aos dois modos. Para rodar por compose puro são três
acréscimos, e o runbook anterior a esta versão está no histórico do Git
(commit `d7275f0`).

### 11.1 O que acrescentar

1. **Roteamento**: labels de Traefik no serviço `web` (`Host(...)`,
   entrypoints `http`/`https`, `certresolver=letsencrypt`,
   `loadbalancer.server.port=8080`) mais `traefik.docker.network=coolify`, e a
   rede externa `coolify` no serviço e no bloco `networks`.
2. **Nomes estáveis**: `name: veyra-staging` no topo e `name:` em cada volume,
   já que não haverá o prefixo do Coolify.
3. **Faixa de IP**: `ipam` com `172.28.7.0/24`, fora da sequência 10.0.x.

### 11.2 Segredos em arquivo, mesmo dentro do Coolify

Se você preferir manter a regra original — segredo só em
`/opt/veyra-staging/.env`, `root`, `0600` — dá para fazer híbrido: acrescente
`env_file: [/opt/veyra-staging/.env]` aos serviços `api` e `backup` e deixe no
painel apenas o que não é segredo. O Coolify roda `docker compose` no host, e o
caminho absoluto resolve.

O preço: o painel deixa de mostrar a configuração completa, e quem for depurar
precisa saber que metade dela está num arquivo. Escolha entre superfície de
acesso (painel) e transparência de operação — não há resposta certa, e a
decisão deve ficar registrada aqui quando você tomá-la.

## 12. Registro de incidentes

### INC-2026-10-26-01 — staging fora do ar (aberto)

- **Detecção:** pelo usuário, no navegador, por volta das 18:30 (-03) de
  2026-10-26: `https://veyra-staging.malachdigital.com.br` responde
  `no available server`.
- **O que a sondagem externa mostra** (só leitura, de fora da VPS, às 18:33 e
  às 19:55):
  - `GET /` e `GET /api/health` dão **503** `no available server`, em 35 a
    160 ms;
  - o DNS aponta para a VPS (77.37.43.5), e o certificado é válido (Let's
    Encrypt, até 2027-01-24).

  Ou seja: a VPS e o Traefik respondem, e a rota do domínio existe, mas o
  Traefik não tem nenhum container saudável para ela.

- **Causa:** não identificada. O agente não tem acesso à VPS nem ao painel, e
  o diagnóstico interno depende de quem tem. As hipóteses, sem ordem
  comprovada:
  - o `web` ou a `api` parados ou reprovados no healthcheck (o `web` só sobe
    com a `api` saudável);
  - um deploy que tenha subido código novo sem as migrations, se o recurso
    estiver na `main` com deploy automático (o §4 pede o recurso fixado num
    commit);
  - falta de recurso na VPS compartilhada.
- **Autorizado (decisão do usuário, 2026-10-26):** só diagnóstico de leitura —
  quais serviços estão parados, os erros e a versão implantada. **Não
  autorizado:** reiniciar, implantar, aplicar migrations ou alterar o proxy
  compartilhado. Continuam bloqueados deploy, ativação do Clinics, envio real
  e dados reais.
- **O diagnóstico de leitura**, para quem tem acesso ao host (nada aqui
  reinicia ou altera; confira a saída antes de compartilhar):

  ```bash
  # estado, saúde, reinícios, imagem e quando subiu cada container do Veyra
  for c in $(docker ps -a --format '{{.Names}}' | grep -i veyra); do
    docker inspect "$c" --format '{{.Name}} | {{.State.Status}} | saude={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} | reinicios={{.RestartCount}} | desde={{.State.StartedAt}} | saiu={{.State.FinishedAt}} cod={{.State.ExitCode}} | {{.Config.Image}}'
  done
  # as últimas saídas do healthcheck
  for c in $(docker ps -a --format '{{.Names}}' | grep -i veyra); do
    echo "== $c"; docker inspect "$c" --format '{{if .State.Health}}{{range .State.Health.Log}}{{.End}} rc={{.ExitCode}} {{printf "%.200s" .Output}}{{"\n"}}{{end}}{{end}}' | tail -3
  done
  # recursos do host
  uptime; free -h; df -h / /var/lib/docker 2>/dev/null
  # só as linhas de erro da api e do web nas últimas 24 h
  for c in $(docker ps -a --format '{{.Names}}' | grep -i veyra | grep -iE 'api|web'); do
    echo "== $c"; docker logs --since 24h "$c" 2>&1 | grep -iE 'error|fatal|exception|unhealthy|prisma|P[0-9]{4}|migrat|ECONN' | tail -20
  done
  ```

  No painel do Coolify: o histórico de **Deployments** do recurso (houve deploy
  em 2026-10-26? de qual commit?) e se o **Auto Deploy** está ligado. A versão
  implantada é o commit do último deploy concluído. Com o banco no ar, a
  última migration aplicada também é lida sem alterar nada:
  `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 3;`.

- **Próximo passo:** com a saída acima, identificar a causa e propor a
  recuperação, que depende de nova autorização. Se a causa for código novo com
  schema antigo, vale a regra da manutenção: a imagem anterior não é rollback,
  e o acesso continua bloqueado até a recuperação definida.

## 13. Pendências da demonstração da F4 (preparadas em 2026-10-27; nada executado)

O marco do usuário: concluir a F4 e pôr uma demonstração funcionando, com dados fictícios, para ele acessar. Esta seção prepara o que falta. **Nada aqui está autorizado:** deploy, ativação do Clinics, envio real e dados reais continuam bloqueados, e o staging segue fora do ar (INC-2026-10-26-01).

**1. Antes de qualquer deploy:**

- **O incidente do staging:**
  - o diagnóstico de leitura do §12 precisa ser feito por quem tem acesso ao host;
  - a recuperação depende de nova autorização;
  - sem a versão implantada e a última migration aplicada, não há como planejar o deploy.
- **As migrations da F4, na ordem** (cada uma conforme o §4, com o inventário e o ensaio):
  - `20261023120000_conversation_sender_and_phone_identity` (F4.1a), com a `ADDRESS_LOCK_KEY` e os passos do `phones:normalize` e do `identity:diagnose`;
  - `20261026120000_consents_and_stop_block` (F4.1b);
  - `20261026150000_dispatch_canceled` (F4.1c-1);
  - `20261026200000_template_versions` (F4.1c-2);
  - `20261027120000_business_outbound` (F4.1c-3);
  - `20261028120000_business_outbound_vertical_origin` (F4.2, a parte do Core);
  - `20261028150000_clinics_outreach` (F4.2, a parte do Clinics);
  - `20261028200000_clinics_deal_link_and_confirmation` (F4.3);
  - e as que a F4.4 trouxer.
- **As variáveis novas, no ambiente ANTES do deploy:** a `ADDRESS_LOCK_KEY` e a `OUTBOUND_APPROVAL_KEY`, independentes e estáveis. `META_TRANSPORT_MODE=fake` e `VEYRA_ENV=staging` continuam.

**2. O que a demonstração ainda não tem, e precisa de decisão ou código:**

- **Os templates fictícios (F4.4b, ADR-048 adendo 12, item 2):** o catálogo falso do staging traz os templates `demo_*` de `src/demo/catalogo-da-demonstracao.ts`, na WABA fictícia `000000000000100`, e só responde a ela. O procedimento `templates:demo --slug <ws> --channel <id> --reviewer <e-mail>` cadastra e revisa as versões pelos serviços de sempre, depois das finalidades (`consents:purpose`). Na imagem, ele roda como as outras CLIs compiladas (`node dist/cli/templates-demo.js`).
  - **O cadastro do canal** (`channel:whatsapp`) é, desde a F4.4c (ADR-048 adendo 13), uma CLI compilada, na imagem: `node dist/cli/channel-whatsapp.js`, com o token pela entrada padrão. Os dados clínicos fictícios vêm do `demo:carregar` (`node dist/verticals/clinics/cli/demo-carregar.js`), pelos serviços do domínio.
  - **Antes de o staging voltar ao transporte da Graph,** as versões `demo_*` precisam sair de uso (hoje nada sairia: a releitura contra a WABA fictícia falha fechada).
- **As telas:** as do Clinics (os envios, o vínculo com a oportunidade e as métricas, com o aviso de envio simulado) estão publicadas (F4.4, `be288bf`). As do consentimento e do pedido de parar (a ficha do contato e a conversa do Inbox) são da F4.4b, e a conciliação da aprovação repetida também. O compositor do Inbox com o template voltou na F4.1c-3 e mostra o aviso de envio simulado.
  - **A tela de revisão de template fica fora da demonstração (decisão do usuário, 2026-10-29):** a revisão dos templates fictícios é do procedimento `templates:demo`.
- **O fluxo do Clinics (F4.2 e F4.3):** a confirmação e a reativação são do vertical. A demonstração delas exige a ativação do Clinics no workspace da demo, que hoje está bloqueada e precisa de autorização própria, mesmo com dados fictícios.
- **Os dados fictícios da demo:**
  - o workspace;
  - os contatos com números inventados;
  - as finalidades (CLI);
  - os consentimentos, registrados pela tela;
  - os templates do catálogo fictício e as revisões (`templates:demo`);
  - o Owner (`aurelioromeu@outlook.com`, workspace `staging`).

  O E2E prova esse caminho numa pilha própria, com o transporte e o catálogo falsos e o worker ligado: o consentimento pela tela, a prévia, a aprovação e o acompanhamento até "Enviado (simulado)" (`e2e/tests/demonstracao.spec.ts`, preparado por `e2e/demo/preparar.ts`).

  Nenhum número real: o transporte falso não envia, mas o número ainda é dado pessoal.

**3. O que não muda na demonstração:** o transporte é falso, e nada sai para a Meta. A Meta real, a WABA, os templates aprovados e o opt-in real são da F4.5.

**4. O plano da demonstração (2026-10-28; substituído pelo §14 em 2026-10-29).** O roteiro executável, com as correções do usuário e os pontos de parada, está no §14. O texto abaixo fica como histórico.

Na ordem, cada passo com a própria autorização:

1. **O diagnóstico do staging** (§12): quem tem acesso ao host roda o diagnóstico de leitura; com a causa, a proposta de recuperação.
2. **A manutenção do deploy:**
   - a imagem da árvore final da F4, fixada no commit;
   - as variáveis novas no ambiente antes;
   - as migrations da F4 na ordem do item 1, cada uma com o inventário;
   - a manutenção com tudo parado onde o runbook pede (a da F4.1a).

   A imagem anterior não é rollback.

3. **Os templates fictícios,** pela decisão do ADR-052 (fim), implementados na F4.4b (ADR-048 adendo 12):
   - o arquivo versionado na imagem, com templates `demo_*` de ids inventados e a WABA fictícia;
   - o arquivo é lido pelo catálogo falso só com o transporte falso e `VEYRA_ENV=staging`;
   - o procedimento `templates:demo` cadastra e revisa as versões no workspace da demonstração, explícito pelo slug, em nome de um revisor com `templates:review`;
   - nada aparece em outro workspace, nada cria consentimento, e nada toca a Meta.
4. **A ativação do Clinics no workspace da demonstração,** com dados fictícios: os pacientes, a agenda, as finalidades (CLI) e os consentimentos registrados na tela, com números inventados.
5. **As telas da F4.4** que a demonstração usa, e o acesso do Owner.

**5. O que falta para o usuário acessar o sistema (acompanhamento; atualizar a cada entrega).** Nenhum item abaixo autoriza execução: cada passo no staging tem autorização própria. Nada novo entra no caminho da demonstração.

| Frente                                    | Situação                                                                  | O que falta                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Funcionalidades**                       | F4.1 a F4.4c publicadas e validadas (a F4.4c em `c378367`, CI verde)      | em commit local: a barreira de manutenção (PO-1, ADR-053) e o backup e a restauração que falham de verdade (PO-3, ADR-046 adendo 1) |
| **Templates falsos**                      | publicados na F4.4b (ADR-048 adendo 12)                                   | o canal fictício (CLI compilada), as finalidades e o `templates:demo` no workspace `demo`: §14, etapa D                             |
| **Dados fictícios**                       | o `demo:carregar` (F4.4c, em commit local)                                | rodar no workspace `demo`: §14, etapa D; os consentimentos, pela tela                                                               |
| **Manutenção do deploy**                  | o roteiro consolidado no §14 (os pré-requisitos PO-1 a PO-3 e a janela C) | a barreira contínua (PO-1), o ensaio de restauração isolado (PO-2) e a janela (C), cada um com autorização                          |
| **Diagnóstico do staging**                | INC-2026-10-26-01 aberto; o bloco curto enviado ao usuário                | a saída do diagnóstico (§14, etapa A) e a proposta de recuperação                                                                   |
| **Ativação do workspace de demonstração** | decidida: workspace dedicado `demo` (decisão de 2026-10-29)               | executar na etapa D do §14, com autorização                                                                                         |

## 14. Plano operacional da demonstração (2026-10-29; nada executado)

Consolida o §13 com as correções do usuário e das revisões de 2026-10-29. Cada etapa termina num **ponto de parada**: a autorização de uma etapa cobre os comandos dela e nada além, sem aprovação comando a comando. Continuam fora: envio real, dados reais e a F4.5.

**Os princípios:**

- **Em falha, a manutenção continua.** Voltar a imagem anterior não é recuperação, e restaurar o backup também não basta. A recuperação é uma de duas:
  - a restauração compatível com o código que vai rodar e com as proteções dele (§5 e §6);
  - uma correção para frente.

  Até ela existir, a barreira fica.

- **A barreira é contínua,** do primeiro passo da janela até a retomada. Parar a ingestão e os jobs não bloqueia o acesso.
  - Hoje, a barreira é parar os containers e tirar o domínio. O deploy recria os containers, e o Coolify pode gerar uma rota padrão por alguns segundos (§4, "Resíduo da barreira de acesso").
  - É por isso que o deploy está bloqueado desde 2026-10-21, e é isso que o PO-1 (ADR-053) resolve.
  - **Uma imagem anterior ao PO-1 ignora o `MAINTENANCE_MODE`.** Durante a janela, nunca faça Redeploy de um commit anterior: ele tiraria a barreira em silêncio.
- **As migrations pendentes saem do estado real do banco e do commit final,** e não de uma lista fixa. A lista do §13, item 1, é só o que se espera encontrar.
- **As chaves novas só nascem se estiverem ausentes,** no painel e no container. Uma chave existente não é trocada sem avaliar o que depende dela.
- **O ensaio de restauração é num banco isolado,** sem rede, e nunca no banco do staging. A janela confere o próprio snapshot antes do deploy.

**As ferramentas, por lugar** (o que cada passo usa):

- **Container `api`** (a imagem de runtime): `node`, `npx --no-install prisma` (é dependência de produção), `curl` e as CLIs compiladas em `dist/`:
  - `cli/provision.js`;
  - `cli/consent-purpose.js`;
  - `cli/channel-whatsapp.js`;
  - `cli/templates-demo.js`;
  - `cli/phones-normalize.js`;
  - `cli/identity-diagnose.js`;
  - `cli/check-cross-tenant-fk.js` (a varredura de FKs, só de leitura);
  - `verticals/clinics/cli/clinics.js`;
  - `verticals/clinics/cli/demo-carregar.js`.

  Há também `seed-permissions.js` e `templates-register.js`, que este plano não usa. Não há `pnpm`, `tsx` nem `psql`. Os comandos do §4 escritos com `pnpm` viram `node dist/...` aqui.

- **Container `db`:** `psql` e `wget` (busybox), com as credenciais do próprio container (`sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`).
- **Container `backup`:** `backup.sh`, `restore.sh`, `restic` e `pg_restore` 17.
- **Host** (o terminal do **servidor** no Coolify, não o do container): `docker` e `openssl`.

### Etapa A — Diagnóstico e preservação (só leitura, já autorizada)

Os logs inteiros ficam guardados antes de qualquer recuperação. Nenhum comando imprime segredo: das variáveis, só aparecem com valor o modo do transporte, o ambiente, o `DISABLE_JOBS` e o `MAINTENANCE_MODE` (ausente na imagem atual); as chaves, só pelo nome. Os `.log` ficam no host, com acesso só do root: não são compartilhados (só trechos conferidos) e saem quando o INC fechar.

```bash
# A1. preserva e lista os containers (nome | projeto | serviço | estado | imagem | criado)
D=/root/veyra-inc-2026-10-26; umask 077; mkdir -p "$D"; chmod 700 "$D"; date -u > "$D/quando.txt"
docker ps -a --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}|{{.Status}}|{{.Image}}|{{.CreatedAt}}' | tee "$D/containers.txt" | grep -iE 'veyra|api|web|db|clamav|backup'
```

```bash
# A2. com o projeto do Veyra copiado da saída acima
P='COLE-AQUI-O-PROJETO'; D=/root/veyra-inc-2026-10-26; umask 077
for c in $(docker ps -a --filter "label=com.docker.compose.project=$P" --format '{{.Names}}'); do
  docker logs --timestamps "$c" > "$D/$c.log" 2>&1
  docker inspect "$c" --format '{{.Name}} | {{.State.Status}} | saude={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} | reinicios={{.RestartCount}} | desde={{.State.StartedAt}} | saiu={{.State.FinishedAt}} cod={{.State.ExitCode}} oom={{.State.OOMKilled}} | {{.Config.Image}}'
  grep -iE 'error|fatal|exception|unhealthy|P[0-9]{4}|migrat|ECONN' "$D/$c.log" | tail -6 | cut -c1-220
done
uptime; free -h; df -h / /var/lib/docker 2>/dev/null
DB=$(docker ps --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=db" --format '{{.Names}}')
[ -n "$DB" ] && docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5" -Atc "SELECT count(*) FROM \"ClinicsSettings\""'
API=$(docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=api" --format '{{.Names}}' | head -1)
# só o NOME das chaves com valor (=.): vazia conta como ausente
docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -oE '^(ADDRESS_LOCK_KEY|OUTBOUND_APPROVAL_KEY)=.' | cut -d= -f1 | sort
docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(META_TRANSPORT_MODE|VEYRA_ENV|DISABLE_JOBS|MAINTENANCE_MODE)='
```

No painel:

- o último deploy: o commit, o status, a hora e o log, copiado;
- se o Auto Deploy está ligado;
- quais chaves existem nas variáveis do recurso. O `docker inspect` mostra o ambiente do último deploy, e o painel, o do próximo.

**Parada A:** a causa identificada e a proposta de recuperação, para autorização. Nada é reiniciado nem alterado.

### Etapa B — Os pré-requisitos operacionais, antes da janela (sem tocar o staging)

Os nomes são **PO-1 a PO-3** (pré-requisito operacional). Não confundir com os bloqueios B1–B4 do ADR-048, que são os de dados reais do Clinics e continuam como estão.

1. **PO-1. A barreira contínua de manutenção** (ADR-053; F4.4d). A variável `MAINTENANCE_MODE` é obrigatória, sem padrão: ausente ou inválida, nada sobe, e o compose recusa. Com `true`:
   - **Toda requisição à API recebe 503:** o login, o webhook da Meta, as rotas autenticadas, a rota inexistente, o OPTIONS e a saúde vista de fora. O middleware é o primeiro do `configureHttp`, antes de cookie, corpo, autenticação e banco.
   - **A única exceção é `GET /api/health` pelo socket de loopback,** sem confiar em `X-Forwarded-For`, `X-Real-IP` nem `req.ip`.
   - **Os jobs não sobem,** qualquer que seja o `DISABLE_JOBS`: nenhum worker, varredura ou reconciliação.
   - **O limite:** a barreira protege a API e a execução de tarefas, e não promete que toda URL responda 503. O `web` continua servindo o HTML estático da SPA: a tela abre, mas toda chamada à API dá 503, e nada aparece nem é feito. A conferência da janela é "nenhum 2xx em `/api/`", com a barra: `/api`, sem ela, é uma rota da SPA, e o `web` devolve o `index.html` com 200.
   - **Testado antes de o deploy depender dele:** `deploy/staging/ensaios/manutencao-com-schema-antigo.sh [migration-alvo]`. Ele sobe a API compilada em manutenção, com `DISABLE_JOBS=false` e o ambiente do staging (`NODE_ENV=production`, `VEYRA_ENV=staging`, transporte simulado), sobre um schema antigo, num banco descartável local, e prova:
     - a subida;
     - a saúde pelo loopback 200;
     - a saúde pela rede (com `X-Forwarded-For` forjado), o login e o webhook 503;
     - nenhum schema do pg-boss criado e nenhum erro no log;
     - **nenhuma leitura nem escrita de tabela** na subida e nas requisições barradas, pelos contadores do Postgres (`pg_stat_user_tables`), com uma leitura de contraste que prova que a medida registra;
     - as migrations pendentes aplicadas depois, com a API de fato parada (a porta volta a recusar);
     - sem a variável, vazia ou inválida, a API não sobe, pela `MAINTENANCE_MODE`, com prazo.

     Rodou verde até a última migration antes da F4. **Depois da etapa A, ele roda de novo com a última migration aplicada no staging.**
2. **PO-2. O ensaio de RESTAURABILIDADE em banco isolado.** Ele prova que um snapshot existente restaura inteiro, sem erro, num Postgres descartável e sem rede, e ensaia a troca pelo nome do §6, com o mesmo SQL. Não compara com a origem: o banco vivo continuou recebendo escrita depois desse snapshot, e as contagens não precisam bater. A comparação com a origem é a do snapshot da janela (C2), feita com a escrita congelada. O dump vai do `restic` direto para o `pg_restore` do ensaio, sem passar pelo disco do host, e a limpeza é garantida também em falha. No bash do host:

   ```bash
   docker exec <container-backup> sh -c 'restic snapshots --compact --tag banco'
   (
     set -euo pipefail
     limpar() { docker rm -f -v veyra-ensaio-db >/dev/null 2>&1 || true; }
     trap limpar EXIT
     # a MESMA imagem do container db (sem baixar nada), SEM rede
     IMG=$(docker inspect <container-db> --format '{{.Config.Image}}')
     docker run -d --name veyra-ensaio-db --network none -e POSTGRES_PASSWORD=ensaio "$IMG" >/dev/null
     n=0; until docker exec veyra-ensaio-db pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 120 ]; sleep 1; done
     # o "vivo" do ensaio e o banco NOVO, como no §6
     docker exec veyra-ensaio-db sh -c 'createdb -U postgres vivo && createdb -U postgres restaurado'
     docker exec <container-backup> restic dump <snapshot-id> /banco.dump \
       | docker exec -i veyra-ensaio-db pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U postgres -d restaurado
     docker exec veyra-ensaio-db psql -U postgres -d restaurado -Atc 'SELECT count(*) FROM _prisma_migrations' -Atc 'SELECT max(migration_name) FROM _prisma_migrations' -Atc 'SELECT count(*) FROM pg_constraint' -Atc 'SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal' -Atc 'SELECT count(*) FROM "Workspace"' -Atc 'SELECT count(*) FROM "User"'
     # a troca pelo nome do §6, passo 4, com o mesmo SQL
     printf '%s\n' \
       "SELECT count(pg_terminate_backend(pid)) AS encerradas FROM pg_stat_activity WHERE datname = :'vivo' AND pid <> pg_backend_pid();" \
       'BEGIN;' 'ALTER DATABASE :"vivo" RENAME TO :"falho";' 'ALTER DATABASE :"novo" RENAME TO :"vivo";' 'COMMIT;' \
       | docker exec -i veyra-ensaio-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v vivo=vivo -v novo=restaurado -v falho=vivo_falho
     test "$(docker exec veyra-ensaio-db psql -U postgres -d vivo -Atc 'SELECT count(*) FROM _prisma_migrations')" -gt 0
     echo ENSAIO_OK
   )
   ```

   Sem `ENSAIO_OK` no fim, o ensaio falhou, e a limpeza já rodou. As contagens impressas descrevem o que foi restaurado (a última migration, as restrições, os gatilhos e as linhas principais). São uma conferência a mais, não prova de equivalência nem de integridade. O mesmo caminho, com o pipe e a troca, roda nos testes de falha (`falhas.sh`) antes de chegar aqui.

3. **PO-3. O backup e a restauração que falham de verdade** (ADR-046 adendo 1; commit próprio). O `backup.sh` passa a ter:
   - o dump pelo próprio `restic` (`--stdin-from-command`), que não grava snapshot se o `pg_dump` falhar;
   - um processo por ciclo do agendador, para o `set -e` valer fora do `if`;
   - cada passo conferido, sem a retenção depois de uma falha.

   O `restore.sh` restaura sempre num banco novo, que ele cria, numa transação só: tudo ou nada, e o banco vivo nunca é alvo. A retenção mantém o snapshot da janela (`--keep-tag janela`). Os testes de falha (`deploy/staging/backup/testes/falhas.sh`) rodam na imagem do próprio Dockerfile, com um Postgres e um repositório descartáveis. **O container `backup` que estiver no ar antes do deploy ainda roda o script antigo:** por isso a janela faz o próprio dump, conferido (C2).

**Parada B:** PO-1 e PO-3 publicados, o ensaio do PO-1 repetido no ponto real do staging, e o PO-2 com `ENSAIO_OK`.

### Etapa C — A janela de manutenção (autorização própria)

1. **A barreira, antes de tudo:**
   - no painel: o Auto Deploy desligado e o recurso fixado no commit final já aqui; `MAINTENANCE_MODE=true` e `DISABLE_JOBS=true`; e o domínio do `web` retirado (`SERVICE_FQDN_WEB_8080` vazio);
   - **o horário:** a janela não cruza o `BACKUP_AT` (03:15 UTC, por padrão). O ciclo diário faria um dump no meio dela, e o `pg_dump` segura `ACCESS SHARE` em todas as tabelas, o que derruba as migrations com `lock_timeout` do passo 6;
   - **entre este passo e o deploy (passo 5), nada de Restart, Start nem Rollback do recurso:** a imagem que está lá é anterior ao PO-1 e ignora o `MAINTENANCE_MODE`. É por isso que os containers antigos são PARADOS aqui, antes do backup, e só voltam como a imagem protegida, que já sobe em manutenção: não há janela de acesso entre os dois;
   - no host, `docker stop <container-web> <container-api>`. Não use o Stop do recurso, que para o banco. O `backup` e o `db` seguem de pé;
   - de fora, nenhuma resposta 2xx:

     ```bash
     curl -sS -o /dev/null -w '%{http_code}\n' https://veyra-staging.malachdigital.com.br/api/health
     ```

2. **O backup da janela, conferido antes de seguir.** A escrita está congelada desde o passo 1: a API e o `web` estão parados, e nenhum job roda. O dump é feito à mão, porque o container `backup` no ar ainda roda o script antigo, e SEM a retenção, cujo `forget --prune` apagaria o reserva do dia. O `restic` do container precisa ser 0.17 ou mais novo (`restic version`), para o `--stdin-from-command`: ele não grava snapshot se o `pg_dump` falhar. O snapshot leva a tag `janela` e um host próprio, `veyra-staging-janela`. A retenção agrupa por host e caminho, não por tag, e o script antigo, que roda até o passo 5, não tem o `--keep-tag janela`: no mesmo host dos diários, o ciclo seguinte o apagaria. Com o host próprio, ele é o único do seu grupo, e nenhuma das duas retenções o remove.

   ```bash
   docker exec <container-backup> restic version
   docker exec <container-backup> sh -c 'restic backup --stdin-from-command --stdin-filename banco.dump --tag banco --tag staging --tag janela --host veyra-staging-janela -- pg_dump --format=custom --no-owner --no-privileges'
   docker exec <container-backup> sh -c 'restic snapshots --compact --tag janela | tail -3'
   # a conferência lê o fluxo INTEIRO: um dump truncado falha aqui (a lista sozinha passaria)
   docker exec <container-backup> sh -c 'set -o pipefail; restic dump <snapshot-id-da-janela> /banco.dump | pg_restore -f /dev/null && echo DUMP_INTEIRO'
   ```

   - **O ponto de restauração** é este snapshot: o estado exato antes de qualquer migration. Sem `DUMP_INTEIRO`, a janela não segue.
   - **A comparação com a origem** vale aqui, e só aqui, porque a escrita está congelada:
     - restaure o snapshot da janela como no PO-2;
     - leia as mesmas contagens no banco de origem, pelo container `db`;
     - elas precisam bater exatamente.

     Contagens iguais são uma conferência a mais, não prova completa de equivalência.

3. **A classificação do que estava em andamento** (§4, passo 3), pelo container `db`. Os números são anotados para a retomada: os despachos `reserved`, `failed_before_send` e `sending`, com e sem marcador, e os usos `authorized` (só se a G1 já estiver aplicada).
4. **As chaves, só se ausentes:**
   - confira o painel e o container (A2: só o nome, com valor não vazio);
   - **ausente nos dois:** gere no host (`openssl rand -base64 48`) e cole no painel como segredo, em runtime, não em build (§3.3). Limpe o terminal depois (`clear`). A `ADDRESS_LOCK_KEY` e a `OUTBOUND_APPROVAL_KEY` são independentes;
   - **presente:** fica. Trocá-la só depois de avaliar o que depende dela:
     - a `ADDRESS_LOCK_KEY` está nas chaves `address:` dos usos registrados, e a rotação só é em manutenção (SECURITY §8);
     - trocar a `OUTBOUND_APPROVAL_KEY` invalida as aprovações pendentes (`approval_stale`);
   - **presente só no painel** (o caso de um deploy que caiu): fica a do painel, que é a do próximo deploy.
5. **A imagem nova, atrás da barreira:**
   - com o recurso já fixado no commit final e o Auto Deploy desligado (passo 1), faça o **Deploy**, com `MAINTENANCE_MODE=true`, `DISABLE_JOBS=true`, `META_TRANSPORT_MODE=fake` e `VEYRA_ENV=staging`;
   - depois do deploy:
     - `docker stop <container-web>`;
     - as labels conferidas (§4, passo 4.2);
     - de fora, nenhum 2xx em `/api/`;
     - o ambiente do container novo, só os valores não secretos (`MAINTENANCE_MODE=true` é obrigatório aqui):

       ```bash
       docker inspect <container-api> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV)='
       ```

     - **por dentro, fora do loopback, 503** — a barreira de fato ligada:

       ```bash
       docker exec <container-db> wget -S -O /dev/null http://api:3001/api/health 2>&1 | grep -E 'HTTP/'
       ```

     - pelo loopback, a saúde: `docker exec <container-api> curl -fsS http://127.0.0.1:3001/api/health`;
     - o `restic` do container `backup` novo, que o deploy também recriou (a imagem do staging é amd64, e o `restic` não tem versão fixa): `docker exec <container-backup> restic version`, 0.17 ou mais novo.

   Com `MAINTENANCE_MODE=true`, a API nova não abre workers nem a reconciliação da subida, qualquer que seja o `DISABLE_JOBS`, e nenhum inicializador lê ou escreve tabela: nada toca o banco até as migrations, como o ensaio do PO-1 mede. Por isso, atrás da barreira, a regra do ADR-049 ("migration antes do código", da `scheduling_clock`) não se aplica: não há tráfego nem worker para quebrar.

6. **As migrations pendentes, pelo estado real:**

   ```bash
   docker exec <container-api> npx --no-install prisma migrate status
   docker exec <container-db> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL"'
   ```

   - **Parada imediata:** uma migration em andamento ou falhada, com `finished_at` e `rolled_back_at` nulos. Segue "Falha de migration" (§4), em manutenção. Um `rolled_back_at` preenchido, seguido de uma reaplicação concluída, é histórico normal.
   - **Parada imediata:** o `status` mostra migration aplicada no banco que não existe no commit final. O código seria mais antigo que o schema.
   - **A F4.1a** (`20261023120000_conversation_sender_and_phone_identity`), se pendente: siga o passo do §4 dela, com os comandos da imagem.
     - O `node dist/cli/identity-diagnose.js` roda ANTES do `migrate deploy`.
     - Grupo encontrado é parada: o tratamento é humano.
     - Depois da migration, o `node dist/cli/phones-normalize.js`, como o §4 manda.
   - **As de `lock_timeout`** seguem o §4.
   - Então: `docker exec <container-api> npx --no-install prisma migrate deploy`, e o inventário de cada migration (§4).

7. **As conferências, ainda em manutenção:**
   - `migrate status` sem pendentes;
   - `SELECT count(*) FROM "ClinicsSettings"` igual ao lido na etapa A, porque nenhum workspace foi ativado nesta etapa;
   - as consultas pós-migration do §4;
   - a varredura de FKs nos dados: `docker exec <container-api> node dist/cli/check-cross-tenant-fk.js`, que precisa terminar limpa.

**Parada C:** o banco no schema do commit final, conferido, ainda atrás da barreira. **Em falha em qualquer passo,** a barreira fica, e a recuperação é a do primeiro princípio, a partir do snapshot conferido no passo 2. A restauração é a do §6: num banco NOVO, conferido (as contagens anotadas no passo 2) e trocado pelo nome, guardando o banco falho; depois, a volta pelo passo 5.

### Etapa D — O workspace da demonstração (autorização própria; ainda em manutenção)

Pelas CLIs, no container `api`. O que protege o workspace `staging` é o Clinics continuar inativo nele (§7.1); o `demo` é dedicado por decisão do usuário.

1. **O workspace `demo`.** A conta do Owner existe, e ele entra como Owner direto:

   ```bash
   docker exec <container-api> node dist/cli/provision.js --name "Demonstração" --slug demo --owner-email aurelioromeu@outlook.com
   ```

2. **A ativação do Clinics só no `demo`.** Ela é irreversível nele: a IA fica restrita nos contatos, e os webhooks de contato param (§7.1). Depois dela, `ClinicsSettings` deve dar o valor da etapa A mais 1:

   ```bash
   docker exec <container-api> node dist/verticals/clinics/cli/clinics.js enable --slug demo
   ```

3. **O canal fictício,** com o token fictício por pipe. O `-i` leva o pipe para dentro do container. O token literal só é aceitável por ser fictício; um token real vai por `docker exec -it`, sem `--token-stdin`, pela pergunta sem eco:

   ```bash
   printf '%s' 'token-ficticio-da-demonstracao' | docker exec -i <container-api> node dist/cli/channel-whatsapp.js --slug demo --phone-number-id 000000000000011 --waba 000000000000100 --name "WhatsApp da demonstração" --token-stdin
   ```

4. **As três finalidades,** com os campos da demonstração:

   ```bash
   docker exec <container-api> node dist/cli/consent-purpose.js --slug demo --key clinics_confirmacao --category utility --description "Lembretes e confirmação dos seus horários na clínica (demonstração)" --fields contato.primeiro_nome,clinics.data,clinics.hora
   docker exec <container-api> node dist/cli/consent-purpose.js --slug demo --key clinics_reativacao --category utility --description "Aviso de retorno pendente na clínica (demonstração)" --fields contato.primeiro_nome
   docker exec <container-api> node dist/cli/consent-purpose.js --slug demo --key atendimento_retomada --category utility --description "Retomar o seu atendimento por mensagem (demonstração)" --fields contato.nome
   ```

5. **Os templates fictícios,** cadastrados e revisados em nome do usuário. É a autorização explícita dele, nesta etapa, limitada aos `demo_*`:

   ```bash
   docker exec <container-api> node dist/cli/templates-demo.js --slug demo --channel <channelId do passo 3> --reviewer aurelioromeu@outlook.com
   ```

6. **Os dados clínicos fictícios:**

   ```bash
   docker exec <container-api> node dist/verticals/clinics/cli/demo-carregar.js --slug demo --actor aurelioromeu@outlook.com
   ```

7. **As conferências:**
   - o Clinics só no `demo`;
   - as três versões revisadas;
   - a carga concluída, sem itens pulados: rodar de novo diz "já terminou".

**Parada D:** a demonstração pronta, ainda atrás da barreira.

### Etapa E — A retomada (autorização própria)

1. No painel:
   - `MAINTENANCE_MODE=false` e `DISABLE_JOBS=false`;
   - o domínio do `web` devolvido;
   - **Redeploy** do MESMO commit.
2. De fora: `curl -fsS https://veyra-staging.malachdigital.com.br/api/health`.
3. O login do Owner. Os workspaces `staging` e `demo` no seletor, e o aviso de envio simulado no `demo`.
4. **Se a retomada falhar,** volte à barreira:
   - `docker stop <container-web> <container-api>` corta o acesso na hora;
   - `MAINTENANCE_MODE=true` e `DISABLE_JOBS=true` no painel, o domínio do `web` retirado (como no C1), e um **Deploy** do MESMO commit; depois, `docker stop <container-web>` e a conferência de fora (nenhum 2xx em `/api/`);
   - **nunca Start, Restart nem Rollback:** os containers da retomada foram criados com `MAINTENANCE_MODE=false` e sobem sem a barreira, e o Rollback volta a uma imagem anterior. Nada de Redeploy de commit anterior.
5. O INC-2026-10-26-01 fechado no §12, com a causa e o que foi feito, e os `.log` da etapa A apagados.
6. **O snapshot da janela sai à mão,** com autorização, depois da retomada confirmada e de um ciclo diário bom: `docker exec <container-backup> restic forget <snapshot-id-da-janela>`. O espaço volta no `prune` do ciclo seguinte. O banco falho de uma restauração, se houver, sai da mesma forma, com o `dropdb` dele.

**Parada E:** a demonstração no ar, para o uso do usuário.

### Etapa F — O uso

O usuário entra e troca para o workspace Demonstração. Depois:

1. Na ficha de um paciente fictício, registra o consentimento (a confirmação de horário).
2. Nos Envios, escolhe o paciente, vê a prévia, aprova e acompanha até "Enviado (simulado)". O outbox roda a cada minuto.
3. Nas Métricas, a entrega e a resposta aparecem como "Sem dados", por desenho. Nada sai para a Meta.

**Antes de voltar o staging à Graph,** algum dia, as versões `demo_*` saem de uso.

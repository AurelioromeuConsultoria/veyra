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

| Variável                                              | Observação                                          |
| ----------------------------------------------------- | --------------------------------------------------- |
| `VEYRA_HOST`                                          | `veyra-staging.malachdigital.com.br`                |
| `VEYRA_ENV`                                           | `staging` — **é o que autoriza o transporte falso** |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | senha gerada, nunca reaproveitada                   |
| `JWT_SECRET`                                          | ≥32 caracteres, `openssl rand -base64 48`           |
| `TOKEN_ENCRYPTION_KEY`                                | **independente** do JWT                             |
| `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN`       | valores de TESTE, nunca os do app real              |
| `META_TRANSPORT_MODE`                                 | `fake` — nada sai para a Meta (ADR-046)             |
| `ANTHROPIC_API_KEY`                                   | com chave, a IA funciona e o custo é real           |
| `CLAMAV_HOST`                                         | **vazio** (scanner desligado, ver §2)               |
| `RESTIC_REPOSITORY` / `RESTIC_PASSWORD` / `AWS_*`     | backup; pode ficar vazio até você decidir o destino |

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
`lock_timeout = 5s`. Se uma transação longa estiver segurando a tabela, a
migration falha em vez de travar todas as escritas da aplicação. Nesse caso o
Prisma a registra como falha, e o próximo `migrate deploy` para com **P3009**.
O `ALTER` não chegou a ser aplicado, então marque como desfeita e repita:

```bash
npx prisma migrate resolve --rolled-back 20261019200000_outbox_subject_contacts
npx prisma migrate deploy
```

Troque o nome pela migration que falhou: o `migrate deploy` mostra qual foi.

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
jobs ligados; sem consumidor ligado (G3), não há uso a reconciliar.

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

## 5. Rollback

No painel, o Coolify guarda os deploys anteriores: **Redeploy** do commit
anterior devolve o código. É o caminho mais curto e o motivo pelo qual o
recurso deve apontar para tag/commit, não para `main`.

**Migration não tem rollback automático, e isto é deliberado**: `migrate deploy`
não desfaz. Se a migration nova for incompatível com o código antigo, a volta é
por restauração de banco (§6.2) — por isso o backup roda ANTES de todo deploy
com migration:

```bash
# pelo terminal do Coolify, no container `backup`
/usr/local/bin/backup.sh
```

## 6. Backup e restauração

O backup roda diariamente às `BACKUP_AT` (UTC) num container próprio: dump
lógico do Postgres + storage, cifrados pelo restic, para um destino **externo à
VPS**. Backup no mesmo disco que ele protege não é backup.

Pelo terminal do Coolify, no container `backup`:

```bash
/usr/local/bin/backup.sh            # sob demanda
/usr/local/bin/restore.sh listar    # o que existe no destino
```

Restauração do banco. **Pare a API antes**: restaurar com escrita em curso
produz estado que nenhum dos dois lados reconhece. No host, com os nomes reais
que você anotou na §3.6:

```bash
docker stop <container-api> <container-web>
docker exec -it <container-backup> /usr/local/bin/restore.sh banco <snapshot-id>
docker start <container-api>
docker exec -it <container-api> npx prisma migrate deploy
docker start <container-web>
```

Restauração do storage: o volume é montado somente-leitura no `backup`, então
a cópia de volta vai por um container temporário com o volume real montado
para escrita — os nomes saem da §3.6.

```bash
docker stop <container-api>
docker run --rm -v <volume-storage>:/destino -v <volume-restic-cache>:/cache \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD <imagem-backup> \
  /usr/local/bin/restore.sh storage <snapshot-id> /destino
docker start <container-api>
```

**Teste a restauração antes de precisar dela.** Um ensaio trimestral em banco
descartável é o que distingue backup de esperança.

## 7. Operação do dia a dia

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

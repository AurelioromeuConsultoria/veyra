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

## 2. Diagnóstico (rode ANTES de tudo)

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

## 3. Provisionamento inicial (uma vez)

```bash
# 3.1 diretório e segredos — fora do repositório, dono root, 0600
sudo install -d -o root -g root -m 0750 /opt/veyra-staging
sudo install -o root -g root -m 0600 /dev/null /opt/veyra-staging/.env
sudo nano /opt/veyra-staging/.env          # base: deploy/staging/.env.example

# 3.2 código
sudo git clone https://github.com/AurelioromeuConsultoria/veyra.git /opt/veyra-staging/app
cd /opt/veyra-staging/app

# 3.3 imagens
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml build

# 3.4 banco e scanner primeiro (ClamAV baixa a base: minutos)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml up -d db clamav

# 3.5 schema
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm api npx prisma migrate deploy

# 3.6 catálogo de permissões (CLI compilado; sem ele o provisionamento falha
#     na FK de RolePermission)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm api node dist/cli/seed-permissions.js

# 3.7 tudo no ar
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml up -d

# 3.8 workspace e dono (o token do convite aparece UMA vez)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  exec api node dist/cli/provision.js \
  --name "Veyra Staging" --slug staging --owner-email voce@exemplo.com
```

Depois: aponte o DNS, aplique o trecho do proxy, emita o certificado pelo fluxo
que a VPS já usa e valide `https://$VEYRA_HOST/api/health`.

## 4. Deploy de atualização

```bash
cd /opt/veyra-staging/app
git fetch --tags && git checkout <tag-ou-sha>       # sempre imutável, nunca "main"
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml build
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm api npx prisma migrate deploy            # migration ANTES do código novo
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml up -d
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml ps
curl -fsS https://$VEYRA_HOST/api/health
```

**Migration antes do código** porque o Prisma exige schema compatível no boot.
Migration destrutiva quebra essa ordem: nesse caso, deploy em duas etapas
(código que tolera as duas formas → migration → limpeza), como manda o hook de
migration destrutiva.

## 5. Rollback

```bash
# 5.1 código: volte à tag anterior e suba
git checkout <tag-anterior>
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml build
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml up -d
```

**Migration não tem rollback automático, e isto é deliberado**: `migrate deploy`
não desfaz. Se a migration nova for incompatível com o código antigo, a volta é
por restauração de banco (§6.2) — por isso o backup roda ANTES de todo deploy
com migration:

```bash
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm backup /usr/local/bin/backup.sh
```

## 6. Backup e restauração

O backup roda diariamente às `BACKUP_AT` (UTC) num container próprio: dump
lógico do Postgres + storage, cifrados pelo restic, para um destino **externo à
VPS**. Backup no mesmo disco que ele protege não é backup.

```bash
# 6.1 sob demanda / verificação
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm backup /usr/local/bin/backup.sh
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm backup /usr/local/bin/restore.sh listar
```

```bash
# 6.2 restauração do banco — PARE a API antes: restaurar com escrita em curso
# produz estado que nenhum dos dois lados reconhece
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml stop api web
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm backup /usr/local/bin/restore.sh banco <snapshot-id>
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm api npx prisma migrate deploy
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml start api web
```

```bash
# 6.3 restauração do storage
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml stop api
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml \
  run --rm -v veyra-staging-storage:/data/restore-target backup \
  /usr/local/bin/restore.sh storage <snapshot-id> /data/restore-target
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml start api
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

## 8. Desmontar só o Veyra

```bash
# para tudo, PRESERVANDO volumes
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml down

# apaga TAMBÉM os dados do Veyra (e só os dele)
docker compose -p veyra-staging -f deploy/staging/docker-compose.yml down -v
```

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

```bash
docker compose --env-file <seu-env-local> -p veyra-local -f deploy/staging/docker-compose.yml build
docker compose --env-file <seu-env-local> -p veyra-local -f deploy/staging/docker-compose.yml up -d db
docker compose --env-file <seu-env-local> -p veyra-local -f deploy/staging/docker-compose.yml run --rm --no-deps api npx prisma migrate deploy
# ... e o ciclo de restauração da §6, que é o único jeito de saber que o backup presta
```

## 10. O que staging NÃO faz

- **Não envia WhatsApp de verdade.** `META_TRANSPORT_MODE=fake` (depende do ADR
  proposto — enquanto ele não existir, staging fica sem credencial de canal e o
  envio falha com `no_credential`, que também não vaza nada para fora).
- **Não recebe dado real de paciente.** É regra de operação, não técnica: quem
  colar um export de produção aqui quebra a premissa do ambiente.
- **Não é referência de desempenho.** Divide CPU e disco com os outros projetos.

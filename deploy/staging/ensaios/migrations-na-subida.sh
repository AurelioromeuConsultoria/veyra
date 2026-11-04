#!/usr/bin/env bash
# Ensaio das migrations na subida (ADR-058, adendo 2) com a IMAGEM real da API,
# num banco descartável local (prefixo veyra_ensaio_), apagado no fim. Rode da
# raiz do repositório, com o Postgres local de dev (container `veyra-postgres`,
# porta 5434) e o Docker Desktop (`host.docker.internal`).
# (a) banco vazio: a API aplica todas e responde 200;
# (b) uma migration que falha: "current transaction is aborted" na primeira
#     subida (a migration é transacional), P3009 nas seguintes, nada criado;
# (c) a recuperação documentada (resolve --rolled-back num container avulso da
#     mesma imagem, DATABASE_URL por --env-file) e a API de volta.
set -euo pipefail
R=$(git rev-parse --show-toplevel)
# os logs ficam num diretório próprio, impresso no fim
S=$(mktemp -d)
BASE="veyra_ensaio_subida_$(date +%s)"
case "$BASE" in veyra_ensaio_*) ;; *) exit 1 ;; esac
IMG=veyra-api-ensaio-subida
IMGF=veyra-api-ensaio-subida-falha
E=$(mktemp -d)
pare() { echo "ENSAIO INTERROMPIDO: $*" >&2; exit 1; }
limpa() {
  docker rm -f ensaio-api ensaio-api-falha >/dev/null 2>&1 || true
  docker exec veyra-postgres dropdb --if-exists -U veyra "$BASE" || true
  rm -rf "$E"
}
trap limpa EXIT

echo "== build da imagem da API"
docker build -q -f "$R/apps/api/Dockerfile" -t "$IMG" "$R" >/dev/null

# a imagem com uma migration a mais que falha DENTRO da transação (ADR-051)
mkdir -p "$E/falha/20991231000000_ensaio_falha"
printf -- "-- ensaio: falha forçada\nBEGIN;\nCREATE TABLE \"EnsaioSubida\" (id int);\nDO \$\$ BEGIN RAISE EXCEPTION 'falha forçada do ensaio'; END \$\$;\nCOMMIT;\n" >"$E/falha/20991231000000_ensaio_falha/migration.sql"
printf 'FROM %s\nCOPY --chown=veyra:veyra 20991231000000_ensaio_falha /app/apps/api/prisma/migrations/20991231000000_ensaio_falha\n' "$IMG" >"$E/falha/Dockerfile"
docker build -q -t "$IMGF" "$E/falha" >/dev/null

docker exec veyra-postgres createdb -U veyra "$BASE"
# o ambiente do staging, fictício, num arquivo (nada em argumento)
cat >"$E/env" <<ENV
NODE_ENV=production
VEYRA_ENV=staging
MAINTENANCE_MODE=false
DISABLE_JOBS=true
META_TRANSPORT_MODE=fake
PORT=3001
DATABASE_URL=postgresql://veyra:veyra_dev@host.docker.internal:5434/$BASE
WEB_ORIGIN=https://veyra-ensaio.invalid
STORAGE_ROOT=/data/storage
JWT_SECRET=ensaio-jwt-secret-nunca-em-producao-32ch
TOKEN_ENCRYPTION_KEY=ensaio-chave-de-cifra-nunca-em-producao
ADDRESS_LOCK_KEY=ensaio-chave-das-travas-de-endereco-32ch
OUTBOUND_APPROVAL_KEY=ensaio-chave-da-aprovacao-do-envio-32ch
ENV

saude() { # espera a saúde dentro do container; 0 = 200
  for _ in $(seq 1 60); do
    docker exec "$1" curl -fsS http://127.0.0.1:3001/api/health >/dev/null 2>&1 && return 0
    [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ] || return 1
    sleep 1
  done
  return 1
}
aplicadas() { docker exec veyra-postgres psql -U veyra -d "$BASE" -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"; }
TOTAL=$(ls -d "$R"/apps/api/prisma/migrations/*/ | wc -l | tr -d ' ')

echo "== (a) banco vazio, a imagem real"
docker run -d --name ensaio-api --env-file "$E/env" "$IMG" >/dev/null
saude ensaio-api || { docker logs ensaio-api | tail -30; pare "a API não ficou saudável no banco vazio"; }
N=$(aplicadas)
[ "$N" = "$TOTAL" ] || pare "aplicadas $N, esperadas $TOTAL"
LOGA=$(docker logs ensaio-api 2>&1)
grep -q 'migrations found in prisma/migrations' <<<"$LOGA" || pare "sem o registro do Prisma no log"
echo "(a) ok: $N migrations aplicadas na subida, saúde 200"
docker rm -f ensaio-api >/dev/null

echo "== (b) a migration que falha"
docker run -d --name ensaio-api-falha --env-file "$E/env" "$IMGF" >/dev/null
sleep 20
[ "$(docker inspect -f '{{.State.Running}}' ensaio-api-falha)" = false ] || pare "a API com a migration falhada continua de pé"
docker logs ensaio-api-falha >"$S/ensaio-subida-falha-1.log" 2>&1
grep -q 'current transaction is aborted' "$S/ensaio-subida-falha-1.log" || pare "a primeira subida não mostrou a falha da migration"
grep -q 'as migrations na subida falharam' "$S/ensaio-subida-falha-1.log" || pare "sem a mensagem da subida"
[ "$(docker exec veyra-postgres psql -U veyra -d "$BASE" -At -c "SELECT to_regclass('public.\"EnsaioSubida\"') IS NULL")" = t ] || pare "a falha deixou a tabela criada"
docker start ensaio-api-falha >/dev/null; sleep 20
docker logs ensaio-api-falha >"$S/ensaio-subida-falha-2.log" 2>&1
grep -q 'P3009' "$S/ensaio-subida-falha-2.log" || pare "a segunda subida não mostrou P3009"
echo "(b) ok: a falha (transaction aborted) na primeira subida, P3009 na seguinte, nada criado"

echo "== (c) a recuperação documentada (DEPLOY_STAGING §4.0)"
A=ensaio-api-falha
docker run --rm \
  --env-file <(docker inspect "$A" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^DATABASE_URL=') \
  -e NPM_CONFIG_UPDATE_NOTIFIER=false -e CHECKPOINT_DISABLE=1 "$(docker inspect "$A" --format '{{.Image}}')" \
  npx --no-install prisma migrate resolve --rolled-back 20991231000000_ensaio_falha >"$S/ensaio-subida-resolve.log" 2>&1 ||
  { cat "$S/ensaio-subida-resolve.log"; pare "o resolve falhou"; }
docker rm -f ensaio-api-falha >/dev/null
# a correção: a imagem sem a migration falhada sobe
docker run -d --name ensaio-api --env-file "$E/env" "$IMG" >/dev/null
saude ensaio-api || { docker logs ensaio-api | tail -30; pare "a API não voltou depois do resolve"; }
echo "(c) ok: resolve --rolled-back pelo container avulso, a API de volta com saúde 200"
echo "ENSAIO DA SUBIDA OK ($BASE; logs em $S)"

#!/bin/sh
# Ensaio do ADR-053: a API NOVA, compilada, sobe em manutenção sobre um schema
# ANTIGO sem ler nem escrever tabela nenhuma, e as migrations pendentes se
# aplicam depois.
#
#   sh deploy/staging/ensaios/manutencao-com-schema-antigo.sh [migration-alvo]
#
# O banco é descartável (prefixo veyra_ensaio_), no Postgres LOCAL de dev
# (container veyra-postgres, porta 5434), montado até a migration-alvo,
# inclusive. O padrão é a última antes da F4; depois do diagnóstico do staging,
# rode com a última migration aplicada lá. A API roda com o ambiente do staging
# (NODE_ENV=production, VEYRA_ENV=staging, transporte simulado), nada herdado
# do shell. Exige `pnpm build` antes (a API sobe de apps/api/dist). Nada aqui
# toca o staging. Sem endereço de rede, falha; VEYRA_TESTE_SEM_REDE=1 dispensa
# a conferência pela rede, de propósito.
set -eu

# só o Docker LOCAL: o banco do ensaio nasce no container de dev
[ -z "${DOCKER_HOST:-}" ] || { echo "recusado: DOCKER_HOST definido ($DOCKER_HOST)" >&2; exit 1; }
case "$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" in
  unix://*) ;;
  *) echo "recusado: o contexto do Docker não é local" >&2; exit 1 ;;
esac

ALVO="${1:-20261022120000_clinics_returns}"
RAIZ=$(git rev-parse --show-toplevel)
API="$RAIZ/apps/api"
PG=postgresql://veyra:veyra_dev@localhost:5434
BASE="veyra_ensaio_mm_$(date +%s)"
PORTA=3099
E=$(mktemp -d)
PID=""

pare() { echo "ENSAIO INTERROMPIDO: $*" >&2; exit 1; }
case "$BASE" in veyra_ensaio_*) ;; *) pare "banco do ensaio sem o prefixo veyra_ensaio_" ;; esac
[ -d "$API/prisma/migrations/$ALVO" ] || pare "migration-alvo inexistente: $ALVO"
[ -f "$API/dist/main.js" ] || pare "falta o build: rode pnpm build"

limpar() {
  st=$?
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi
  [ "$st" = 0 ] || { echo "── o log da API ──"; tail -n 40 "$E/api.log" 2>/dev/null; }
  # `--force`: uma API que caiu com o pool aberto ainda segura conexões
  docker exec veyra-postgres dropdb --if-exists --force -U veyra "$BASE" >/dev/null 2>&1 \
    || echo "AVISO: o banco do ensaio $BASE ficou no Postgres de dev; remova-o (dropdb --force)" >&2
  rm -rf "$E"
}
trap limpar EXIT
psql_() { docker exec -i veyra-postgres psql -U veyra -X -q -At -v ON_ERROR_STOP=1 -d "$BASE" "$@"; }
# o código do curl: 7 é conexão recusada (ninguém escuta)
status() { curl -s -o /dev/null --max-time 5 -w '%{http_code}' "$@" || true; }
recusa() { set +e; curl -s -o /dev/null --max-time 5 "$1"; c=$?; set -e; [ "$c" = 7 ]; }

# o endereço da rede: o mesmo critério do teste de integração (IPv4 que não é
# loopback)
IP=$(node -e "for (const l of Object.values(require('os').networkInterfaces())) for (const i of l ?? []) if (i.family === 'IPv4' && !i.internal) { console.log(i.address); process.exit(0); }")
if [ -z "$IP" ] && [ "${VEYRA_TESTE_SEM_REDE:-}" != 1 ]; then
  pare "sem endereço IPv4 de rede: a saúde pela rede não seria conferida (VEYRA_TESTE_SEM_REDE=1 dispensa)"
fi

# a porta precisa estar LIVRE: senão quem responde é outro processo
recusa "http://127.0.0.1:$PORTA/" || pare "a porta $PORTA já está em uso no loopback"
[ -z "$IP" ] || recusa "http://$IP:$PORTA/" || pare "a porta $PORTA já está em uso em $IP"

# 1. o schema antigo: as migrations até a alvo, inclusive, numa cópia fora do repositório
mkdir -p "$E/migrations"; cp "$API/prisma/migrations/migration_lock.toml" "$E/migrations/"
for d in "$API"/prisma/migrations/*/; do
  d=${d%/}; nome=${d##*/}
  if [ "$nome" = "$ALVO" ] || [ "$(printf '%s\n%s\n' "$nome" "$ALVO" | sort | head -1)" = "$nome" ]; then
    cp -R "$d" "$E/migrations/"
  fi
done
printf "export default { schema: '%s/prisma/schema', migrations: { path: '%s/migrations' }, datasource: { url: process.env.DATABASE_URL } };\n" "$API" "$E" > "$E/prisma.config.ts"
docker exec veyra-postgres createdb -U veyra "$BASE"
(cd "$API" && DATABASE_URL="$PG/$BASE" npx --no-install prisma migrate deploy --config "$E/prisma.config.ts") > "$E/base.log" 2>&1 \
  || { tail -n 30 "$E/base.log"; pare "a base não aplicou"; }
echo "schema antigo montado até $ALVO ($(ls -d "$E"/migrations/*/ | wc -l | tr -d ' ') migrations)"

# a atividade nas tabelas do banco: leituras (seq + índice) e escritas. Os
# contadores de uma sessão chegam ao pg_stat quando ela termina
atividade() {
  psql_ -c "SELECT coalesce(sum(seq_scan + coalesce(idx_scan, 0)), 0) || ' leituras, ' || coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0) || ' escritas' FROM pg_stat_user_tables"
}
sleep 1
ANTES=$(atividade)

# A API com o ambiente do STAGING, nada herdado do shell. `exec` em cada nível:
# o processo em segundo plano É o node, e o `kill` o encerra de fato
api() {
  exec env -i PATH="$PATH" HOME="$E" NODE_ENV=production VEYRA_ENV=staging META_TRANSPORT_MODE=fake \
    PORT="$PORTA" DATABASE_URL="$PG/$BASE" WEB_ORIGIN=https://veyra-ensaio.invalid STORAGE_ROOT="$E/storage" \
    JWT_SECRET=ensaio-jwt-secret-nunca-em-producao-32ch \
    TOKEN_ENCRYPTION_KEY=ensaio-chave-de-cifra-nunca-em-producao \
    ADDRESS_LOCK_KEY=ensaio-chave-das-travas-de-endereco-32ch \
    OUTBOUND_APPROVAL_KEY=ensaio-chave-da-aprovacao-do-envio-32ch \
    DISABLE_JOBS=false "$@" node "$API/dist/main.js"
}

# 2. sem a variável, ou com valor inválido, nada sobe — e pelo motivo certo.
# Com prazo: a API que subisse por engano ficaria escutando para sempre
nao_sobe() {  # $1 o caso; o resto, variáveis
  caso=$1; shift
  (api "$@") > "$E/nao-sobe.log" 2>&1 &
  p=$!; n=0
  while kill -0 "$p" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -gt 30 ]; then kill "$p"; wait "$p" 2>/dev/null || true; pare "$caso: a API SUBIU"; fi
    sleep 1
  done
  if wait "$p"; then pare "$caso: saiu com código 0"; fi
  grep -q 'MAINTENANCE_MODE é obrigatória: true ou false' "$E/nao-sobe.log" \
    || { cat "$E/nao-sobe.log"; pare "$caso: saiu, mas não pela MAINTENANCE_MODE"; }
  recusa "http://127.0.0.1:$PORTA/" || pare "$caso: algo escuta na porta"
}
nao_sobe "sem a variável"
nao_sobe "MAINTENANCE_MODE=sim" MAINTENANCE_MODE=sim
nao_sobe "MAINTENANCE_MODE vazia" MAINTENANCE_MODE=
echo "sem a variável, vazia ou com valor inválido: a API não sobe, pela MAINTENANCE_MODE"

# 3. em manutenção, com DISABLE_JOBS=false, sobre o schema antigo
(api MAINTENANCE_MODE=true) > "$E/api.log" 2>&1 &
PID=$!
n=0
until [ "$(status "http://127.0.0.1:$PORTA/api/health")" = 200 ]; do
  kill -0 "$PID" 2>/dev/null || pare "a API caiu na subida"
  n=$((n + 1)); [ "$n" -lt 60 ] || pare "a API não respondeu em 60 s"
  sleep 1
done
echo "subiu em manutenção sobre o schema antigo, com o ambiente do staging; a saúde pelo loopback dá 200"

codigo=$(status -X POST -H 'Content-Type: application/json' \
  -d '{"email":"x@y.z","password":"qualquer"}' "http://127.0.0.1:$PORTA/api/auth/login")
[ "$codigo" = 503 ] || pare "o login pelo loopback deu $codigo (esperado 503)"
codigo=$(status -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$PORTA/api/channels/whatsapp/webhook")
[ "$codigo" = 503 ] || pare "o webhook pelo loopback deu $codigo (esperado 503)"
if [ -n "$IP" ]; then
  codigo=$(status -H 'X-Forwarded-For: 127.0.0.1' -H 'X-Real-IP: 127.0.0.1' "http://$IP:$PORTA/api/health")
  [ "$codigo" = 503 ] || pare "a saúde pelo endereço da rede ($IP) deu $codigo (esperado 503)"
  echo "o login e o webhook pelo loopback, e a saúde pela rede ($IP, com XFF forjado): 503"
else
  echo "AVISO: VEYRA_TESTE_SEM_REDE=1 — a saúde pela rede não foi conferida"
fi
grep -q 'Jobs desabilitados (manutenção)' "$E/api.log" || pare "o log não diz que os jobs ficaram desligados"
[ "$(psql_ -c "SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'pgboss'")" = 0 ] \
  || pare "o schema do pg-boss nasceu: os jobs subiram"
if grep -iwE 'error|exception' "$E/api.log" > "$E/erros.log"; then
  cat "$E/erros.log"; pare "a API registrou erro na subida sobre o schema antigo"
fi
sleep 3
kill -0 "$PID" 2>/dev/null || pare "a API caiu depois da subida"
kill "$PID"; wait "$PID" 2>/dev/null || true; PID=""
recusa "http://127.0.0.1:$PORTA/" || pare "a porta seguiu respondendo depois de a API parar: quem respondia era outro"
echo "nenhum job subiu (sem o schema do pg-boss), nenhum erro no log, e quem respondia era a API do ensaio"

# a subida e as requisições barradas não tocaram tabela nenhuma (ADR-053 §4)
sleep 1
DEPOIS=$(atividade)
[ "$DEPOIS" = "$ANTES" ] || pare "a API tocou tabelas na subida ou nas requisições barradas: antes $ANTES, depois $DEPOIS"
# o contraste: a medida não é vazia — uma leitura de verdade aparece nela
psql_ -c 'SELECT count(*) FROM "_prisma_migrations"' > /dev/null
sleep 1
[ "$(atividade)" != "$ANTES" ] || pare "a medida da atividade não registrou nem a leitura de contraste"
echo "nenhuma leitura nem escrita de tabela na subida e nas requisições ($ANTES), e a medida registra uma leitura de verdade"

# 4. com a API parada, as migrations pendentes do commit atual se aplicam
(cd "$API" && DATABASE_URL="$PG/$BASE" npx --no-install prisma migrate deploy) > "$E/deploy.log" 2>&1 \
  || { tail -n 30 "$E/deploy.log"; pare "as migrations pendentes não aplicaram"; }
(cd "$API" && DATABASE_URL="$PG/$BASE" npx --no-install prisma migrate status) > "$E/status.log" 2>&1 \
  || { tail -n 20 "$E/status.log"; pare "o status depois do deploy não está em dia"; }
echo "as migrations pendentes aplicaram, e o status está em dia"
echo "ENSAIO_OK"

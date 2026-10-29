#!/bin/sh
# Testes de FALHA do backup e da restauração (ADR-046 adendo 1), na imagem
# construída do próprio Dockerfile — o shell (busybox ash), o restic e o
# cliente Postgres que os scripts usam de fato. Tudo descartável: um Postgres
# de teste, um repositório restic local e uma rede própria, no Docker LOCAL.
# Nada toca o staging.
#
#   sh deploy/staging/backup/testes/falhas.sh      # termina com TESTES_DE_FALHA_OK
#
# Prova, cada um com a sua conferência:
#   1. a falha do pg_dump e a do restic não produzem mensagem de sucesso;
#   2. o ciclo interrompe e não aplica a retenção depois de um backup falho;
#   3. o agendador registra a falha e o próximo ciclo tenta de novo;
#   4. dump truncado ou erro de restauração não deixa aplicação parcial, e o
#      banco vivo nunca é alvo;
#   5. as falhas preservam os pontos de recuperação que já existem.
#
# As falhas são de verdade: shims em /usr/local/sbin (que vem antes no PATH da
# imagem) trocam um comando por um que falha do jeito do caso — o pg_dump que
# cai no meio do fluxo, o restic que falha só no `backup` ou que sai com erro
# depois de entregar o fluxo inteiro, o `sleep` do agendador que não dorme.
set -eu

# só o Docker LOCAL: um contexto remoto criaria os containers noutro lugar
[ -z "${DOCKER_HOST:-}" ] || { echo "recusado: DOCKER_HOST definido ($DOCKER_HOST)" >&2; exit 1; }
case "$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" in
  unix://*) ;;
  *) echo "recusado: o contexto do Docker não é local" >&2; exit 1 ;;
esac

RAIZ=$(git rev-parse --show-toplevel)
IMG=veyra-backup:teste
P=veyra-backup-teste
REDE="$P-rede"; DB="$P-db"; REPO="$P-repo"; STORAGE="$P-storage"; VOLTA="$P-volta"; ENSAIO="$P-ensaio"
SENHA_RESTIC=senha-do-repositorio-de-teste
SENHA_PG=senha-do-postgres-de-teste
SHIMS=$(mktemp -d)

remover() {
  docker rm -f -v "$DB" "$ENSAIO" >/dev/null 2>&1 || true
  docker volume rm "$REPO" "$STORAGE" "$VOLTA" >/dev/null 2>&1 || true
  docker network rm "$REDE" >/dev/null 2>&1 || true
}
trap 'remover; rm -rf "$SHIMS"' EXIT
remover
pare() { echo "FALHOU: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# ── os shims ────────────────────────────────────────────────────────────────
cat > "$SHIMS/pg_dump-cai-no-meio" <<'SH'
#!/bin/sh
# entrega o começo do dump e cai no meio do fluxo
/usr/bin/pg_dump "$@" | head -c 3000
exit 1
SH
cat > "$SHIMS/restic-falha-no-backup" <<'SH'
#!/bin/sh
# abre o repositório normalmente; só o `backup` falha
[ "$1" = backup ] && { echo "restic falso: o backup falhou" >&2; exit 1; }
exec /usr/bin/restic "$@"
SH
cat > "$SHIMS/restic-dump-sai-com-erro" <<'SH'
#!/bin/sh
# entrega o fluxo INTEIRO e sai com erro: o pg_restore já comitou quando o
# código chega — só o pipefail do restore.sh pega
if [ "$1" = dump ]; then /usr/bin/restic "$@"; exit 1; fi
exec /usr/bin/restic "$@"
SH
cat > "$SHIMS/date-com-zeros" <<'SH'
#!/bin/sh
# o relógio às 08:09:08 UTC para o agendador: os três campos com o zero à
# esquerda que o shell leria como octal inválido
[ "$*" = "-u +%H %M %S" ] && { echo "08 09 08"; exit 0; }
exec /bin/date "$@"
SH
cat > "$SHIMS/sai-com-erro" <<'SH'
#!/bin/sh
# o comando que falha (o dropdb de um Postgres que caiu no meio)
exit 1
SH
cat > "$SHIMS/sleep-nao-dorme" <<'SH'
#!/bin/sh
# o `sleep` do agendador: volta na hora; na 3ª chamada falha, e o `set -e` do
# laço o encerra — duas voltas completas
n=$(( $(cat /tmp/voltas 2>/dev/null || echo 0) + 1 )); echo "$n" > /tmp/voltas
[ "$n" -lt 3 ]
SH
chmod 755 "$SHIMS"/*

docker build -q -t "$IMG" "$RAIZ/deploy/staging/backup" >/dev/null
docker network create --internal "$REDE" >/dev/null
docker volume create "$REPO" >/dev/null
docker run --rm -v "$REPO:/repo" alpine:3.21 chown 10001:10001 /repo
docker run -d --name "$DB" --network "$REDE" -e POSTGRES_USER=teste \
  -e POSTGRES_PASSWORD="$SENHA_PG" -e POSTGRES_DB=origem postgres:17-alpine >/dev/null
n=0; until docker exec "$DB" pg_isready -h 127.0.0.1 -U teste >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -lt 60 ] || pare "o Postgres de teste não subiu"; sleep 1; done
sql() { docker exec -i "$DB" psql -U teste -X -q -At -v ON_ERROR_STOP=1 -d "$1"; }
# a origem: dados fictícios com volume suficiente para o dump ter dados de verdade
printf '%s\n' "CREATE TABLE paciente_ficticio (id int PRIMARY KEY, nome text);" \
  "INSERT INTO paciente_ficticio SELECT g, md5(g::text) || md5((g*7)::text) FROM generate_series(1, 20000) g;" | sql origem
# o banco VIVO da restauração: a MESMA tabela do dump, com uma linha-sentinela,
# e uma tabela que o dump não conhece. Nenhuma restauração pode tocá-lo
echo "CREATE DATABASE vivo;" | sql origem
printf '%s\n' "CREATE TABLE paciente_ficticio (id int PRIMARY KEY, nome text);" \
  "INSERT INTO paciente_ficticio VALUES (999999, 'sentinela');" \
  "CREATE TABLE sentinela (x int);" "INSERT INTO sentinela VALUES (42);" | sql vivo
vivo_intacto() {
  estado="$(echo "SELECT count(*) || ':' || max(nome) FROM paciente_ficticio" | sql vivo):$(echo 'SELECT x FROM sentinela' | sql vivo)"
  [ "$estado" = "1:sentinela:42" ] || pare "$1: o banco vivo foi tocado ($estado)"
}
banco_existe() { echo "SELECT count(*) FROM pg_database WHERE datname = '$1'" | sql origem; }

# roda na imagem, como o container `backup`. R_SENHA, PG_SENHA, PG_BANCO e
# KEEP* sobrescrevem variáveis; OPC acrescenta opções do `docker run` (volume,
# usuário, variável); SHIM ("comando:arquivo ...") troca comandos
rodar() {
  shim=""
  for s in ${SHIM:-}; do shim="$shim -v $SHIMS/${s#*:}:/usr/local/sbin/${s%%:*}:ro"; done
  # shellcheck disable=SC2086
  docker run --rm --network "$REDE" -v "$REPO:/repo" ${OPC:-} $shim \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD="${R_SENHA:-$SENHA_RESTIC}" \
    -e PGHOST="$DB" -e PGUSER=teste -e PGPASSWORD="${PG_SENHA:-$SENHA_PG}" \
    -e PGDATABASE="${PG_BANCO:-origem}" -e RESTIC_CHECK_SUBSET=1/1 \
    -e RESTIC_KEEP_DAILY="${KEEP:-7}" -e RESTIC_KEEP_WEEKLY="${KEEP_S:-4}" -e RESTIC_KEEP_MONTHLY="${KEEP_M:-6}" \
    "$IMG" "$@"
}
# a saída e o código, sem o -e derrubar o teste. As variáveis do caso são
# atribuídas numa linha própria e limpas depois (`limpa`): no sh, a atribuição
# como prefixo de uma FUNÇÃO persiste depois dela
executar() { set +e; saida=$(rodar "$@" 2>&1); codigo=$?; set -e; }
limpa() { unset R_SENHA PG_SENHA PG_BANCO KEEP KEEP_S KEEP_M SHIM OPC; }
snapshots() { rodar restic snapshots --tag "$1" --json 2>/dev/null | grep -o '"short_id"' | wc -l | tr -d ' '; }
# o snapshot mais recente (o JSON vem em ordem de tempo). A contagem sozinha
# não basta: a retenção padrão, com vários ciclos no mesmo dia, mantém dois e
# remove o mais antigo
ultimo() { rodar restic snapshots --tag "${1:-banco}" --json 2>/dev/null | grep -o '"short_id":"[0-9a-f]*"' | tail -1 | cut -d'"' -f4; }
sem_sucesso() {
  for frase in 'dump concluído' 'storage concluído' 'aplicando retenção' 'ciclo concluído com sucesso'; do
    printf '%s' "$saida" | grep -q "$frase" && { echo "$saida"; pare "$1: apareceu '$frase'"; }
  done
  return 0
}
# o backup que falha: código ≠ 0, a mensagem do passo, nenhum sucesso, e os
# pontos de recuperação exatamente como estavam
falhou_sem_mexer() {
  [ "$codigo" != 0 ] || { echo "$saida"; pare "$1: saiu com código 0"; }
  sem_sucesso "$1"
  printf '%s' "$saida" | grep -q "$2" || { echo "$saida"; pare "$1: faltou '$2'"; }
  [ "$(snapshots banco)" = "$N_BANCO" ] || pare "$1: mudou os pontos de recuperação ($(snapshots banco), esperado $N_BANCO)"
  [ "$(ultimo)" = "$ANTES" ] || pare "$1: gravou um snapshot do banco"
}

# ── o ponto de recuperação inicial ──────────────────────────────────────────
executar /usr/local/bin/backup.sh
[ "$codigo" = 0 ] || { echo "$saida"; pare "o primeiro backup falhou"; }
printf '%s' "$saida" | grep -q 'ciclo concluído com sucesso' || pare "o primeiro backup não disse que concluiu"
executar /usr/local/bin/backup.sh
[ "$(snapshots banco)" = 2 ] || pare "esperava 2 snapshots do banco, há $(snapshots banco)"
N_BANCO=2; ANTES=$(ultimo)
ok "dois backups bons: 2 pontos de recuperação"

# ── 1, 2 e 5: as falhas do dump — a retenção, se rodasse, apagaria um (1/dia) ─
PG_SENHA=senha-errada; KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
falhou_sem_mexer "o pg_dump que não conecta" "ERRO: o dump do banco falhou"
ok "o pg_dump que não conecta: código $codigo, sem sucesso, sem retenção, nenhum snapshot novo nem apagado"

SHIM=pg_dump:pg_dump-cai-no-meio; KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
falhou_sem_mexer "o pg_dump que cai no meio" "ERRO: o dump do banco falhou"
ok "o pg_dump que cai no meio do fluxo: nenhum snapshot parcial, sem sucesso, sem retenção"

SHIM=restic:restic-falha-no-backup; KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
falhou_sem_mexer "o restic que falha no backup" "ERRO: o dump do banco falhou"
ok "o restic que falha no passo do dump: sem sucesso, sem retenção, pontos intactos"

R_SENHA=senha-errada; KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
falhou_sem_mexer "a senha errada do repositório" "ERRO: o repositório restic não abriu (código 12"
printf '%s' "$saida" | grep -q 'inicializando' && pare "a senha errada tentou inicializar o repositório"
ok "a senha errada do repositório: o código 12 no log, nenhum init por cima, pontos intactos"

# ── 1 e 2: o storage ilegível — o restic sai com 3 e o parcial é descartado ──
N_STORAGE=$(snapshots storage)
docker volume create "$STORAGE" >/dev/null
docker run --rm -v "$STORAGE:/s" alpine:3.21 sh -c 'echo fictício > /s/ilegivel && chmod 000 /s/ilegivel'
OPC="-v $STORAGE:/data/storage:ro"; KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
docker volume rm "$STORAGE" >/dev/null
[ "$codigo" != 0 ] || { echo "$saida"; pare "a falha do storage saiu com código 0"; }
printf '%s' "$saida" | grep -q 'ERRO: o backup do storage falhou: nenhum snapshot do storage deste ciclo ficou' \
  || { echo "$saida"; pare "a falha do storage sem a mensagem de erro"; }
for frase in 'storage concluído' 'aplicando retenção' 'ciclo concluído com sucesso'; do
  printf '%s' "$saida" | grep -q "$frase" && { echo "$saida"; pare "a falha do storage: apareceu '$frase'"; }
done
[ "$(snapshots storage)" = "$N_STORAGE" ] || pare "ficou o snapshot parcial do storage ($(snapshots storage), esperado $N_STORAGE)"
# o dump deste ciclo foi gravado antes do storage; a retenção (1 por dia) não rodou
[ "$(snapshots banco)" = 3 ] || pare "a falha do storage: esperava 3 snapshots do banco (sem retenção), há $(snapshots banco)"
N_BANCO=3; ANTES=$(ultimo)
ok "o storage ilegível: código $codigo, o snapshot parcial dele descartado, a retenção não rodou"

# ── 3: o agendador — a falha registrada, e o próximo ciclo tenta de novo ──────
PG_SENHA=senha-errada
executar /usr/local/bin/backup.sh --ciclo; limpa
[ "$codigo" = 0 ] || { echo "$saida"; pare "o agendador caiu com o ciclo que falhou (código $codigo)"; }
printf '%s' "$saida" | grep -q 'ERRO: ciclo falhou (código 1) — o próximo horário tenta de novo' \
  || { echo "$saida"; pare "o agendador não registrou a falha"; }
sem_sucesso "o ciclo que falhou"
[ "$(ultimo)" = "$ANTES" ] || pare "o ciclo que falhou gravou um snapshot"
# o LAÇO de verdade (o CMD da imagem), com o `sleep` que não dorme: duas
# voltas, as duas falham, e o laço segue para a seguinte. O relógio fixo às
# 08:09:08 e o BACKUP_AT 08:09: os campos com zero à esquerda (octal inválido
# no shell) que derrubavam o laço; a espera certa é 86392 s
PG_SENHA=senha-errada; SHIM="sleep:sleep-nao-dorme date:date-com-zeros"; OPC="-e BACKUP_AT=08:09"
executar /usr/local/bin/backup.sh --loop; limpa
[ "$(printf '%s\n' "$saida" | grep -c 'próximo ciclo em 86392s')" = 3 ] || { echo "$saida"; pare "o laço não calculou a espera com o relógio às 08:09:08"; }
[ "$(printf '%s\n' "$saida" | grep -c 'ERRO: ciclo falhou (código 1) — o próximo horário tenta de novo')" = 2 ] \
  || { echo "$saida"; pare "o laço não registrou as duas falhas seguidas"; }
[ "$(printf '%s\n' "$saida" | grep -c 'próximo ciclo em')" = 3 ] || { echo "$saida"; pare "o laço não voltou a agendar"; }
sem_sucesso "o laço com os ciclos que falham"
[ "$(ultimo)" = "$ANTES" ] || pare "o laço com os ciclos que falham gravou um snapshot"
executar /usr/local/bin/backup.sh --ciclo
printf '%s' "$saida" | grep -q 'ciclo concluído com sucesso' || { echo "$saida"; pare "o ciclo seguinte não concluiu"; }
[ "$(ultimo)" != "$ANTES" ] || pare "o ciclo seguinte não gravou o snapshot novo"
ok "o agendador: o laço registrou as falhas e seguiu agendando, e o ciclo seguinte concluiu"

# ── 2: a retenção roda depois de um backup BOM (o contraste) ────────────────
KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
printf '%s' "$saida" | grep -q 'aplicando retenção' || pare "a retenção não rodou depois do backup bom"
[ "$(snapshots banco)" = 1 ] || pare "a retenção do backup bom deixou $(snapshots banco) snapshots (esperado 1)"
ok "a retenção só roda depois de um backup bom (sobrou 1, a política pedida)"

# ── 5: o snapshot da janela sobrevive à retenção — no MESMO host e caminho, ──
# onde a política de dias o apagaria
rodar restic backup --stdin-from-command --stdin-filename banco.dump --tag banco --tag staging --tag janela \
  --host veyra-staging -- pg_dump --format=custom --no-owner --no-privileges >/dev/null
JANELA=$(ultimo janela)
KEEP=1; KEEP_S=0; KEEP_M=0
executar /usr/local/bin/backup.sh; limpa
printf '%s' "$saida" | grep -q 'ciclo concluído com sucesso' || { echo "$saida"; pare "o backup depois da janela falhou"; }
[ -n "$JANELA" ] && [ "$(ultimo janela)" = "$JANELA" ] || pare "a retenção apagou o snapshot da janela"
ok "o snapshot da janela sobrevive à retenção de 1 por dia (--keep-tag janela)"

# ── 4: a restauração — sempre num banco NOVO, tudo ou nada ──────────────────
BOM=$(ultimo)
TAM=$(rodar restic dump "$BOM" /banco.dump | wc -c | tr -d ' ')
[ "$TAM" -gt 10000 ] || pare "o dump bom tem só $TAM bytes"
# o dump inteiro num arquivo, e só então cortado: um `restic dump | head` mataria
# o restic no meio (SIGPIPE) e deixaria um lock no repositório
rodar sh -c "restic dump $BOM /banco.dump > /tmp/inteiro && head -c $((TAM * 8 / 10)) /tmp/inteiro | restic backup --stdin --stdin-filename banco.dump --tag truncado --host veyra-teste" >/dev/null
TRUNCADO=$(ultimo truncado)

PG_BANCO=vivo
executar /usr/local/bin/restore.sh banco "$BOM" vivo; limpa
[ "$codigo" = 64 ] || { echo "$saida"; pare "restaurar sobre o banco vivo não foi recusado (código $codigo)"; }
vivo_intacto "o banco vivo como alvo"
PG_BANCO=vivo
executar /usr/local/bin/restore.sh banco "$BOM" origem; limpa
[ "$codigo" = 64 ] || { echo "$saida"; pare "restaurar sobre um banco que existe não foi recusado (código $codigo)"; }
[ "$(echo 'SELECT count(*) FROM paciente_ficticio' | sql origem)" = 20000 ] || pare "a recusa mexeu no banco que existe"
ok "nem o banco vivo nem um banco que já existe são alvo (recusa 64, nada tocado)"

PG_BANCO=vivo
executar /usr/local/bin/restore.sh banco "$TRUNCADO" restaurado_truncado; limpa
[ "$codigo" != 0 ] || { echo "$saida"; pare "a restauração do dump truncado saiu com código 0"; }
printf '%s' "$saida" | grep -q 'restauração concluída' && pare "o dump truncado disse que concluiu"
printf '%s' "$saida" | grep -q 'o banco novo restaurado_truncado foi descartado' \
  || { echo "$saida"; pare "o dump truncado sem a mensagem de erro"; }
[ "$(banco_existe restaurado_truncado)" = 0 ] || pare "o banco novo do dump truncado ficou"
vivo_intacto "o dump truncado"
ok "o dump truncado (80% de $TAM bytes): falhou, o banco novo foi descartado, o vivo não foi tocado"

PG_BANCO=vivo; SHIM=restic:restic-dump-sai-com-erro
executar /usr/local/bin/restore.sh banco "$BOM" restaurado_restic_falho; limpa
[ "$codigo" != 0 ] || { echo "$saida"; pare "o restic que sai com erro depois do fluxo: código 0"; }
printf '%s' "$saida" | grep -q 'restauração concluída' && pare "o restic com erro disse que concluiu"
[ "$(banco_existe restaurado_restic_falho)" = 0 ] || pare "o banco novo do restic com erro ficou (o pipefail não pegou)"
vivo_intacto "o restic que sai com erro"
ok "o restic que sai com erro depois de entregar o fluxo: o banco novo foi descartado, o vivo não foi tocado"

# o descarte que falha: a mensagem diz que o banco novo ficou, e não o contrário
PG_BANCO=vivo; SHIM=dropdb:sai-com-erro
executar /usr/local/bin/restore.sh banco "$TRUNCADO" restaurado_sem_descarte; limpa
[ "$codigo" != 0 ] || { echo "$saida"; pare "a restauração sem descarte saiu com código 0"; }
printf '%s' "$saida" | grep -q 'foi descartado' && { echo "$saida"; pare "o descarte falhou, e a mensagem disse que descartou"; }
printf '%s' "$saida" | grep -q 'o banco novo restaurado_sem_descarte NÃO pôde ser descartado: remova-o antes de repetir' \
  || { echo "$saida"; pare "o descarte que falhou sem a mensagem"; }
[ "$(banco_existe restaurado_sem_descarte)" = 1 ] || pare "o caso do descarte que falha não deixou o banco (o teste não provou nada)"
echo "DROP DATABASE restaurado_sem_descarte;" | sql origem
vivo_intacto "o descarte que falha"
ok "o descarte que falha: a mensagem diz que o banco novo ficou, e o vivo não foi tocado"

PG_BANCO=vivo
executar /usr/local/bin/restore.sh banco 00000000 restaurado_sem_snapshot; limpa
[ "$codigo" != 0 ] || pare "a restauração de snapshot inexistente saiu com código 0"
printf '%s' "$saida" | grep -q 'restauração concluída' && pare "o snapshot inexistente disse que concluiu"
[ "$(banco_existe restaurado_sem_snapshot)" = 0 ] || pare "o banco novo do snapshot inexistente ficou"
vivo_intacto "o snapshot inexistente"
ok "o snapshot inexistente: falhou, nada ficou, o vivo não foi tocado"

PG_BANCO=vivo
executar /usr/local/bin/restore.sh banco "$BOM" restaurado_bom; limpa
[ "$codigo" = 0 ] || { echo "$saida"; pare "a restauração do snapshot bom falhou"; }
[ "$(echo 'SELECT count(*) FROM paciente_ficticio' | sql restaurado_bom)" = 20000 ] || pare "a restauração boa não trouxe os 20000"
vivo_intacto "a restauração boa"
ok "o snapshot bom restaura inteiro (20000 linhas) num banco novo, e o vivo não foi tocado"

# ── o caminho do §6 e do PO-2 (DEPLOY_STAGING): o dump direto do restic para
# o pg_restore de um Postgres SEM rede, e a troca pelo nome com o MESMO SQL ───
docker run -d --name "$ENSAIO" --network none -e POSTGRES_PASSWORD=ensaio postgres:17-alpine >/dev/null
n=0; until docker exec "$ENSAIO" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -lt 60 ] || pare "o Postgres do ensaio não subiu"; sleep 1; done
docker exec "$ENSAIO" sh -c 'createdb -U postgres vivo && createdb -U postgres restaurado'
docker exec "$ENSAIO" psql -U postgres -d vivo -qc 'CREATE TABLE sentinela (x int); INSERT INTO sentinela VALUES (42)'
( set -o pipefail
  rodar restic dump "$BOM" /banco.dump \
    | docker exec -i "$ENSAIO" pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U postgres -d restaurado
) || pare "o pipe do PO-2 falhou"
trocar() {  # $1 o vivo, $2 o novo, $3 o nome do antigo — o SQL do §6, passo 4, na mesma forma
  printf '%s\n' \
    "SELECT count(pg_terminate_backend(pid)) AS encerradas FROM pg_stat_activity WHERE datname = :'vivo' AND pid <> pg_backend_pid();" \
    'BEGIN;' 'ALTER DATABASE :"vivo" RENAME TO :"falho";' 'ALTER DATABASE :"novo" RENAME TO :"vivo";' 'COMMIT;' \
    | docker exec -i "$ENSAIO" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -v vivo="$1" -v novo="$2" -v falho="$3"
}
# uma sessão aberta no vivo é encerrada pela troca
docker exec -d "$ENSAIO" psql -U postgres -d vivo -c 'SELECT pg_sleep(60)'
sleep 2
trocar vivo restaurado vivo_falho > /dev/null || pare "a troca pelo nome falhou"
[ "$(docker exec "$ENSAIO" psql -U postgres -d vivo -Atc 'SELECT count(*) FROM paciente_ficticio')" = 20000 ] \
  || pare "a troca: o vivo não é o restaurado"
[ "$(docker exec "$ENSAIO" psql -U postgres -d vivo_falho -Atc 'SELECT x FROM sentinela')" = 42 ] \
  || pare "a troca: o banco antigo não ficou guardado"
# a segunda renomeação falha (há uma sessão no banco novo): a transação desfaz
# a primeira, e o vivo continua com o nome
docker exec "$ENSAIO" createdb -U postgres outro
docker exec -d "$ENSAIO" psql -U postgres -d outro -c 'SELECT pg_sleep(60)'
sleep 2
set +e; trocar vivo outro vivo_falho2 > "$SHIMS/troca.log" 2>&1; c=$?; set -e
[ "$c" != 0 ] || pare "a troca com o banco novo em uso não falhou"
grep -q 'is being accessed by other users' "$SHIMS/troca.log" || { cat "$SHIMS/troca.log"; pare "a troca falhou por outro motivo"; }
[ "$(docker exec "$ENSAIO" psql -U postgres -d vivo -Atc 'SELECT count(*) FROM paciente_ficticio')" = 20000 ] \
  || pare "a troca que falhou deixou o vivo sem o nome"
[ "$(docker exec "$ENSAIO" psql -U postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = 'vivo_falho2'")" = 0 ] \
  || pare "a troca que falhou deixou a primeira renomeação"
ok "o PO-2 e o §6: o dump pelo pipe num Postgres sem rede, a troca pelo nome, e a troca que falha desfaz as duas"

# ── a restauração do storage do §6: os arquivos voltam à RAIZ do volume ──────
docker volume create "$STORAGE" >/dev/null
docker run --rm -v "$STORAGE:/s" alpine:3.21 sh -c 'mkdir -p /s/ws1 && echo fictício > /s/ws1/arquivo.txt'
OPC="-v $STORAGE:/data/storage:ro"
executar /usr/local/bin/backup.sh; limpa
printf '%s' "$saida" | grep -q 'ciclo concluído com sucesso' || { echo "$saida"; pare "o backup com storage falhou"; }
ID_STORAGE=$(ultimo storage)
[ -n "$ID_STORAGE" ] || pare "o backup com storage não gravou o snapshot do storage"
docker volume create "$VOLTA" >/dev/null
OPC="--user 0 -v $VOLTA:/alvo"
executar sh -c "restore.sh storage $ID_STORAGE /tmp/r && cp -a /tmp/r/data/storage/. /alvo/"; limpa
[ "$codigo" = 0 ] || { echo "$saida"; pare "a restauração do storage falhou"; }
[ "$(docker run --rm -v "$VOLTA:/v" alpine:3.21 cat /v/ws1/arquivo.txt)" = fictício ] \
  || pare "o storage não voltou para a raiz do volume"
ok "a restauração do storage do §6: os arquivos voltam à raiz do volume"

echo "TESTES_DE_FALHA_OK"

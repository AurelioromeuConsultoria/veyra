#!/bin/sh
# Restauração — deliberadamente MANUAL e explícita. Nada aqui roda sozinho:
# restaurar por engano destrói o estado atual, e o roteiro completo está em
# docs/DEPLOY_STAGING.md (§6 e §14).
#
#   restore.sh listar
#   restore.sh banco   <snapshot-id> <banco-novo>   # restaura num banco NOVO
#   restore.sh storage <snapshot-id> [destino]
#
# O BANCO é sempre restaurado num banco NOVO, que o script cria e que não pode
# existir: nunca sobre o banco vivo (ADR-046 adendo 1). Restaurar por cima de um
# banco já migrado falharia sempre (as tabelas novas têm FK para as do dump) ou
# deixaria objetos que o dump não conhece. Depois, com a API parada e a
# barreira de manutenção, o roteiro confere o banco novo e o troca pelo nome
# (ALTER DATABASE … RENAME), guardando o antigo para diagnóstico.
set -eu
# a falha do `restic dump` no meio do pipe é a falha do pipe
set -o pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

case "${1:-}" in
  listar)
    restic snapshots --compact
    ;;
  banco)
    id="${2:?uso: restore.sh banco <snapshot-id> <banco-novo>}"
    novo="${3:?uso: restore.sh banco <snapshot-id> <banco-novo> — o banco novo é obrigatório}"
    case "$novo" in
      *[!a-z0-9_]* | "") log "ERRO: o nome do banco novo só aceita a-z, 0-9 e _"; exit 64 ;;
    esac
    [ "$novo" != "${PGDATABASE:-}" ] || { log "ERRO: o banco novo não pode ser o banco vivo (${PGDATABASE})"; exit 64; }
    existe=$(psql -X -At -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$novo'") \
      || { log "ERRO: não foi possível consultar o servidor ${PGHOST}"; exit 1; }
    [ -z "$existe" ] || { log "ERRO: o banco $novo já existe: escolha outro nome (nada foi feito)"; exit 64; }
    createdb "$novo" || { log "ERRO: não foi possível criar o banco $novo"; exit 1; }
    log "restaurando o snapshot $id no banco NOVO $novo em ${PGHOST} (o ${PGDATABASE:-banco vivo} não é tocado)"
    # `--single-transaction` (com `--exit-on-error`): tudo ou nada. Sem
    # `--clean`: o banco é novo. O CAMINHO do arquivo, não `/`: `restic dump
    # <id> /` devolveria o diretório como tar, e o `pg_restore` falha
    # procurando `toc.dat`
    if restic dump "$id" "/${DUMP_NOME:-banco.dump}" \
      | pg_restore --single-transaction --exit-on-error --no-owner --no-privileges \
          --dbname "$novo"; then
      log "restauração concluída no banco NOVO $novo — confira-o (DEPLOY_STAGING §14, PO-2) antes de trocá-lo pelo nome; rode as migrations pendentes depois"
    else
      # qual lado falhou não importa: o banco novo é descartado inteiro, e o
      # banco vivo nunca foi tocado. O descarte é conferido: a mensagem não
      # afirma o que não aconteceu
      if dropdb --if-exists "$novo" >/dev/null 2>&1; then
        log "ERRO: a restauração falhou; o banco novo $novo foi descartado, e o ${PGDATABASE:-banco vivo} não foi tocado"
      else
        log "ERRO: a restauração falhou, e o banco novo $novo NÃO pôde ser descartado: remova-o antes de repetir (o ${PGDATABASE:-banco vivo} não foi tocado)"
      fi
      exit 1
    fi
    ;;
  storage)
    id="${2:?uso: restore.sh storage <snapshot-id> [destino]}"
    destino="${3:-/data/restore}"
    mkdir -p "$destino"
    restic restore "$id" --target "$destino" || { log "ERRO: a restauração do storage falhou"; exit 1; }
    # o restic recria o caminho original: os arquivos ficam em <destino>/data/storage
    log "storage restaurado em ${destino}/data/storage — copie para o volume com o serviço PARADO"
    ;;
  *)
    echo "uso: restore.sh {listar|banco <id> <banco-novo>|storage <id> [destino]}" >&2
    exit 64
    ;;
esac

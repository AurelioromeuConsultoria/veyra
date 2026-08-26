#!/bin/sh
# Restauração — deliberadamente MANUAL e explícita. Nada aqui roda sozinho:
# restaurar por engano destrói o estado atual, e o roteiro completo está em
# docs/DEPLOY_STAGING.md.
#
#   restore.sh listar
#   restore.sh banco   <snapshot-id>   # restaura o dump para o banco corrente
#   restore.sh storage <snapshot-id> [destino]
set -eu

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

case "${1:-}" in
  listar)
    restic snapshots --compact
    ;;
  banco)
    id="${2:?uso: restore.sh banco <snapshot-id>}"
    log "ATENÇÃO: isto SOBRESCREVE objetos do banco ${PGDATABASE} em ${PGHOST}"
    # `--clean --if-exists`: recria objetos existentes em vez de falhar no meio,
    # deixando o banco pela metade
    # o CAMINHO do arquivo, não `/`: `restic dump <id> /` devolveria o
    # diretório empacotado em tar, e o `pg_restore` falha procurando `toc.dat`
    restic dump "$id" "/${DUMP_NOME:-banco.dump}" \
      | pg_restore --clean --if-exists --no-owner --no-privileges \
          --dbname "$PGDATABASE"
    log "restauração do banco concluída — rode as migrations pendentes depois"
    ;;
  storage)
    id="${2:?uso: restore.sh storage <snapshot-id> [destino]}"
    destino="${3:-/data/restore}"
    mkdir -p "$destino"
    restic restore "$id" --target "$destino"
    log "storage restaurado em ${destino} — copie para o volume com o serviço PARADO"
    ;;
  *)
    echo "uso: restore.sh {listar|banco <id>|storage <id> [destino]}" >&2
    exit 64
    ;;
esac

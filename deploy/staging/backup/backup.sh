#!/bin/sh
# Backup do Veyra: dump lógico do Postgres + storage, ambos para o repositório
# restic configurado em RESTIC_REPOSITORY.
#
#   backup.sh          → executa UMA vez e sai (usado pelo comando manual)
#   backup.sh --loop   → agenda diariamente em BACKUP_AT (HH:MM) — é o CMD
#
# Sem daemon de cron: o laço dorme até o horário e loga cada ciclo em stdout,
# então `docker compose logs backup` conta a história inteira. Cron em
# container manda saída para lugar nenhum por padrão, e backup que falha em
# silêncio é pior que backup ausente.
set -eu

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Nome do dump DENTRO do snapshot. Fixo de propósito: é o caminho que
# `restore.sh` usa, e os dois precisam concordar.
DUMP_NOME="banco.dump"

exigir() {
  eval "valor=\${$1:-}"
  [ -n "$valor" ] || { log "ERRO: variável $1 é obrigatória"; exit 78; }
}

executar_backup() {
  exigir RESTIC_REPOSITORY
  exigir RESTIC_PASSWORD
  exigir PGHOST
  exigir PGDATABASE

  # inicializa o repositório na primeira execução; `cat` porque o erro de
  # "já existe" é esperado e não deve derrubar o ciclo
  if ! restic cat config >/dev/null 2>&1; then
    log "repositório restic ainda não existe — inicializando"
    restic init
  fi

  # ── banco ────────────────────────────────────────────────────────────────
  # `-Fc` (custom): permite restauração seletiva de tabela e é comprimido.
  # O dump vai por STDIN para o restic: nada de arquivo temporário com dado do
  # cliente sobrando no disco do container.
  log "dump de ${PGDATABASE} em ${PGHOST}"
  # NOME FIXO no snapshot. Com nome variável (data no arquivo), a restauração
  # precisa adivinhar o caminho dentro do snapshot; `restic dump <id> /`
  # devolve o DIRETÓRIO como tar, o `pg_restore` recebe um tar e falha
  # procurando `toc.dat`. O snapshot já carrega a data — o arquivo não precisa.
  pg_dump --format=custom --no-owner --no-privileges \
    | restic backup --stdin --stdin-filename "$DUMP_NOME" \
        --tag banco --tag staging --host veyra-staging
  log "dump concluído"

  # ── storage ──────────────────────────────────────────────────────────────
  if [ -d /data/storage ]; then
    log "storage de arquivos"
    restic backup /data/storage --tag storage --tag staging --host veyra-staging
    log "storage concluído"
  else
    log "AVISO: /data/storage ausente — nada a copiar"
  fi

  # ── retenção ─────────────────────────────────────────────────────────────
  # `--prune` no mesmo passo: retenção sem prune só marca, não libera espaço,
  # e o custo do destino externo cresce sem ninguém notar.
  log "aplicando retenção (${RESTIC_KEEP_DAILY:-7}d / ${RESTIC_KEEP_WEEKLY:-4}s / ${RESTIC_KEEP_MONTHLY:-6}m)"
  restic forget --prune \
    --keep-daily "${RESTIC_KEEP_DAILY:-7}" \
    --keep-weekly "${RESTIC_KEEP_WEEKLY:-4}" \
    --keep-monthly "${RESTIC_KEEP_MONTHLY:-6}"

  # ── verificação ──────────────────────────────────────────────────────────
  # Backup que ninguém testa não é backup. `check` valida a estrutura do
  # repositório a cada ciclo; a leitura de dados (--read-data-subset) é cara e
  # roda por amostragem.
  log "verificando integridade do repositório"
  restic check --read-data-subset="${RESTIC_CHECK_SUBSET:-1/14}"
  log "ciclo concluído com sucesso"
}

# Segundos até o próximo HH:MM (UTC), em aritmética pura.
#
# `date -d "today 03:15"` é GNU e `date -j -f` é BSD; a imagem é Alpine, cujo
# `date` é busybox e não tem nenhum dos dois. As duas tentativas falhavam em
# silêncio, o cálculo virava número negativo e o `sleep` derrubava o container
# em laço — com o backup jamais rodando.
segundos_ate() {
  alvo="$1"
  case "$alvo" in
    [0-9][0-9]:[0-9][0-9]) : ;;
    *) log "ERRO: BACKUP_AT inválido ('$alvo') — use HH:MM"; exit 78 ;;
  esac

  # zero à esquerda é octal em aritmética POSIX: "08" seria erro
  hora=$(( ${alvo%%:*} + 0 ))
  minuto=$(( ${alvo##*:} + 0 ))
  [ "$hora" -le 23 ] && [ "$minuto" -le 59 ] || {
    log "ERRO: BACKUP_AT fora de faixa ('$alvo')"; exit 78
  }

  agora=$(date -u '+%H %M %S')
  set -- $agora
  atual=$(( ($1 + 0) * 3600 + ($2 + 0) * 60 + ($3 + 0) ))
  restante=$(( hora * 3600 + minuto * 60 - atual ))
  [ "$restante" -le 0 ] && restante=$(( restante + 86400 ))
  echo "$restante"
}

if [ "${1:-}" = "--loop" ]; then
  log "backup agendado diariamente às ${BACKUP_AT:-03:15} UTC"
  while true; do
    espera=$(segundos_ate "${BACKUP_AT:-03:15}")
    log "próximo ciclo em ${espera}s"
    sleep "$espera"
    # uma falha NÃO derruba o agendador: o próximo ciclo tenta de novo, e o
    # erro fica no log com código
    if executar_backup; then :; else log "ERRO: ciclo falhou (código $?)"; fi
  done
else
  executar_backup
fi

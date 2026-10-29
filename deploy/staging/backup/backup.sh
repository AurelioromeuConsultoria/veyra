#!/bin/sh
# Backup do Veyra: dump lógico do Postgres + storage, ambos para o repositório
# restic configurado em RESTIC_REPOSITORY.
#
#   backup.sh          → executa UMA vez e sai (usado pelo comando manual);
#                        código ≠ 0 em qualquer falha, sem mensagem de sucesso
#   backup.sh --loop   → agenda diariamente em BACKUP_AT (HH:MM) — é o CMD
#   backup.sh --ciclo  → UM ciclo do agendador, já, como o laço o faria: o
#                        código é sempre 0 (o agendador segue); a falha fica
#                        no log. Para conferir à mão, use `backup.sh` sem
#                        argumento, que devolve o código do ciclo
#
# Sem daemon de cron: o laço dorme até o horário e loga cada ciclo em stdout,
# então `docker compose logs backup` conta a história inteira. Cron em
# container manda saída para lugar nenhum por padrão, e backup que falha em
# silêncio é pior que backup ausente.
set -eu
# a falha de qualquer comando de um pipe é a falha do pipe (busybox ash, o
# shell da imagem, suporta). Não basta sozinho: cada passo abaixo também
# confere o próprio resultado (ADR-046 adendo 1)
set -o pipefail

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# a falha de um passo encerra o ciclo AQUI: nada de "concluído" depois dela, e
# a retenção não roda
falhar() { log "ERRO: $*"; exit 1; }

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

  # inicializa o repositório SÓ quando ele não existe (código 10 do restic
  # 0.17). Senha errada (12), destino fora do ar ou lock são falha, nunca um
  # `init` por cima
  if restic cat config >/dev/null 2>&1; then
    :
  else
    codigo=$?
    [ "$codigo" = 10 ] || falhar "o repositório restic não abriu (código $codigo: senha, destino ou rede)"
    log "repositório restic ainda não existe — inicializando"
    restic init || falhar "restic init falhou"
  fi
  # a marca deste ciclo: o snapshot parcial dele, se houver, é descartado
  CICLO="ciclo-$(date -u +%Y%m%dT%H%M%SZ)-$$"

  # ── banco ────────────────────────────────────────────────────────────────
  # `-Fc` (custom): permite restauração seletiva de tabela e é comprimido.
  # O dump vai por STDIN para o restic: nada de arquivo temporário com dado do
  # cliente sobrando no disco do container.
  log "dump de ${PGDATABASE} em ${PGHOST}"
  # NOME FIXO no snapshot. Com nome variável (data no arquivo), a restauração
  # precisa adivinhar o caminho dentro do snapshot; `restic dump <id> /`
  # devolve o DIRETÓRIO como tar, o `pg_restore` recebe um tar e falha
  # procurando `toc.dat`. O snapshot já carrega a data — o arquivo não precisa.
  #
  # `--stdin-from-command` (restic 0.17): o restic roda o `pg_dump` e NÃO cria
  # o snapshot se ele sair com erro. Num pipe, o restic gravaria um snapshot
  # parcial com o que recebeu até a falha — e ele viraria o "mais recente"
  restic backup --stdin-from-command --stdin-filename "$DUMP_NOME" \
      --tag banco --tag staging --host veyra-staging \
      -- pg_dump --format=custom --no-owner --no-privileges \
    || falhar "o dump do banco falhou: nenhum snapshot do banco foi gravado neste ciclo"
  log "dump concluído"

  # ── storage ──────────────────────────────────────────────────────────────
  if [ -d /data/storage ]; then
    log "storage de arquivos"
    if ! restic backup /data/storage --tag storage --tag staging --tag "$CICLO" --host veyra-staging; then
      # um arquivo ilegível faz o restic sair com 3 e gravar um snapshot
      # INCOMPLETO, que viraria o mais recente: ele é descartado aqui, PELO ID —
      # `forget` só com a tag, sem política, não remove nada
      lista=$(restic snapshots --tag "storage,$CICLO" --json) \
        || falhar "o backup do storage falhou, e não deu para conferir se ficou um snapshot parcial (tag $CICLO)"
      parciais=$(printf '%s' "$lista" | grep -o '"short_id":"[0-9a-f]*"' | cut -d'"' -f4) || true
      if [ -n "$parciais" ]; then
        # shellcheck disable=SC2086
        restic forget $parciais >/dev/null \
          || falhar "o backup do storage falhou, e o snapshot parcial ($parciais) não foi descartado: remova-o à mão"
      fi
      falhar "o backup do storage falhou: nenhum snapshot do storage deste ciclo ficou"
    fi
    log "storage concluído"
  else
    log "AVISO: /data/storage ausente — nada a copiar"
  fi

  # ── retenção ─────────────────────────────────────────────────────────────
  # `--prune` no mesmo passo: retenção sem prune só marca, não libera espaço,
  # e o custo do destino externo cresce sem ninguém notar.
  log "aplicando retenção (${RESTIC_KEEP_DAILY:-7}d / ${RESTIC_KEEP_WEEKLY:-4}s / ${RESTIC_KEEP_MONTHLY:-6}m)"
  # `--keep-tag janela`: o snapshot da janela de manutenção (DEPLOY_STAGING
  # §14) é o ponto exato antes das migrations, e a política de dias não o
  # apaga; ele sai à mão, depois da retomada confirmada
  restic forget --prune --keep-tag janela \
    --keep-daily "${RESTIC_KEEP_DAILY:-7}" \
    --keep-weekly "${RESTIC_KEEP_WEEKLY:-4}" \
    --keep-monthly "${RESTIC_KEEP_MONTHLY:-6}" \
    || falhar "a retenção falhou"

  # ── verificação ──────────────────────────────────────────────────────────
  # Backup que ninguém testa não é backup. `check` valida a estrutura do
  # repositório a cada ciclo; a leitura de dados (--read-data-subset) é cara e
  # roda por amostragem.
  log "verificando integridade do repositório"
  restic check --read-data-subset="${RESTIC_CHECK_SUBSET:-1/14}" \
    || falhar "a verificação do repositório falhou"
  log "ciclo concluído com sucesso"
}

# O valor decimal de um campo de dois dígitos do relógio. Zero à esquerda é
# octal na aritmética do shell, e "08" e "09" são octais INVÁLIDOS: `$(( 08 + 0 ))`
# é erro, não 8. Às 08 ou 09 de qualquer campo, o laço caía (e com BACKUP_AT
# 08:xx ou 09:xx, nunca agendava). O zero sai antes da conta.
decimal() { v=${1#0}; echo "${v:-0}"; }

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

  hora=$(decimal "${alvo%%:*}")
  minuto=$(decimal "${alvo##*:}")
  [ "$hora" -le 23 ] && [ "$minuto" -le 59 ] || {
    log "ERRO: BACKUP_AT fora de faixa ('$alvo')"; exit 78
  }

  agora=$(date -u '+%H %M %S')
  set -- $agora
  atual=$(( $(decimal "$1") * 3600 + $(decimal "$2") * 60 + $(decimal "$3") ))
  restante=$(( hora * 3600 + minuto * 60 - atual ))
  [ "$restante" -le 0 ] && restante=$(( restante + 86400 ))
  echo "$restante"
}

# Um ciclo do agendador, num PROCESSO PRÓPRIO. Chamar a função dentro de um
# `if` desligaria o `set -e` dela inteira (é a regra do shell: comandos na
# condição de um `if` não disparam o -e), e a falha no meio seguiria até a
# retenção e o "concluído". O filho roda com o -e e o pipefail valendo; o pai
# só lê o código. Uma falha NÃO derruba o agendador: o próximo horário tenta de
# novo, e o erro fica no log com o código.
um_ciclo() {
  # `/bin/sh "$0"`: não depende do bit de execução nem do PATH
  if /bin/sh "$0"; then
    :
  else
    log "ERRO: ciclo falhou (código $?) — o próximo horário tenta de novo"
  fi
}

case "${1:-}" in
  --loop)
    log "backup agendado diariamente às ${BACKUP_AT:-03:15} UTC"
    while true; do
      espera=$(segundos_ate "${BACKUP_AT:-03:15}")
      log "próximo ciclo em ${espera}s"
      sleep "$espera"
      um_ciclo
    done
    ;;
  # UM ciclo do agendador, sem esperar o horário: o mesmo `um_ciclo` do laço
  # (é o que os testes de falha exercitam)
  --ciclo) um_ciclo ;;
  "") executar_backup ;;
  *) echo "uso: backup.sh [--loop | --ciclo]" >&2; exit 64 ;;
esac

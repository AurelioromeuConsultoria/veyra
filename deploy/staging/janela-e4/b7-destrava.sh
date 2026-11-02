# E-4 — BLOCO 7: DESTRAVA, na RETOMADA (G7). Desliga a trava de manutenção no
# banco. A API que está rodando continua em manutenção (decide na subida): só o
# Redeploy com MAINTENANCE_MODE=false, DEPOIS deste bloco, abre. Depois do
# Redeploy, o bloco 8. Só com a janela concluída (DEMO_CLINICS_OK) E as duas
# migrations da janela no banco: fora disso (a janela interrompida, a volta do
# banco), a trava FICA, e os serviços ficam parados ou em manutenção. A
# reabertura com o 2b6deb1, que ignora a trava, é EXCEÇÃO: só com autorização
# específica, a imagem exata conferida e o banco compatível com o snapshot.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; URL="${E4_URL:-https://veyra-staging.malachdigital.com.br}"; umask 077; mkdir -p "$D"; chmod 700 "$D"
  pare() { echo "PARE: $*"; exit 1; }
  rodando() { docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1"; }
  nome() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  env_de() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}'; }
  # só o ambiente NÃO secreto vai para variável (o resto nunca passa por here-string)
  nao_secreto() { env_de "$1" | grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV|NODE_ENV|SOURCE_COMMIT)=' || true; }
  parar() { if docker stop "$1" >/dev/null; then echo "parado agora: $1"; else echo "FALHA DE CONTENÇÃO: não foi possível parar $1"; fi; }
  # a CONTENÇÃO: para a API e o web e diz o que sobrou (também em CONTENCAO, para
  # a mensagem de quem a chama). Parar depois não é a barreira (a trava é); o que
  # continuar rodando é FALHA DE CONTENÇÃO, e nada afirma a manutenção
  conter() {
    for s in api web; do for id in $(rodando "$s"); do parar "$id"; done; done
    r=$(rodando api; rodando web || true)
    if [ -n "$r" ]; then
      CONTENCAO="FALHA DE CONTENÇÃO: a manutenção NÃO está garantida"
      echo "FALHA DE CONTENÇÃO: ainda rodando: $(printf '%s ' $r)— a manutenção NÃO está garantida; pare à mão (docker stop ou docker kill) e confira com docker ps"
    else
      CONTENCAO="contidos: nenhuma API nem web rodando"
      echo "contido: nenhuma API nem web rodando"
    fi
  }
  # a TRAVA de manutenção no banco (ADR-053, adendo 1): '' se não houver
  trava() { docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT coalesce(current_setting('"'"'veyra.manutencao'"'"', true), '"'"''"'"')"'; }
  # a GARANTIA é a trava ligada; a conferência ADICIONAL, o ambiente de cada API rodando
  barreira() {
    t=$(trava) || t='(não lida)'
    [ "$t" = ligada ] || { conter; pare "a trava de manutenção no banco não está ligada ($t): rode o bloco 1"; }
    for id in $(rodando api); do
      env_de "$id" | grep -x 'MAINTENANCE_MODE=true' >/dev/null || { conter; pare "uma API rodando com MAINTENANCE_MODE diferente de true ($(cut -c1-12 <<<"$id")): o painel divergiu. Se a imagem implementa a trava, ela a mantinha em manutenção; uma imagem anterior ao adendo 1 estava ABERTA. O bloco tentou pará-la ($CONTENCAO), e a janela para até o painel ser corrigido"; }
    done
  }
  web_parado() { for id in $(rodando web); do echo "o web voltou a rodar:"; parar "$id"; done; }
  DB=$(nome db); [ -n "$DB" ] || pare "o container db não foi achado"
  # destravar deixa o código NOVO abrir: só sobre o schema que ele espera, e isso
  # se decide pelo BANCO (não por marca de arquivo)
  ja=$(docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name IN ('"'"'20261029220000_invite_authority'"'"', '"'"'20261030090000_workspace_experience'"'"')"') || ja='(não lido)'
  if [ -s "$D/demo-ok.txt" ] && [ "$ja" = 2 ]; then
    echo "a janela concluída (DEMO_CLINICS_OK) e as duas migrations da janela no banco"
  else
    pare "a trava FICA ligada: destravar só com a janela concluída (DEMO_CLINICS_OK) e as duas migrations da janela no banco (aqui: $ja). Sem elas (a janela interrompida, a volta do banco), os serviços ficam parados ou em manutenção; a reabertura com o 2b6deb1, que ignora a trava, é exceção, só com autorização específica"
  fi
  printf '%s\n' 'ALTER DATABASE :"banco" RESET veyra.manutencao;' \
    | docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -v banco="$POSTGRES_DB"'
  t=$(trava) || t='(não lida)'
  [ -z "$t" ] || pare "a trava não ficou desligada ($t)"
  echo "trava desligada: $(date -u +%FT%TZ)" | tee -a "$D/registro.txt"
  echo "DESTRAVA_OK: agora, no painel, MAINTENANCE_MODE=false, o DISABLE_JOBS de antes, os domínios do web devolvidos e o Redeploy; depois, o bloco 8"
)

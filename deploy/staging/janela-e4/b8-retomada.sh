# E-4 — BLOCO 8: a conferência da RETOMADA, depois do bloco 7 (a trava
# desligada) e do Redeploy com MAINTENANCE_MODE=false. Só com RETOMADA_OK o
# navegador entra. Se a API saiu da manutenção sem o transporte simulado ou fora
# do staging, ou se a saúde falhar, a API e o web são contidos na hora.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077
  URL="${E4_URL:-https://veyra-staging.malachdigital.com.br}"
  pare() { echo "PARE: $*"; exit 1; }
  rodando() { docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1"; }
  nome() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  env_de() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}'; }
  # só o ambiente NÃO secreto vai para variável (o resto nunca passa por here-string)
  nao_secreto() { env_de "$1" | grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV|NODE_ENV|SOURCE_COMMIT)=' || true; }
  parar() { if docker stop "$1" >/dev/null; then echo "parado agora: $1"; else echo "FALHA DE CONTENÇÃO: não foi possível parar $1"; fi; }
  # a CONTENÇÃO: para a API e o web e diz o que sobrou. Parar depois não é a
  # barreira (a trava é); o que continuar rodando é FALHA DE CONTENÇÃO
  conter() {
    for s in api web; do for id in $(rodando "$s"); do parar "$id"; done; done
    r=$(rodando api; rodando web || true)
    if [ -n "$r" ]; then
      echo "FALHA DE CONTENÇÃO: ainda rodando: $(printf '%s ' $r)— a manutenção NÃO está garantida; pare à mão (docker stop ou docker kill) e confira com docker ps"
    else
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
      env_de "$id" | grep -x 'MAINTENANCE_MODE=true' >/dev/null || { conter; pare "uma API rodando com MAINTENANCE_MODE diferente de true ($(cut -c1-12 <<<"$id")): o painel divergiu. A trava a mantinha em manutenção; o bloco a parou mesmo assim, e a janela para até o painel ser corrigido"; }
    done
  }
  web_parado() { for id in $(rodando web); do echo "o web voltou a rodar:"; parar "$id"; done; }
  DB=$(nome db); [ -n "$DB" ] || pare "o container db não foi achado"
  # a trava precisa estar DESLIGADA (o bloco 7): ligada, o código novo sobe em
  # manutenção. A exceção, decidida pelo BANCO: sem migration da janela (a janela
  # interrompida, a volta do banco), a trava FICA, e a reabertura é com o
  # 2b6deb1, que a ignora; o código novo, por engano, pararia na saúde de fora
  t=$(trava) || t='(não lida)'
  if [ -n "$t" ]; then
    ja=$(docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name IN ('"'"'20261029220000_invite_authority'"'"', '"'"'20261030090000_workspace_experience'"'"')"') || ja='(não lido)'
    if [ "$t" = ligada ] && [ "$ja" = 0 ]; then
      echo "o banco não tem migration da janela: a trava FICA ligada, e a reabertura é com o 2b6deb1, que a ignora"
    else
      pare "a trava de manutenção no banco não está desligada ($t): rode o bloco 7 e o Redeploy (o navegador não entra)"
    fi
  fi
  API=$(rodando api); [ "$(grep -c . <<<"$API" || true)" = 1 ] || pare "esperada uma API rodando, há: ${API:-nenhuma}"
  AMB=$(nao_secreto "$API")
  grep -qx 'MAINTENANCE_MODE=false' <<<"$AMB" || pare "o container ainda não saiu da manutenção: outro Redeploy, e este bloco de novo (o navegador não entra)"
  for v in META_TRANSPORT_MODE=fake VEYRA_ENV=staging; do
    grep -qx "$v" <<<"$AMB" || { conter; pare "a API saiu da manutenção sem $v: siga a volta à barreira (G7, passo 4, o bloco 1)"; }
  done
  # o diagnóstico MAIS ANTIGO é o de antes da janela (um bloco A colado no meio dela leria a manutenção)
  pri=$(ls "$D"/diagnostico-*.txt 2>/dev/null | LC_ALL=C sort | head -1 || true)
  if [ -n "$pri" ]; then ja=$(grep -m1 '^DISABLE_JOBS=' "$pri" || echo DISABLE_JOBS=false); echo "antes da janela ($(basename "$pri")): $ja"; else ja=DISABLE_JOBS=false; echo "(sem o bloco A em $D: o esperado é o padrão, DISABLE_JOBS=false)"; fi
  jc=$(grep -m1 '^DISABLE_JOBS=' <<<"$AMB" || echo DISABLE_JOBS=false)
  [ "$jc" = "$ja" ] || pare "$jc no container, $ja antes da janela: corrija no painel e Redeploy (o navegador não entra)"
  WEB=$(rodando web); [ "$(grep -c . <<<"$WEB" || true)" = 1 ] || pare "esperado um web rodando, há: ${WEB:-nenhum}"
  for c in "$API" "$WEB"; do
    n=0
    until s=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}'); [ "$s" = healthy ] || [ "$s" = sem-healthcheck ]; do
      n=$((n+1)); [ "$n" -lt 180 ] || { conter; pare "o container $c não ficou saudável em 3 min: siga a volta à barreira (G7, passo 4, o bloco 1)"; }; sleep 1
    done
  done
  h=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" || true)
  [ "$h" = 200 ] || { conter; pare "de fora, a saúde deu ${h:-nada} (esperado 200): siga a volta à barreira (G7, passo 4, o bloco 1)"; }
  echo "── o ambiente não secreto da retomada ──"
  grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV)=' <<<"$AMB"
  echo "de fora: 200"
  echo "RETOMADA_OK: agora o navegador, em abas NOVAS"
)

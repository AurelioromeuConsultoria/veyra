# E-4 — BLOCO 7: a conferência da RETOMADA, depois do Redeploy com
# MAINTENANCE_MODE=false. Só com RETOMADA_OK o navegador entra. Se a API saiu da
# manutenção sem o transporte simulado ou fora do staging, ou se a saúde de fora
# falhar, a API e o web são parados na hora (a volta à barreira, G7, passo 5).
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077
  URL="${E4_URL:-https://veyra-staging.malachdigital.com.br}"
  pare() { echo "PARE: $*"; exit 1; }
  rodando() { docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1"; }
  nome() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  env_de() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}'; }
  # só o ambiente NÃO secreto vai para variável (o resto nunca passa por here-string)
  nao_secreto() { env_de "$1" | grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV|NODE_ENV|SOURCE_COMMIT)=' || true; }
  parar() { if docker stop "$1" >/dev/null; then echo "parado agora: $1"; else echo "FALHOU ao parar $1: confira com docker ps"; fi; }
  parar_tudo() {
    for s in api web; do for id in $(rodando "$s"); do parar "$id"; done; done
    r=$(rodando api; rodando web); [ -z "$r" ] || echo "AINDA RODANDO: $r (pare com docker stop)"
  }
  # toda API rodando no projeto precisa estar em manutenção; senão, a API e o web param na hora
  barreira() {
    for id in $(rodando api); do
      env_de "$id" | grep -x 'MAINTENANCE_MODE=true' >/dev/null || { parar_tudo; pare "uma API rodando SEM MAINTENANCE_MODE=true ($(cut -c1-12 <<<"$id")): a API e o web foram parados na hora"; }
    done
  }
  web_parado() { for id in $(rodando web); do echo "o web voltou a rodar:"; parar "$id"; done; }
  API=$(rodando api); [ "$(grep -c . <<<"$API" || true)" = 1 ] || pare "esperada uma API rodando, há: ${API:-nenhuma}"
  AMB=$(nao_secreto "$API")
  grep -qx 'MAINTENANCE_MODE=false' <<<"$AMB" || pare "o container ainda não saiu da manutenção: outro Redeploy, e este bloco de novo (o navegador não entra)"
  for v in META_TRANSPORT_MODE=fake VEYRA_ENV=staging; do
    grep -qx "$v" <<<"$AMB" || { parar_tudo; pare "a API saiu da manutenção sem $v: a API e o web foram parados na hora; siga a volta à barreira (G7, passo 4)"; }
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
      n=$((n+1)); [ "$n" -lt 180 ] || { parar_tudo; pare "o container $c não ficou saudável em 3 min: a API e o web foram parados; siga a volta à barreira (G7, passo 4)"; }; sleep 1
    done
  done
  h=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" || true)
  [ "$h" = 200 ] || { parar_tudo; pare "de fora, a saúde deu ${h:-nada} (esperado 200): a API e o web foram parados; siga a volta à barreira (G7, passo 4)"; }
  echo "── o ambiente não secreto da retomada ──"
  grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV)=' <<<"$AMB"
  echo "de fora: 200"
  echo "RETOMADA_OK: agora o navegador, em abas NOVAS"
)

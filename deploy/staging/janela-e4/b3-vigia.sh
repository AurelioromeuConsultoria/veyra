# E-4 — BLOCO 3, o VIGIA do deploy (no terminal do SERVIDOR). Cole ANTES de clicar
# Deploy, com a API e o web parados. Ele espera a API nova subir (até 30 min) e,
# assim que ela aparece, confere o ambiente pelo `docker inspect`: sem
# MAINTENANCE_MODE=true, META_TRANSPORT_MODE=fake e VEYRA_ENV=staging, a API e o
# web são parados na hora. O web é parado sempre que aparecer. Das chaves, só o
# nome é impresso.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077
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
  rm -f "$D/bloco3-ok.txt"
  # se o vigia terminar antes do BLOCO3_OK (um PARE, um erro, o terminal fechado),
  # a API e o web param: nunca fica uma API de pé sem ninguém olhando. O SIGHUP do
  # terminal fechado o encerra NA HORA por esta saída, que passa a ignorar novos
  # SIGHUPs (os `docker` que ela chama herdam isso) e roda sem `-e` (a escrita na
  # tela falha, e os `docker stop` seguem)
  trap 'trap "" HUP; set +e; [ -s "$D/bloco3-ok.txt" ] || { parar_tudo; echo "PARE: o vigia terminou sem o BLOCO3_OK: a API e o web ficam parados"; }' EXIT
  ESPERA="${E4_ESPERA_API:-1800}"
  echo "VIGIA ATIVO: clique Deploy no painel agora, em OUTRA aba. Espero a API por até $(( ESPERA / 60 )) min."
  fim=$(( $(date +%s) + ESPERA )); API=""
  while :; do
    for id in $(rodando web); do echo "web parado:"; parar "$id"; done
    barreira
    API=$(rodando api | head -1)
    [ -z "$API" ] || break
    [ "$(date +%s)" -lt "$fim" ] || pare "a API não subiu no prazo; se o Deploy ainda estiver rodando, cancele-o no painel"
    voltas=$(( ${voltas:-0} + 1 )); [ $(( voltas % 60 )) != 0 ] || echo "… esperando a API ($(( voltas / 2 )) s)"
    sleep 0.5
  done
  AMB=$(nao_secreto "$API")
  for v in MAINTENANCE_MODE=true META_TRANSPORT_MODE=fake VEYRA_ENV=staging; do
    grep -qx "$v" <<<"$AMB" || { parar_tudo; pare "a API subiu sem $v e foi parada na hora. A janela para aqui, com o usuário: o painel é corrigido (seção de produção); antes do bloco 5, ela recomeça pela G2"; }
  done
  echo "a API nova subiu em manutenção: $(docker inspect "$API" --format '{{.Name}}')"
  echo "── a imagem: o id, a data do build e o commit, se o Coolify o passa ──"
  docker inspect "$API" --format '{{.Config.Image}} {{.Image}}'
  docker image inspect "$(docker inspect "$API" --format '{{.Image}}')" --format 'construída em: {{.Created}}'
  grep -E '^SOURCE_COMMIT=' <<<"$AMB" || echo "(sem SOURCE_COMMIT: confira o commit no log do deploy, no painel)"
  echo "── o ambiente não secreto ──"
  grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV|NODE_ENV)=' <<<"$AMB"
  echo "── as chaves com valor (só o nome) ──"
  env_de "$API" | grep -oE '^(ADDRESS_LOCK_KEY|OUTBOUND_APPROVAL_KEY|JWT_SECRET|TOKEN_ENCRYPTION_KEY)=.' | cut -d= -f1 | LC_ALL=C sort || echo "(nenhuma)"
  echo "── a saúde: o healthcheck (até 3 min), o loopback 200 e a rede interna 503 ──"
  n=0
  until [ "$(docker inspect "$API" --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}')" = healthy ]; do
    for id in $(rodando web); do echo "web parado:"; parar "$id"; done
    barreira
    n=$((n+1)); [ "$n" -lt 360 ] || { parar_tudo; pare "a API não ficou saudável em 3 min"; }
    sleep 0.5
  done
  lo=$(docker exec "$API" curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health || true)
  [ "$lo" = 200 ] || { parar_tudo; pare "pelo loopback, a saúde deu ${lo:-nada} (esperado 200)"; }
  DB=$(nome db)
  rede=$(docker exec "$DB" wget -S -O /dev/null http://api:3001/api/health 2>&1 | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]{3}' || true)
  case "$rede" in *' 503') ;; *) parar_tudo; pare "pela rede interna, a saúde deu '${rede:-nada}' (esperado 503, a barreira)" ;; esac
  echo "loopback 200; rede interna 503"
  if docker inspect "$API" --format '{{json .Config.Labels}}' | grep -i 'traefik.http.routers' >/dev/null; then parar_tudo; pare "a API tem rota no Traefik"; fi
  echo "a API sem rota no Traefik"
  echo "── o web: parado quando aparecer (o compose o sobe depois da API saudável; até ${E4_ESPERA_WEB:-120} s) ──"
  fimw=$(( $(date +%s) + ${E4_ESPERA_WEB:-120} )); visto=""
  while [ -z "$visto" ] && [ "$(date +%s)" -lt "$fimw" ]; do
    for id in $(rodando web); do echo "web parado:"; parar "$id"; visto=1; done
    [ -n "$visto" ] || sleep 1
  done
  w=$(rodando web); [ -z "$w" ] || pare "o web continua rodando"
  echo "o web parado"
  echo "── o log da subida ──"
  docker logs "$API" 2>&1 | grep -E 'Jobs desabilitados|ERROR|successfully started' | tail -5 | cut -c1-200 || true
  BK=$(nome backup); if [ -n "$BK" ]; then docker exec "$BK" restic version || true; fi
  printf '%s\n%s\n' "$(docker inspect "$API" --format '{{.Id}}')" "$(docker inspect "$API" --format '{{.Image}}')" > "$D/bloco3-ok.txt"
  echo BLOCO3_OK
)

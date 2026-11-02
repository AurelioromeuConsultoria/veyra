# E-4 — BLOCO 3, o VIGIA do deploy (no terminal do SERVIDOR). Cole ANTES de clicar
# Deploy, com a API e o web parados. Ele espera a API nova subir (até 30 min) e,
# assim que ela aparece, confere o ambiente pelo `docker inspect`: sem
# MAINTENANCE_MODE=true, META_TRANSPORT_MODE=fake e VEYRA_ENV=staging, a API e o
# web são contidos. O web é parado sempre que aparecer. É uma conferência
# ADICIONAL: a garantia é a trava no banco (bloco 1), que ele exige antes de
# começar. Ele confere também que a API aponta para o banco da trava (antes e
# depois do Deploy) e que a nova registrou a trava ligada na subida. Ele só vê
# containers já iniciados e não impede um evento do deploy depois de terminar.
# Das chaves, só o nome é impresso.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077
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
  rm -f "$D/bloco3-ok.txt"
  # se o vigia terminar antes do BLOCO3_OK (um PARE, um erro, o terminal fechado),
  # a API e o web param: nunca fica uma API de pé sem ninguém olhando. O SIGHUP do
  # terminal fechado o encerra NA HORA por esta saída, que passa a ignorar novos
  # SIGHUPs (os `docker` que ela chama herdam isso) e roda sem `-e` (a escrita na
  # tela falha, e os `docker stop` seguem)
  trap 'trap "" HUP; set +e; [ -s "$D/bloco3-ok.txt" ] || { echo "PARE: o vigia terminou sem o BLOCO3_OK; a contenção:"; conter; }' EXIT
  # a garantia vem ANTES do Deploy: sem a trava ligada, o vigia nem começa
  barreira
  echo "a trava de manutenção no banco: ligada"
  # o BANCO DE DESTINO: a trava protege só a API que lê o banco dela, o
  # POSTGRES_DB do `db` em que o bloco 1 a ligou. Do DATABASE_URL se lê só o
  # destino, e só na forma que o compose monta (sem query nem fragmento: um
  # `?host=` mudaria o destino real); nada dele é impresso
  BANCO=$(docker exec "$DB" sh -c 'printf %s "$POSTGRES_DB"'); [ -n "$BANCO" ] || pare "o POSTGRES_DB do container db não foi lido"
  aponta() { [ "$(env_de "$1" | sed -n -E 's|^DATABASE_URL=postgres(ql)?://[^/?#]*@([^/?#@]+)/([^/?#]+)$|\2/\3|p')" = "db:5432/$BANCO" ]; }
  ANT=$(nome api)
  if [ -n "$ANT" ]; then
    aponta "$ANT" || pare "a API de antes ($ANT) não aponta para o banco da trava (db:5432/$BANCO, na forma do compose): a trava ligada em outro banco não protege esta janela. Nada de Deploy; a janela para aqui, com o usuário"
    echo "o banco de destino: a API de antes aponta para db:5432/$BANCO, o banco da trava"
  else
    echo "(nenhuma API de antes para conferir o destino: a API nova é conferida quando aparecer)"
  fi
  echo "ANTES de clicar Deploy: no painel, o commit fixado é o combinado, e nenhuma variável POSTGRES_* mudou"
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
    grep -qx "$v" <<<"$AMB" || { conter; pare "a API subiu sem $v (o painel divergiu; se a imagem implementa a trava, ela a mantinha em manutenção; $CONTENCAO). A janela para aqui, com o usuário: o painel é corrigido (seção de produção); antes do bloco 5, ela recomeça pela G2"; }
  done
  aponta "$API" || { conter; pare "a API nova não aponta para o banco da trava (db:5432/$BANCO, na forma do compose): a trava não a protege ($CONTENCAO). A janela para aqui, com o usuário"; }
  echo "a API nova subiu em manutenção: $(docker inspect "$API" --format '{{.Name}}'), apontando para db:5432/$BANCO"
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
    n=$((n+1)); [ "$n" -lt 360 ] || { conter; pare "a API não ficou saudável em 3 min"; }
    sleep 0.5
  done
  lo=$(docker exec "$API" curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health || true)
  [ "$lo" = 200 ] || { conter; pare "pelo loopback, a saúde deu ${lo:-nada} (esperado 200)"; }
  DB=$(nome db)
  rede=$(docker exec "$DB" wget -S -O /dev/null http://api:3001/api/health 2>&1 | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]{3}' || true)
  case "$rede" in *' 503') ;; *) conter; pare "pela rede interna, a saúde deu '${rede:-nada}' (esperado 503, a barreira)" ;; esac
  echo "loopback 200; rede interna 503"
  # a IMAGEM que implementa a trava, e que a leu LIGADA: a API registra isso na
  # subida, antes de qualquer módulo. Só o log DESTA subida conta. Sem o
  # registro, a proteção desta janela não vale para ela
  desde=$(docker inspect "$API" --format '{{.State.StartedAt}}') || { conter; pare "o início da API não foi lido ($CONTENCAO)"; }
  docker logs --since "$desde" "$API" 2>&1 | grep -F 'Trava de manutenção LIGADA no banco' >/dev/null || { conter; pare "a API nova não registrou, na subida, a trava ligada: a imagem não implementa a leitura da trava (outro commit?) ou não a leu no banco dela. A proteção desta janela não vale para ela ($CONTENCAO); a janela para aqui, com o usuário"; }
  echo "a API nova leu a trava LIGADA na subida: a imagem implementa a trava"
  if docker inspect "$API" --format '{{json .Config.Labels}}' | grep -i 'traefik.http.routers' >/dev/null; then conter; pare "a API tem rota no Traefik"; fi
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
  # no registro: a imagem aprovada e o commit, se o Coolify o passa (o fixado no painel é conferido à mão)
  echo "vigia: a API $(docker inspect "$API" --format '{{.Name}}'), imagem $(docker inspect "$API" --format '{{.Image}}'), $(grep -E '^SOURCE_COMMIT=' <<<"$AMB" || echo 'sem SOURCE_COMMIT'), banco $BANCO: $(date -u +%FT%TZ)" >> "$D/registro.txt"
  printf '%s\n%s\n' "$(docker inspect "$API" --format '{{.Id}}')" "$(docker inspect "$API" --format '{{.Image}}')" > "$D/bloco3-ok.txt"
  echo BLOCO3_OK
)

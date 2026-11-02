# E-4 — BLOCO 8: a conferência da RETOMADA, depois do bloco 7 (a trava
# desligada) e do Redeploy com MAINTENANCE_MODE=false. Só com RETOMADA_OK o
# navegador entra. Se a API saiu da manutenção sem o transporte simulado ou fora
# do staging, ou se a saúde falhar, a API e o web são contidos na hora. Com a
# trava ligada, ele recusa: a reabertura com o 2b6deb1 é EXCEÇÃO, com autorização
# própria, e não passa por este bloco.
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
  # o registro que a API com o código da trava faz na subida, quando a lê ligada
  subiu_travada() { local desde; desde=$(docker inspect "$1" --format '{{.State.StartedAt}}') || return 1; docker logs --since "$desde" "$1" 2>&1 | grep -F 'Trava de manutenção LIGADA no banco' >/dev/null; }
  # a trava precisa estar DESLIGADA (o bloco 7). Ligada, ou ilegível, nenhuma
  # retomada passa por aqui: a reabertura com o 2b6deb1, que IGNORA a trava, é
  # uma exceção com autorização específica e conferências próprias (a imagem
  # exata e o banco compatível com o snapshot), fora deste bloco. O bloco confere
  # o que está RODANDO, e não só o que responde de fora (sem os domínios do web,
  # nada chega de fora): cada API precisa estar em manutenção, pela trava (o
  # registro desta subida) ou pelo ambiente. A que não estiver, ou o que der 2xx
  # de fora ou pela rede interna, é contida
  t=$(trava) || t='(não lida)'
  if [ -n "$t" ]; then
    if [ "$t" = '(não lida)' ]; then estado="não pôde ser lida"; else estado="está ligada ($t)"; fi
    abertas=""; conferido=""
    for id in $(rodando api); do
      c=$(cut -c1-12 <<<"$id")
      if subiu_travada "$id"; then
        conferido="$conferido $c em manutenção pela trava;"
      elif env_de "$id" | grep -x 'MAINTENANCE_MODE=true' >/dev/null; then
        conferido="$conferido $c em manutenção SÓ pelo ambiente, não pela trava (um valor do painel a abre);"
      else
        abertas="$abertas $c"
      fi
    done
    h=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" 2>/dev/null || true)
    case "$h" in 2*) abertas="$abertas (de fora: $h)";; esac
    rede=$(docker exec "$DB" wget -S -O /dev/null http://api:3001/api/health 2>&1 | grep -m1 -oE 'HTTP/[0-9.]+ [0-9]{3}' || true)
    case "$rede" in *' 2'[0-9][0-9]) abertas="$abertas (pela rede interna: ${rede##* })";; esac
    if [ -n "$abertas" ]; then
      conter
      pare "a trava $estado, e há API FORA da manutenção:$abertas. É uma imagem que ignora a trava (anterior ao adendo 1, como o 2b6deb1); se não houve a exceção autorizada, ela não podia estar de pé ($CONTENCAO)"
    fi
    pare "a trava $estado (conferido:${conferido:- nenhuma API rodando;}): o bloco 7 e o Redeploy. Se o bloco 7 recusar (a janela interrompida, a volta do banco), a trava FICA, e os serviços ficam parados ou em manutenção; a reabertura com o 2b6deb1 é exceção, só com autorização específica (o navegador não entra)"
  fi
  API=$(rodando api); [ "$(grep -c . <<<"$API" || true)" = 1 ] || pare "esperada uma API rodando, há: ${API:-nenhuma}"
  AMB=$(nao_secreto "$API")
  grep -qx 'MAINTENANCE_MODE=false' <<<"$AMB" || pare "o container ainda não saiu da manutenção: outro Redeploy, e este bloco de novo (o navegador não entra)"
  # ANTES do ramo seguinte: uma API sem o transporte simulado é contida mesmo se
  # ainda estiver em manutenção pela trava (um reinício a abriria assim)
  for v in META_TRANSPORT_MODE=fake VEYRA_ENV=staging; do
    grep -qx "$v" <<<"$AMB" || { conter; pare "a API saiu da manutenção no ambiente sem $v: siga a volta à barreira (G7, passo 4, o bloco 1) ($CONTENCAO)"; }
  done
  # quem decide é a SUBIDA: uma API que subiu com a trava ainda ligada continua em
  # manutenção depois do bloco 7, e não muda sozinha. Só o Redeploy, DEPOIS dele, a abre
  desde=$(docker inspect "$API" --format '{{.State.StartedAt}}') || pare "o início da API não foi lido"
  if subiu_travada "$API"; then
    pare "esta API subiu em $desde com a trava ainda ligada e continua em manutenção (decide na subida): o Redeploy, DEPOIS do bloco 7, e este bloco de novo. Se o início não mudar depois do Redeploy, o container não foi recriado: a janela para aqui, com o usuário, sem Restart (o navegador não entra)"
  fi
  # o diagnóstico MAIS ANTIGO é o de antes da janela (um bloco A colado no meio dela leria a manutenção)
  pri=$(ls "$D"/diagnostico-*.txt 2>/dev/null | LC_ALL=C sort | head -1 || true)
  if [ -n "$pri" ]; then ja=$(grep -m1 '^DISABLE_JOBS=' "$pri" || echo DISABLE_JOBS=false); echo "antes da janela ($(basename "$pri")): $ja"; else ja=DISABLE_JOBS=false; echo "(sem o bloco A em $D: o esperado é o padrão, DISABLE_JOBS=false)"; fi
  jc=$(grep -m1 '^DISABLE_JOBS=' <<<"$AMB" || echo DISABLE_JOBS=false)
  [ "$jc" = "$ja" ] || pare "$jc no container, $ja antes da janela: corrija no painel e Redeploy (o navegador não entra)"
  WEB=$(rodando web); [ "$(grep -c . <<<"$WEB" || true)" = 1 ] || pare "esperado um web rodando, há: ${WEB:-nenhum}"
  for c in "$API" "$WEB"; do
    n=0
    until s=$(docker inspect "$c" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}sem-healthcheck{{end}}'); [ "$s" = healthy ] || [ "$s" = sem-healthcheck ]; do
      n=$((n+1)); [ "$n" -lt 180 ] || { conter; pare "o container $c não ficou saudável em 3 min: siga a volta à barreira (G7, passo 4, o bloco 1) ($CONTENCAO)"; }; sleep 1
    done
  done
  h=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" || true)
  [ "$h" = 200 ] || { conter; pare "de fora, a saúde deu ${h:-nada} (esperado 200): siga a volta à barreira (G7, passo 4, o bloco 1) ($CONTENCAO)"; }
  echo "── o ambiente não secreto da retomada ──"
  grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV)=' <<<"$AMB"
  echo "de fora: 200"
  echo "RETOMADA_OK: agora o navegador, em abas NOVAS"
)

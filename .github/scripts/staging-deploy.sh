#!/usr/bin/env bash
# Publica no staging o commit que o CI acabou de validar (ADR-058). Roda no job
# `Staging`, depois dos quatro jobs verdes, só no push na `main`, no ambiente
# `staging` do GitHub (secrets do ambiente, restrito à `main`).
#
# Entradas (ambiente): COOLIFY_URL, COOLIFY_TOKEN e COOLIFY_APP_UUID (secrets),
# STAGING_URL, SHA (o commit testado), GH_TOKEN e GITHUB_REPOSITORY (o registro
# das publicações conferidas). STAGING_BASE é o commit no ar confirmado por quem
# opera, no fim de uma janela ou no primeiro deploy. PONTA e INTERVALO_S servem
# só à simulação. O token nunca é impresso nem vai na linha de comando.
set -euo pipefail

pare() {
  echo "::error::$*" >&2
  exit 1
}
for v in COOLIFY_URL COOLIFY_TOKEN COOLIFY_APP_UUID STAGING_URL SHA GH_TOKEN GITHUB_REPOSITORY; do
  [ -n "${!v:-}" ] || pare "falta $v: o deploy automático do staging não está configurado (DEPLOY_STAGING §4.0)"
done
# o token só viaja cifrado
case "$COOLIFY_URL" in
  https://*) ;;
  *) pare "COOLIFY_URL precisa começar com https:// (o token não viaja em claro)" ;;
esac
API="${COOLIFY_URL%/}/api/v1"
INTERVALO_S="${INTERVALO_S:-10}"
# a guarda: o que não vai ao ar sozinho (ADR-058; DEPLOY_STAGING §4.1)
GUARDADOS=(apps/api/prisma/migrations apps/api/src/common/env.ts apps/api/Dockerfile apps/web/Dockerfile
  deploy/staging/docker-compose.yml deploy/staging/web deploy/staging/backup)

# o cabeçalho do token num arquivo (fora do argv do curl), apagado na saída
CABECALHO=$(mktemp)
CORPO=$(mktemp)
trap 'rm -f "$CABECALHO" "$CORPO"' EXIT
chmod 600 "$CABECALHO"
printf 'Authorization: Bearer %s\n' "$COOLIFY_TOKEN" >"$CABECALHO"

# um texto vindo de fora, numa linha só e curto, para as mensagens
uma_linha() {
  local t
  t=$(tr -d '\r')
  t=${t//$'\n'/ }
  printf '%s' "${t:0:200}"
}

# Chamada à API do Coolify: o corpo em $CORPO, o código HTTP na saída
coolify() {
  local codigo
  codigo=$(curl -sS --proto '=https' --max-time 30 -o "$CORPO" -w '%{http_code}' \
    -H @"$CABECALHO" -H 'Accept: application/json' "$@" 2>/dev/null) || true
  echo "${codigo:-000}"
}
# GET que precisa dar certo: falha alto, só com a mensagem da API (000: sem
# resposta, por rede, DNS, TLS ou prazo; 401/403: o token revogado ou sem a permissão)
coolify_get() {
  local codigo
  codigo=$(coolify "$API$1")
  [ "$codigo" = 200 ] || pare "a API do Coolify respondeu $codigo em GET $1: $(jq -r '.message // empty' "$CORPO" 2>/dev/null | uma_linha)"
  jq -e . "$CORPO" >/dev/null 2>&1 || pare "a API do Coolify respondeu algo que não é JSON em GET $1"
  cat "$CORPO"
}
# o que mudou nos caminhos guardados entre dois commits
guardados_entre() { git diff --name-only "$1" "$2" -- "${GUARDADOS[@]}"; }

# O registro das publicações conferidas: um deployment do GitHub no ambiente
# `staging-conferido`, criado SÓ por este script, no fim de um deploy com o commit
# e a saúde conferidos. Ele confirma que aquele commit foi ao ar pela guarda.
REGISTRO=staging-conferido
conferido_no_github() {
  local id estado
  id=$(gh api "repos/$GITHUB_REPOSITORY/deployments?environment=$REGISTRO&sha=$1&per_page=1" --jq '.[0].id // empty') || return 2
  [ -n "$id" ] || return 1
  estado=$(gh api "repos/$GITHUB_REPOSITORY/deployments/$id/statuses?per_page=1" --jq '.[0].state // empty') || return 2
  [ "$estado" = success ]
}
registrar_conferido() {
  local id
  id=$(printf '{"ref":"%s","environment":"%s","auto_merge":false,"required_contexts":[],"description":"publicado e conferido pelo job Staging"}' "$SHA" "$REGISTRO" |
    gh api -X POST "repos/$GITHUB_REPOSITORY/deployments" --input - --jq '.id') || return 1
  [ -n "$id" ] || return 1
  gh api -X POST "repos/$GITHUB_REPOSITORY/deployments/$id/statuses" -f state=success >/dev/null
}

# 1. A ponta: se a `main` já andou, o run do commit novo publica depois do CI dele
PONTA="${PONTA:-$(git ls-remote origin refs/heads/main | cut -f1)}"
[ -n "$PONTA" ] || pare "não consegui ler a ponta da main"
if [ "$PONTA" != "$SHA" ]; then
  echo "::notice::a main já está em $PONTA; nada publicado por este run ($SHA)"
  exit 0
fi

# 2. O recurso no Coolify: o Auto Deploy desligado e nenhuma janela em curso
APP=$(coolify_get "/applications/$COOLIFY_APP_UUID")
jq -e 'type == "object"' >/dev/null 2>&1 <<<"$APP" || pare "a API do Coolify não devolveu o recurso no formato esperado"
AUTO=$(jq -r '[.settings?.is_auto_deploy_enabled?, .is_auto_deploy_enabled?]
              | map(select(type == "boolean"))
              | if length == 0 then "desconhecido" elif any then "true" else "false" end' <<<"$APP")
case "$AUTO" in
  false) ;;
  true) pare "o Auto Deploy do Coolify está ligado: o push publica sem esperar o CI. Ponha em \"Manual deployments only\" e confira no painel o que está no ar (DEPLOY_STAGING §4.0)" ;;
  *) echo "::warning::a API do Coolify não informou o Auto Deploy; confira no painel que está em \"Manual deployments only\"" ;;
esac
# sem os campos, não há como saber se há janela: ausência de sinal não prova nada
FIXADO=$(jq -r '.git_commit_sha // "ausente"' <<<"$APP" | uma_linha)
RAMO=$(jq -r '.git_branch // "ausente"' <<<"$APP" | uma_linha)
[ "$FIXADO" != ausente ] && [ "$RAMO" != ausente ] || pare "a API do Coolify não informou o commit e o branch do recurso: sem saber se há janela, nada publicado"
[ "$FIXADO" = HEAD ] || pare "o recurso está fixado em $FIXADO: há janela em curso (DEPLOY_STAGING §4.1). Nada publicado"
[ "$RAMO" = main ] || pare "o recurso segue o branch $RAMO, não a main. Nada publicado"

# 3. A base: o commit do último deploy concluído no Coolify (inclui os do painel)
DEPLOYS=$(coolify_get "/deployments/applications/$COOLIFY_APP_UUID?take=50")
EM_CURSO=$(jq -r '[(.deployments? // .)[]? | select((.pull_request_id // 0) == 0)
                   | select(.status == "queued" or .status == "in_progress")] | length' <<<"$DEPLOYS")
[ "$EM_CURSO" = 0 ] || pare "há $EM_CURSO deploy(s) em andamento no Coolify: espere terminar e rode de novo este job"
ULTIMO=$(jq -c '[(.deployments? // .)[]? | select((.pull_request_id // 0) == 0) | select(.status == "finished")]
               | .[0] // {}' <<<"$DEPLOYS")
BASE=$(jq -r '.commit // ""' <<<"$ULTIMO" | uma_linha)
# sem cast no modelo do Coolify: aceita o booleano e as formas do banco (1/0, t/f)
WEBHOOK=$(jq -r '.is_webhook as $w
  | if ($w == true or $w == 1 or $w == "1" or $w == "t" or $w == "true") then "true"
    elif ($w == false or $w == 0 or $w == "0" or $w == "f" or $w == "false") then "false"
    else "desconhecido" end' <<<"$ULTIMO")
ORIGEM="o último deploy concluído no Coolify"
# o que o webhook publicou não passou pelo CI nem pela guarda: não serve de base
[ "$WEBHOOK" != true ] || pare "o último deploy concluído veio do webhook do Git (o Auto Deploy), sem o CI: $BASE está no ar sem a guarda. Desligue o Auto Deploy, confira as migrations no ar e siga o DEPLOY_STAGING §4.1"
# sem saber o Auto Deploy nem a origem do deploy no ar, o webhook pode ter publicado
if [ "$AUTO" = desconhecido ] && [ "$WEBHOOK" = desconhecido ]; then
  pare "a API do Coolify não informou o Auto Deploy nem a origem do último deploy: sem saber se o webhook publicou, nada publicado"
fi
if ! [[ "$BASE" =~ ^[0-9a-f]{40}$ ]]; then
  [ -n "${STAGING_BASE:-}" ] || pare "o Coolify não informou o commit no ar (\"$BASE\"): sem base, nada publicado. Defina a variável STAGING_BASE do ambiente com o commit no ar (DEPLOY_STAGING §4.0)"
  # o SHA completo, nunca um nome (HEAD, main): um nome resolveria para o próprio commit
  [[ "$STAGING_BASE" =~ ^[0-9a-f]{40}$ ]] || pare "a STAGING_BASE precisa ser o SHA completo (40 caracteres) do commit no ar, não um nome"
  BASE="$STAGING_BASE"
  ORIGEM="a variável STAGING_BASE"
fi
git cat-file -e "$BASE^{commit}" 2>/dev/null || pare "a base $BASE ($ORIGEM) não está no histórico deste checkout"
echo "base: $BASE ($ORIGEM)"
# o commit testado já no ar chegou lá por fora deste job (o painel, o webhook ou
# a corrida de outro run): a guarda nunca o conferiu, e o diff contra ele é vazio
[ "$BASE" != "$SHA" ] || pare "o commit testado $SHA já estava no ar antes deste job, publicado por fora dele: a guarda nunca o conferiu. Confira as migrations e a pilha dele e siga o DEPLOY_STAGING §4.1. Se ele foi publicado por uma janela, com as migrations aplicadas, ou por um Staging verde deste mesmo commit, não há nada a fazer"
# A base é o código no ar, e só vale se foi CONFERIDA: publicada por um Staging que
# conferiu o commit e a saúde (o registro), ou confirmada por quem opera (a
# STAGING_BASE, igual a ela). Um commit que foi ao ar por fora (a corrida, o painel
# fora de janela) não serve: o diff contra ele esconderia a migration dele
if [ "${STAGING_BASE:-}" = "$BASE" ]; then
  echo "base confirmada pela STAGING_BASE"
else
  conferido_no_github "$BASE" && CONF=0 || CONF=$?
  [ "$CONF" != 2 ] || pare "não consegui ler o registro das publicações conferidas no GitHub"
  [ "$CONF" = 0 ] || pare "o commit no ar $BASE não foi publicado por um Staging conferido nem confirmado pela STAGING_BASE: ele foi ao ar por fora da guarda. Confira as migrations dele (migrate status sem pendência) e defina a STAGING_BASE com ele (DEPLOY_STAGING §4.0)"
  echo "base conferida: publicada por um Staging"
fi
MUDOU=$(guardados_entre "$BASE" "$SHA")
if [ -n "$MUDOU" ]; then
  echo "$MUDOU" >&2
  pare "desde $BASE há migration, variável exigida ou mudança na pilha do staging: o deploy automático não publica, e a versão no ar continua. Siga o DEPLOY_STAGING §4.1, com autorização própria"
fi

# 4. O deploy (POST; versões antigas do Coolify só aceitam GET)
CODIGO=$(coolify -X POST "$API/deploy?uuid=$COOLIFY_APP_UUID&force=false")
if [ "$CODIGO" = 405 ]; then
  CODIGO=$(coolify "$API/deploy?uuid=$COOLIFY_APP_UUID&force=false")
fi
[ "$CODIGO" = 200 ] || pare "o Coolify respondeu $CODIGO ao pedido de deploy: $(jq -r '.message // empty' "$CORPO" 2>/dev/null | uma_linha)"
jq -e . "$CORPO" >/dev/null 2>&1 || pare "o Coolify respondeu ao pedido de deploy com algo que não é JSON; confira no painel se ele enfileirou"
DEP=$(jq -r '.deployments[0].deployment_uuid // empty' "$CORPO" | uma_linha)
[ -n "$DEP" ] || pare "o Coolify não enfileirou o deploy: $(jq -r '.deployments[0].message // .message // "sem mensagem"' "$CORPO" | uma_linha)"
echo "deploy $DEP enfileirado para $SHA"

# 5. Até o fim (30 min de relógio, abaixo do timeout do job), tolerando 5 falhas seguidas da API
STATUS=desconhecido
FALHAS=0
D='{}'
PRAZO=$((SECONDS + 1800))
while [ "$SECONDS" -lt "$PRAZO" ]; do
  CODIGO=$(coolify "$API/deployments/$DEP")
  if [ "$CODIGO" != 200 ]; then
    FALHAS=$((FALHAS + 1))
    [ "$FALHAS" -le 5 ] || pare "a API do Coolify falhou $FALHAS vezes seguidas ($CODIGO) acompanhando o deploy $DEP; ele pode continuar: confira no painel"
    sleep "$INTERVALO_S"
    continue
  fi
  FALHAS=0
  D=$(cat "$CORPO")
  STATUS=$(jq -r '.status // "desconhecido"' <<<"$D" 2>/dev/null | uma_linha) || STATUS=desconhecido
  case "$STATUS" in
    finished) break ;;
    failed | cancelled-by-user) pare "o deploy $DEP terminou em $STATUS; confira no painel o que está no ar. A correção é para frente (DEPLOY_STAGING §5)" ;;
  esac
  sleep "$INTERVALO_S"
done
[ "$STATUS" = finished ] || pare "o deploy $DEP não terminou em 30 min (status: $STATUS); ele pode continuar: confira no painel"

# o commit publicado é o testado? Se não for, diga o que foi ao ar sem este CI
PUBLICADO=$(jq -r '.commit // ""' <<<"$D" | uma_linha)
if ! [[ "$PUBLICADO" =~ ^[0-9a-f]{40}$ ]]; then
  pare "o deploy $DEP terminou, mas o Coolify não informou o commit publicado (\"$PUBLICADO\"): confira no painel"
fi
if [ "$PUBLICADO" != "$SHA" ]; then
  AVISO="sem migration nem mudança guardada desde a base"
  # o commit da corrida chegou depois do checkout deste job: busca no origin
  git cat-file -e "$PUBLICADO^{commit}" 2>/dev/null || git fetch --quiet origin "$PUBLICADO" 2>/dev/null || true
  if ! git cat-file -e "$PUBLICADO^{commit}" 2>/dev/null; then
    AVISO="fora do histórico do repositório, e não sei se traz migration: fixe AGORA o recurso no painel nesse commit, o que pausa a publicação, e siga o DEPLOY_STAGING §4.1"
  elif [ -n "$(guardados_entre "$BASE" "$PUBLICADO")" ]; then
    AVISO="COM migration ou mudança guardada desde a base: fixe AGORA o recurso no painel nesse commit, o que pausa a publicação, e siga o DEPLOY_STAGING §4.1"
  fi
  pare "o Coolify publicou $PUBLICADO, não o commit testado $SHA: um push chegou antes de o deploy sair da fila. $PUBLICADO está no ar sem a conferência deste run ($AVISO)"
fi

# 6. A saúde, de fora (o /api/health não toca o banco: prova que a API subiu)
for _ in $(seq 1 30); do
  SAUDE=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "${STAGING_URL%/}/api/health" 2>/dev/null) || true
  SAUDE="${SAUDE:-000}"
  if [ "$SAUDE" = 200 ]; then
    registrar_conferido || pare "staging no ar com $SHA (deploy $DEP), mas não consegui registrar a conferência: o próximo deploy vai recusar a base. Defina a STAGING_BASE com $SHA"
    echo "staging no ar com $SHA (deploy $DEP)"
    exit 0
  fi
  sleep "$INTERVALO_S"
done
pare "o deploy $DEP terminou com $SHA, mas $STAGING_URL/api/health não respondeu 200 (último: $SAUDE)"

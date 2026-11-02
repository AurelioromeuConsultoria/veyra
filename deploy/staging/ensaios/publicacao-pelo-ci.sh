#!/usr/bin/env bash
# Ensaio do ADR-058: o .github/scripts/staging-deploy.sh contra um Coolify
# simulado, em HTTPS local, com um certificado próprio, um repositório git
# descartável (base, commits de docs, um com migration, um da corrida, enviado
# depois do clone) e um `gh` simulado para o registro das publicações
# conferidas. Cada cenário tem a saída e a mensagem esperadas; o token nunca
# pode aparecer na saída.
#
#   bash deploy/staging/ensaios/publicacao-pelo-ci.sh
#
# Precisa de python3, openssl, curl, jq e git. Nada sai da máquina: o Coolify
# é um processo local, e nenhuma credencial real é usada.
set -euo pipefail

RAIZ=$(git rev-parse --show-toplevel)
SCRIPT="$RAIZ/.github/scripts/staging-deploy.sh"
SIMULADO="$RAIZ/deploy/staging/ensaios/publicacao-pelo-ci/coolify-simulado.py"
E=$(mktemp -d)
PID=
trap '[ -z "$PID" ] || kill "$PID" 2>/dev/null; rm -rf "$E"' EXIT
TOKEN="tok-ficticio-$RANDOM$RANDOM"

# o certificado do Coolify simulado, só para 127.0.0.1
cat >"$E/cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = 127.0.0.1
[ext]
subjectAltName = IP:127.0.0.1
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyCertSign
extendedKeyUsage = serverAuth
CNF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$E/key.pem" -out "$E/cert.pem" -config "$E/cert.cnf" >/dev/null 2>&1

# o repositório descartável, com um origin: a base no ar, dois commits só de
# docs e um com migration. O commit da corrida (CR, com migration) é enviado ao
# origin DEPOIS do clone, como na corrida real: o checkout do job não o tem
git init -q --bare "$E/origin.git"
git -C "$E/origin.git" config uploadpack.allowReachableSHA1InWant true
git init -q "$E/repo"
cd "$E/repo"
git config user.email ensaio@veyra.test
git config user.name ensaio
git remote add origin "$E/origin.git"
mkdir -p docs apps/api/prisma/migrations/20990101000000_ensaio
echo base >docs/x.md && git add -A && git commit -qm base && C0=$(git rev-parse HEAD)
echo docs >docs/x.md && git commit -qam docs && C1=$(git rev-parse HEAD)
echo docs2 >docs/x.md && git commit -qam docs2 && C2=$(git rev-parse HEAD)
git push -q origin HEAD:refs/heads/main
git branch -q apenas-local
echo 'SELECT 1;' >apps/api/prisma/migrations/20990101000000_ensaio/migration.sql && git add -A && git commit -qm migration && CM=$(git rev-parse HEAD)
git clone -q "$E/origin.git" "$E/outro"
(
  cd "$E/outro"
  git config user.email ensaio@veyra.test
  git config user.name ensaio
  mkdir -p apps/api/prisma/migrations/20990102000000_corrida
  echo 'SELECT 2;' >apps/api/prisma/migrations/20990102000000_corrida/migration.sql
  git add -A && git commit -qm corrida && git push -q origin HEAD:refs/heads/main
)
CR=$(git -C "$E/outro" rev-parse HEAD)
git cat-file -e "$CR^{commit}" 2>/dev/null && { echo "o commit da corrida não deveria estar no checkout" >&2; exit 1; }
SEM_ORIGEM=$(printf '%040d' 7)

# o `gh` simulado: o registro das publicações conferidas num arquivo ("id sha estado")
mkdir -p "$E/bin"
cat >"$E/bin/gh" <<'GH'
#!/usr/bin/env bash
set -eu
case "$*" in
  *"-X POST"*"/statuses"*)
    [ "${GH_FALHA:-}" != registro ] && [ "${GH_FALHA:-}" != status ] || exit 1
    id=$(sed -n 's/.*deployments\/\([0-9]*\)\/statuses.*/\1/p' <<<"$*")
    awk -v i="$id" '$1 == i { $3 = "success" } { print }' "$REGISTRO_ARQ" >"$REGISTRO_ARQ.novo"
    mv "$REGISTRO_ARQ.novo" "$REGISTRO_ARQ" ;;
  *"-X POST"*"/deployments"*)
    [ "${GH_FALHA:-}" != registro ] || exit 1
    ref=$(sed -n 's/.*"ref":"\([0-9a-f]*\)".*/\1/p')
    id=$(($(wc -l <"$REGISTRO_ARQ") + 100))
    echo "$id $ref pendente" >>"$REGISTRO_ARQ"
    echo "$id" ;;
  *"deployments?environment=staging-conferido&sha="*)
    [ "${GH_FALHA:-}" != leitura ] || exit 1
    sha=$(sed -n 's/.*sha=\([0-9a-f]*\).*/\1/p' <<<"$*")
    awk -v s="$sha" '$2 == s { print $1; exit }' "$REGISTRO_ARQ" ;;
  *"/statuses?per_page=1"*)
    id=$(sed -n 's/.*deployments\/\([0-9]*\)\/statuses.*/\1/p' <<<"$*")
    if [ -n "${GH_ESTADO:-}" ]; then echo "$GH_ESTADO"; else awk -v i="$id" '$1 == i { print $3 }' "$REGISTRO_ARQ"; fi ;;
  *) echo "gh simulado: chamada inesperada: $*" >&2; exit 1 ;;
esac
GH
chmod +x "$E/bin/gh"

FALHAS=0
# cenario esperado_saida esperado_texto [SHA] [BASE no ar] [OUTRO publicado] [VAR=valor...]
# SEM_REGISTRO=1: a base não está no registro; ESPERA_REGISTRO=1: o SHA precisa ser registrado
roda() {
  local cen=$1 saida_esperada=$2 texto=$3 sha=${4:-$C1} base=${5:-$C0} outro=${6:-}
  shift $(($# < 6 ? $# : 6))
  local porta=$((20000 + RANDOM % 20000)) saida codigo
  if [ -n "${SEM_REGISTRO:-}" ]; then : >"$E/registro.txt"; else echo "1 $C0 success" >"$E/registro.txt"; fi
  CENARIO=$cen SHA_TESTADO=$sha BASE_NO_AR=$base OUTRO=$outro TOKEN_ESPERADO=$TOKEN \
    python3 -I "$SIMULADO" "$porta" "$E/cert.pem" "$E/key.pem" &
  PID=$!
  for _ in $(seq 1 50); do curl -s --cacert "$E/cert.pem" -o /dev/null "https://127.0.0.1:$porta/api/health" && break; sleep 0.1; done
  saida=$(env -i PATH="$E/bin:$PATH" HOME="$HOME" CURL_CA_BUNDLE="$E/cert.pem" \
    GH_TOKEN=gh-ficticio GITHUB_REPOSITORY=ensaio/veyra REGISTRO_ARQ="$E/registro.txt" GH_FALHA="${GH_FALHA:-}" GH_ESTADO="${GH_ESTADO:-}" \
    COOLIFY_URL="https://127.0.0.1:$porta" COOLIFY_TOKEN="$TOKEN" COOLIFY_APP_UUID=app \
    STAGING_URL="https://127.0.0.1:$porta" SHA="$sha" PONTA="${PONTA_T:-$sha}" INTERVALO_S=0.1 "$@" \
    bash "$SCRIPT" 2>&1) && codigo=0 || codigo=$?
  kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null || true; PID=
  local ok=sim
  [ "$codigo" = "$saida_esperada" ] || ok=nao
  grep -qF -- "$texto" <<<"$saida" || ok=nao
  ! grep -qF -- "$TOKEN" <<<"$saida" || ok=nao
  ! grep -q '^::warning::injetado' <<<"$saida" || ok=nao
  if [ -n "${ESPERA_REGISTRO:-}" ]; then grep -q " $sha success\$" "$E/registro.txt" || ok=nao; fi
  if [ "$codigo" != 0 ] && grep -q " $sha success\$" "$E/registro.txt" && [ "$sha" != "$C0" ]; then ok=nao; fi
  if [ "$ok" = sim ]; then
    printf 'ok      %-28s saída %s\n' "$cen" "$codigo"
  else
    FALHAS=$((FALHAS + 1))
    printf 'FALHOU  %-28s saída %s (esperada %s, texto "%s")\n%s\n' "$cen" "$codigo" "$saida_esperada" "$texto" "$saida"
  fi
}

ESPERA_REGISTRO=1 roda ok 0 "staging no ar com $C1"
roda lista-crua 0 "staging no ar com $C1"
roda so-get 0 "staging no ar com $C1"
roda api-instavel 0 "staging no ar com $C1"
roda auto-desconhecido 0 "não informou o Auto Deploy"
roda falhou 1 "terminou em failed"
roda commit-head 1 "não informou o commit publicado"
roda commit-trocado-sem-migration 1 "sem migration nem mudança guardada" "$C1" "$C0" "$C2"
roda commit-trocado-com-migration 1 "COM migration ou mudança guardada desde a base: fixe AGORA" "$C1" "$C0" "$CM"
roda commit-trocado-na-corrida 1 "COM migration ou mudança guardada desde a base: fixe AGORA" "$C1" "$C0" "$CR"
roda commit-trocado-desconhecido 1 "não sei se traz migration: fixe AGORA" "$C1" "$C0" "$SEM_ORIGEM"
roda auto-ligado 1 "Auto Deploy do Coolify está ligado"
roda fixado 1 "fixado em 2b6deb1"
roda outro-ramo 1 "segue o branch proposta/x"
roda sem-campos 1 "não informou o commit e o branch"
roda em-curso 1 "em andamento no Coolify"
roda sem-base 1 "não informou o commit no ar"
SEM_REGISTRO=1 roda sem-base 0 "base confirmada pela STAGING_BASE" "$C1" "$C0" "" STAGING_BASE="$C0"
roda sem-base 1 "SHA completo" "$C1" "$C0" "" STAGING_BASE=HEAD
roda base-webhook 1 "veio do webhook"
roda origem-desconhecida 1 "nem a origem do último deploy"
roda base-igual 1 "já estava no ar antes deste job"
roda migration-nova 1 "há migration" "$CM" "$C0"
SEM_REGISTRO=1 roda base-nao-conferida 1 "não foi publicado por um Staging conferido"
roda terceiro-push 1 "não foi publicado por um Staging conferido" "$C1" "$CM"
SEM_REGISTRO=1 ESPERA_REGISTRO=1 roda base-pela-variavel 0 "base confirmada pela STAGING_BASE" "$C1" "$C0" "" STAGING_BASE="$C0"
SEM_REGISTRO=1 roda variavel-velha 1 "não foi publicado por um Staging conferido" "$C1" "$C0" "" STAGING_BASE="$C2"
GH_FALHA=leitura roda registro-ilegivel 1 "não consegui ler o registro"
GH_FALHA=registro roda registro-falhou 1 "não consegui registrar a conferência" "$C1" "$C0"
GH_FALHA=status roda registro-sem-status 1 "não consegui registrar a conferência" "$C1" "$C0"
GH_ESTADO=inactive roda registro-inativo 1 "não foi publicado por um Staging conferido"
roda sem-saude 1 "não respondeu 200"
roda api-caiu 1 "falhou 6 vezes seguidas"
roda erro-com-quebra 1 "respondeu 500 ao pedido de deploy"
roda recurso-nao-objeto 1 "não devolveu o recurso no formato esperado"
PONTA_T=$C2 roda ponta-andou 0 "nada publicado por este run"
roda sem-token 1 "falta COOLIFY_TOKEN" "$C1" "$C0" "" COOLIFY_TOKEN=
roda sem-gh-token 1 "falta GH_TOKEN" "$C1" "$C0" "" GH_TOKEN=
roda http-recusado 1 "precisa começar com https://" "$C1" "$C0" "" COOLIFY_URL=http://127.0.0.1:9

if [ "$FALHAS" -gt 0 ]; then
  echo "ENSAIO FALHOU: $FALHAS cenário(s)" >&2
  exit 1
fi
echo "Ensaio OK: todos os cenários da publicação pelo CI"

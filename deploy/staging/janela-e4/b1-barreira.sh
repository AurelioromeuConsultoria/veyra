# E-4 — BLOCO 1: a BARREIRA (G1), e também a VOLTA À BARREIRA (G7, passo 4).
# Liga a TRAVA de manutenção no banco (ADR-053, adendo 1): toda API com o código
# novo que subir DEPOIS sobe em manutenção, qualquer que seja o painel, sem
# terminal nem vigia. Só então para a API e o web (a API que já está rodando
# decide na subida: a trava não a fecha, a parada sim).
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; URL="${E4_URL:-https://veyra-staging.malachdigital.com.br}"; umask 077; mkdir -p "$D"; chmod 700 "$D"
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
  echo "── a trava: ligada no banco e conferida numa sessão NOVA ──"
  printf '%s\n' 'ALTER DATABASE :"banco" SET veyra.manutencao = '"'"'ligada'"'"';' \
    | docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -v banco="$POSTGRES_DB"'
  t=$(trava) || t='(não lida)'
  [ "$t" = ligada ] || pare "a trava não ficou ligada ($t)"
  echo "trava ligada: $(date -u +%FT%TZ)" | tee -a "$D/registro.txt"
  echo "── a API e o web: contidos ──"
  conter
  r=$(rodando api; rodando web || true)
  [ -z "$r" ] || pare "FALHA DE CONTENÇÃO: a API ou o web continuam rodando; a manutenção NÃO está garantida"
  echo "── de fora: nenhum 2xx em /api/ ──"
  c=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$URL/api/health" 2>/dev/null || true)
  case "$c" in 2*) pare "de fora, /api/health deu $c: algo ainda responde";; esac
  echo "de fora: ${c:-sem resposta}"
  echo "BARREIRA_OK: a trava ligada e a API e o web parados ($(date -u +%FT%TZ))" | tee -a "$D/registro.txt"
)

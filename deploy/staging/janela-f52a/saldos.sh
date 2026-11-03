# F5.2a — OS SALDOS DOS PACOTES (DEPLOY_STAGING §4.2), comparados com os que o
# snapshot anotou (pacotes-antes.txt), com a escrita ainda congelada.
#   ROTULO=migration: depois da migration, todos IGUAIS aos de antes;
#   ROTULO=teste: depois do atendimento fictício, EXATAMENTE um pacote com uma
#   sessão a mais (o total igual; o estado só muda se era a última sessão).
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-f52a}"; R="${ROTULO:-}"
  pare() { echo "PARE: $*"; exit 1; }
  case "$R" in migration|teste) ;; *) pare "defina ROTULO=migration ou ROTULO=teste";; esac
  nome() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  DB=$(nome db); [ -n "$DB" ] || pare "o container db não foi achado"
  q() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -F " "'; }
  A="$D/pacotes-antes.txt"; [ -s "$A" ] || pare "sem os saldos anotados no snapshot (passo 2)"
  N="$D/pacotes-$R.txt"
  echo 'SELECT "id", "consumedSessions" || '"'"' de '"'"' || "totalSessions", "status" FROM "ClinicsPackage" ORDER BY "id";' | q > "$N"
  [ "$(cut -d' ' -f1 "$A")" = "$(cut -d' ' -f1 "$N")" ] || pare "a lista de pacotes mudou (o teste não cria pacote)"
  if [ "$R" = migration ]; then
    diff "$A" "$N" >/dev/null || { diff "$A" "$N" | head -10 || true; pare "os saldos mudaram com a migration"; }
    echo "SALDOS_IGUAIS: $(wc -l < "$N" | tr -d ' ') pacote(s), iguais aos de antes da migration"
  else
    # cada linha: id consumidas "de" total estado
    r=$(paste -d' ' "$A" "$N" | awk '
      $2 != $7 || $4 != $9 || $5 != $10 { n++; if ($9 != $4 || $7 != $2 + 1 || ($10 != $5 && !($10 == "completed" && $7 == $9))) ruim = ruim " " $1; else um = $1 " " $2 " de " $4 " → " $7 " de " $9 " " $10 }
      END { if (ruim != "") print "RUIM" ruim; else if (n != 1) print "N " n + 0; else print "OK " um }')
    case "$r" in
      OK*) echo "SALDO_DO_TESTE_OK: exatamente uma sessão a mais em ${r#OK }";;
      N*) pare "${r#N } pacote(s) mudaram; o esperado é exatamente um";;
      *) pare "mudança fora de uma sessão no pacote escolhido:${r#RUIM}";;
    esac
  fi
)

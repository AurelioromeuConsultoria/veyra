# F5.2a — O SNAPSHOT DA JANELA (DEPLOY_STAGING §4.2, passo 2), no host, com a
# barreira de pé. São os comandos do bloco 2 da E-4, com a conferência das
# migrations trocada pela desta janela, mais o contador (§7.1) e o "x de y" de
# cada pacote, anotados para a verificação do passo 7.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-f52a}"; umask 077; mkdir -p "$D"; chmod 700 "$D"
  pare() { echo "PARE: $*"; exit 1; }
  nome() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  rodando() { docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1"; }
  DB=$(nome db); [ -n "$DB" ] || pare "o container db não foi achado"
  q() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -F " "'; }
  # a escrita congelada: a trava ligada (bloco 1) e a API e o web parados
  t=$(echo "SELECT coalesce(current_setting('veyra.manutencao', true), '');" | q) || t='(não lida)'
  [ "$t" = ligada ] || pare "a trava de manutenção no banco não está ligada ($t): rode o bloco 1"
  [ -z "$(rodando api)" ] || pare "a API ainda está rodando"
  [ -z "$(rodando web)" ] || pare "o web ainda está rodando"
  # o ponto de restauração é o banco ANTES da migration desta janela
  ja=$(echo "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20261103120000_clinics_package_corrections';" | q)
  [ "$ja" = 0 ] || pare "o banco já tem a migration desta janela; o ponto de restauração é o dump anterior e não é sobrescrito"
  # a migration para sozinha com contador divergente: melhor saber ANTES do Deploy
  div=$(echo 'SELECT count(*) FROM "ClinicsPackage" p WHERE p."consumedSessions" <> (SELECT count(*) FROM "ClinicsAttendance" a WHERE a."workspaceId" = p."workspaceId" AND a."packageId" = p."id");' | q)
  [ "$div" = 0 ] || pare "$div pacote(s) com o contador divergente (§7.1): a migration pararia; é incidente a investigar antes"
  F="$D/janela-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker exec "$DB" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$F"
  test -s "$F"
  # a leitura INTEIRA do arquivo: um dump truncado falha aqui
  docker exec -i "$DB" pg_restore -f /dev/null < "$F"
  echo "$F" > "$D/janela-arquivo.txt"
  echo "── as contagens da origem (todas as tabelas) ──"
  echo "SELECT table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1;" | q > "$D/janela-contagens.txt"
  wc -l < "$D/janela-contagens.txt" | sed 's/^ */tabelas contadas: /'
  echo "── os pacotes (\"x de y\"), para a verificação do passo 7 ──"
  echo 'SELECT "id", "consumedSessions" || '"'"' de '"'"' || "totalSessions", "status" FROM "ClinicsPackage" ORDER BY "id";' | q | tee "$D/pacotes-antes.txt"
  echo "DUMP_INTEIRO $F $(du -h "$F" | cut -f1) sha256=$(sha256sum "$F" | cut -c1-16)"
)

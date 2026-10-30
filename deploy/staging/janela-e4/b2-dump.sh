# E-4 — BLOCO 2: o SNAPSHOT DA JANELA, com a API e o web parados (a escrita
# congelada). É o ponto de restauração da janela; nenhum backup anterior o substitui.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077; mkdir -p "$D"; chmod 700 "$D"
  c() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  DB=$(c db)
  # a escrita está congelada: a API parada e o web fora do ar
  a=$(docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=api"); [ -z "$a" ] || { echo "PARE: a API ainda está rodando"; exit 1; }
  w=$(docker ps -q --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=web"); [ -z "$w" ] || { echo "PARE: o web ainda está rodando"; exit 1; }
  # o ponto de restauração é o banco ANTES das migrations da janela: com alguma
  # delas já aplicada, este bloco não roda (o dump anterior é que vale)
  ja=$(docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT count(*) FROM _prisma_migrations WHERE migration_name IN ('"'"'20261029220000_invite_authority'"'"', '"'"'20261030090000_workspace_experience'"'"')"')
  [ "$ja" = 0 ] || { echo "PARE: o banco já tem migration da janela; o ponto de restauração é o dump anterior e não é sobrescrito"; exit 1; }
  # uma janela nova: as marcas e o dump de uma tentativa anterior deixam de valer
  rm -f "$D/bloco3-ok.txt" "$D/ensaio-ok.txt" "$D/migrations-ok.txt" "$D/demo-ok.txt" "$D/janela-arquivo.txt" "$D/janela-contagens.txt"
  F="$D/janela-$(date -u +%Y%m%dT%H%M%SZ).dump"
  docker exec "$DB" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$F"
  test -s "$F"
  # a leitura INTEIRA do arquivo: um dump truncado falha aqui
  docker exec -i "$DB" pg_restore -f /dev/null < "$F"
  echo "$F" > "$D/janela-arquivo.txt"
  echo "DUMP_INTEIRO $F $(du -h "$F" | cut -f1) sha256=$(sha256sum "$F" | cut -c1-16)"
  echo "── as contagens da origem (todas as tabelas) ──"
  docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "SELECT table_name, (xpath('"'"'/row/n/text()'"'"', query_to_xml(format('"'"'SELECT count(*) AS n FROM public.%I'"'"', table_name), false, true, '"'"''"'"')))[1]::text FROM information_schema.tables WHERE table_schema = '"'"'public'"'"' AND table_type = '"'"'BASE TABLE'"'"' ORDER BY 1"' | tee "$D/janela-contagens.txt"
  echo "── o que estava em andamento (despachos pendentes ou em voo) ──"
  docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "SELECT state, (\"dispatchedAt\" IS NOT NULL) AS marcado, count(*) FROM \"MessageDispatch\" WHERE state IN ('"'"'reserved'"'"', '"'"'failed_before_send'"'"', '"'"'sending'"'"') GROUP BY 1, 2 ORDER BY 1, 2"'
  echo "BLOCO2_OK: o snapshot da janela, conferido"
)

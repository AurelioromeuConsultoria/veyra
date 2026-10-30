# E-4 — BLOCO 9: a VOLTA DO BANCO ao snapshot da janela. Só com autorização do
# usuário, com a API e o web PARADOS. Restaura o dump num banco NOVO (numa
# transação só), confere as contagens e troca pelo nome (§6, passo 4); o banco
# atual fica guardado como <banco>_falho_e4_<instante>. Nenhum container antigo
# é religado.
( set -euo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; umask 077
  SQL_PARADA='SELECT i."workspaceId", count(*) FROM "Invite" i JOIN "Role" r ON r."workspaceId" = i."workspaceId" AND r."id" = i."roleId" WHERE i."acceptedAt" IS NULL AND r."systemKey" = '\''owner'\'' AND NOT EXISTS (SELECT 1 FROM "Membership" m JOIN "Role" o ON o."workspaceId" = m."workspaceId" AND o."id" = m."roleId" WHERE m."workspaceId" = i."workspaceId" AND m."status" = '\''active'\'' AND o."systemKey" = '\''owner'\'') GROUP BY i."workspaceId";'
  SQL_PENDENTES='SELECT count(*) FROM "Invite" WHERE "acceptedAt" IS NULL;'
  SQL_INV_CONVITES="SELECT 'coluna', column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Invite' AND column_name IN ('createdByMembershipId', 'issuedByProvisioning') UNION ALL SELECT 'restricao', conname::text FROM pg_constraint WHERE conrelid = '\"Invite\"'::regclass AND contype <> 'n' AND conname IN ('Invite_workspaceId_createdByMembershipId_fkey', 'Invite_autoridade_conhecida') UNION ALL SELECT 'indice', indexname::text FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Invite' AND indexname = 'Invite_workspaceId_createdByMembershipId_idx';"
  SQL_INV_EXPERIENCIA="SELECT 'coluna', column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Workspace' AND column_name = 'experience' UNION ALL SELECT 'restricao', conname::text FROM pg_constraint WHERE conrelid = '\"Workspace\"'::regclass AND contype <> 'n' AND conname = 'Workspace_experience_formato';"
  SQL_INVALIDADOS="SELECT count(*) FROM \"AuditLog\" WHERE action = 'invite.invalidated';"
  SQL_EXPERIENCIAS='SELECT slug, experience FROM "Workspace" ORDER BY slug;'
  SQL_FORA_DO_ESPERADO="SELECT count(*) FROM \"Workspace\" WHERE (slug = 'demo' AND experience <> 'clinics') OR (slug <> 'demo' AND experience <> 'crm');"
  SQL_TROCAS="SELECT w.slug, a.\"actorId\", a.before::text, a.after::text FROM \"AuditLog\" a JOIN \"Workspace\" w ON w.id = a.\"entityId\"::uuid WHERE a.action = 'workspace.experience_changed' ORDER BY a.\"createdAt\";"
  SQL_CLINICS='SELECT count(*) FROM "ClinicsSettings";'
  SQL_CONTAGENS="SELECT table_name, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1;"
  SQL_APLICADAS='SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
  SQL_EM_ANDAMENTO='SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;'
  SQL_NAO_CRM="SELECT count(*) FROM \"Workspace\" WHERE experience <> 'crm';"
  SQL_TROCA_DEMO="SELECT count(*) FROM \"AuditLog\" a JOIN \"Workspace\" w ON w.id = a.\"entityId\" WHERE a.action = 'workspace.experience_changed' AND w.slug = 'demo' AND a.\"actorId\" = 'cli:workspace-experience' AND a.after ->> 'experience' = 'clinics';"
  SQL_TROCAS_TOTAL="SELECT count(*) FROM \"AuditLog\" WHERE action = 'workspace.experience_changed';"
  SQL_CLINICS_FORA="SELECT count(*) FROM \"ClinicsSettings\" s JOIN \"Workspace\" w ON w.id = s.\"workspaceId\" WHERE w.slug <> 'demo' AND s.status = 'active';"
  SQL_CLINICS_DEMO="SELECT count(*) FROM \"ClinicsSettings\" s JOIN \"Workspace\" w ON w.id = s.\"workspaceId\" WHERE w.slug = 'demo' AND s.status = 'active';"
  SQL_COLUNA_EXPERIENCIA="SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Workspace' AND column_name = 'experience';"
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
  a=$(rodando api); w=$(rodando web); [ -z "$a$w" ] || pare "a API ou o web estão rodando; a volta do banco é com os dois parados"
  F=$(cat "$D/janela-arquivo.txt"); [ -s "$F" ] || pare "o dump da janela não está em $F"
  DB=$(nome db)
  VIVO=$(docker exec "$DB" sh -c 'printf %s "$POSTGRES_DB"')
  T=$(date -u +%Y%m%d%H%M); NOVO="${VIVO}_restaurado_e4_$T"; FALHO="${VIVO}_falho_e4_$T"
  for b in "$NOVO" "$FALHO"; do grep -qxE '[a-z0-9_]{1,63}' <<<"$b" || pare "nome de banco inválido: $b"; done
  qn() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$1" -At -v ON_ERROR_STOP=1 -F " "' sh "$1"; }
  descartar() { docker exec "$DB" sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$1"' sh "$NOVO"; }
  echo "── o dump $F num banco NOVO, $NOVO, numa transação só ──"
  docker exec "$DB" sh -c 'createdb -U "$POSTGRES_USER" "$1"' sh "$NOVO"
  if ! docker exec -i "$DB" sh -c 'pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U "$POSTGRES_USER" -d "$1"' sh "$NOVO" < "$F" > "$D/volta-restore.log" 2>&1; then
    tail -5 "$D/volta-restore.log" || true; descartar
    pare "o pg_restore falhou; o banco novo foi descartado e o atual não foi tocado"
  fi
  echo "$SQL_CONTAGENS" | qn "$NOVO" > "$D/volta-contagens.txt"
  diff "$D/janela-contagens.txt" "$D/volta-contagens.txt" >/dev/null || { descartar; pare "as contagens do banco novo diferem das do dump; o banco novo foi descartado"; }
  ja=$(echo "SELECT count(*) FROM _prisma_migrations WHERE migration_name IN ('20261029220000_invite_authority', '20261030090000_workspace_experience');" | qn "$NOVO")
  [ "$ja" = 0 ] && [ "$(echo "$SQL_COLUNA_EXPERIENCIA" | qn "$NOVO")" = 0 ] || { descartar; pare "o dump já está MIGRADO (não é o ponto de antes da janela); o banco novo foi descartado"; }
  echo "contagens iguais às do dump; migrations: $(echo "$SQL_APLICADAS" | qn "$NOVO" | wc -l | tr -d ' '); coluna experience: $(echo "$SQL_COLUNA_EXPERIENCIA" | qn "$NOVO"); convites pendentes: $(echo "$SQL_PENDENTES" | qn "$NOVO")"
  echo "── a troca pelo nome, numa transação só, conectado ao postgres ──"
  printf '%s\n' \
    "SELECT count(pg_terminate_backend(pid)) AS encerradas FROM pg_stat_activity WHERE datname = :'vivo' AND pid <> pg_backend_pid();" \
    'BEGIN;' 'ALTER DATABASE :"vivo" RENAME TO :"falho";' 'ALTER DATABASE :"novo" RENAME TO :"vivo";' 'COMMIT;' \
    | docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -v vivo="$POSTGRES_DB" -v novo="$1" -v falho="$2"' sh "$NOVO" "$FALHO"
  echo "$SQL_CONTAGENS" | qn "$VIVO" | diff "$D/janela-contagens.txt" - >/dev/null || pare "depois da troca, o banco vivo não tem as contagens do dump"
  echo "o banco vivo é o restaurado; o anterior ficou como $FALHO (sai só com autorização)"
  echo VOLTA_DO_BANCO_OK
)

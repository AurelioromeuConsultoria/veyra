# E-4 — BLOCO 6: a troca SÓ do demo para clinics, ainda atrás da barreira; as
# conferências pela CLI e pelo banco (nenhum acesso pela API em manutenção).
# Uma vez só: depois do DEMO_CLINICS_OK, ele não se repete.
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
  barreira
  [ ! -e "$D/demo-ok.txt" ] || pare "o DEMO_CLINICS_OK já saiu nesta janela; o bloco 6 não se repete"
  [ -s "$D/migrations-ok.txt" ] || pare "sem o MIGRATIONS_E4_OK do bloco 5"
  API=$(rodando api)
  [ "$(docker inspect "$API" --format '{{.Id}}' 2>/dev/null || true)" = "$(sed -n 1p "$D/bloco3-ok.txt" 2>/dev/null || true)" ] || pare "a API rodando não é a que o vigia aprovou (bloco 3)"
  AMB=$(nao_secreto "$API"); grep -qx 'MAINTENANCE_MODE=true' <<<"$AMB" || { parar_tudo; pare "a API não está em manutenção"; }
  web_parado
  DB=$(nome db)
  q() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -F " "'; }
  # a CLI carrega `sem-jobs` antes do módulo, e a API está em manutenção: nenhum worker
  docker exec "$API" node dist/cli/workspace-experience.js --slug demo --experience clinics || pare "a CLI recusou a troca"
  echo "── as experiências ──"; echo "$SQL_EXPERIENCIAS" | q
  [ "$(echo "$SQL_FORA_DO_ESPERADO" | q)" = 0 ] || pare "algum workspace fora do esperado"
  echo "── a trilha (uma troca, a do demo para clinics, pela CLI) ──"; echo "$SQL_TROCAS" | q
  [ "$(echo "$SQL_TROCA_DEMO" | q)" = 1 ] && [ "$(echo "$SQL_TROCAS_TOTAL" | q)" = 1 ] || pare "a trilha não tem exatamente uma troca, a do demo para clinics pela CLI"
  [ "$(echo "$SQL_CLINICS_FORA" | q)" = 0 ] && [ "$(echo "$SQL_CLINICS_DEMO" | q)" = 1 ] || pare "o Clinics não está ativo só no demo"
  echo "o Clinics ativo só no demo"
  date -u > "$D/demo-ok.txt"
  echo DEMO_CLINICS_OK
)

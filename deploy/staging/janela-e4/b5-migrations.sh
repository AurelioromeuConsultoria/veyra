# E-4 — BLOCO 5: as migrations no banco REAL, atrás da barreira (a API nova em
# manutenção, que não lê nem escreve tabela). Só depois do ENSAIO_DA_JANELA_E4_OK,
# e uma vez só: depois do MIGRATIONS_E4_OK, ele não se repete.
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
  [ ! -e "$D/migrations-ok.txt" ] || pare "o MIGRATIONS_E4_OK já saiu nesta janela; o bloco 5 não se repete (siga para o bloco 6)"
  L=real
  API=$(rodando api)
  [ "$(docker inspect "$API" --format '{{.Id}}' 2>/dev/null || true)" = "$(sed -n 1p "$D/bloco3-ok.txt" 2>/dev/null || true)" ] || pare "a API rodando não é a que o vigia aprovou (bloco 3)"
  AMB=$(nao_secreto "$API"); grep -qx 'MAINTENANCE_MODE=true' <<<"$AMB" || { parar_tudo; pare "a API não está em manutenção"; }
  web_parado
  DB=$(nome db)
  q() { docker exec -i "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -F " "'; }
  x() { docker exec "$API" "$@"; }
  echo "── PARADA: convite de Owner pendente em workspace sem Owner ativo ──"
  parada=$(echo "$SQL_PARADA" | q)
  [ -z "$parada" ] || pare "$parada (sem caminho seguro de reemissão; nenhum criador é inventado)"
  echo "nenhuma"
  # o que o bloco 4 ensaiou: a mesma imagem e o mesmo dump
  [ -s "$D/ensaio-ok.txt" ] || pare "sem o ENSAIO_DA_JANELA_E4_OK do bloco 4"
  [ "$(docker inspect "$API" --format '{{.Image}}')" = "$(sed -n 1p "$D/ensaio-ok.txt")" ] || pare "a imagem da API não é a do ensaio (bloco 4)"
  [ "$(cat "$D/janela-arquivo.txt")" = "$(sed -n 2p "$D/ensaio-ok.txt")" ] || pare "o ensaio foi feito com outro dump; rode o bloco 4 de novo"
  echo "── o banco real continua igual ao snapshot da janela (as contagens) ──"
  echo "$SQL_CONTAGENS" | q > "$D/real-contagens.txt"
  diff "$D/janela-contagens.txt" "$D/real-contagens.txt" >/dev/null || { diff "$D/janela-contagens.txt" "$D/real-contagens.txt" | head || true; pare "o banco real mudou desde o dump da janela; a janela para aqui"; }
  echo "contagens iguais às do dump"
  pendentes=$(echo "$SQL_PENDENTES" | q); echo "convites pendentes que serão invalidados: $pendentes" | tee "$D/convites-invalidados.txt"
  inv0=$(echo "$SQL_INVALIDADOS" | q)
  echo "── as migrations pendentes do banco REAL, iguais às da cópia ──"
  em=$(echo "$SQL_EM_ANDAMENTO" | q); [ -z "$em" ] || pare "migration em andamento ou falhada (§4): $em"
  x ls prisma/migrations | grep -E '^[0-9]{14}_' | LC_ALL=C sort > "$D/migrations-da-imagem-real.txt"
  echo "$SQL_APLICADAS" | q | LC_ALL=C sort > "$D/migrations-aplicadas-real.txt"
  fora=$(LC_ALL=C comm -13 "$D/migrations-da-imagem-real.txt" "$D/migrations-aplicadas-real.txt")
  [ -z "$fora" ] || pare "o banco tem migration que a imagem nova não tem: $fora"
  LC_ALL=C comm -23 "$D/migrations-da-imagem-real.txt" "$D/migrations-aplicadas-real.txt" > "$D/migrations-pendentes-real.txt"
  cat "$D/migrations-pendentes-real.txt"
  tail -n +3 "$D/ensaio-ok.txt" | diff - "$D/migrations-pendentes-real.txt" >/dev/null || pare "as pendentes do banco real diferem das da cópia (bloco 4)"
  # cada conferência para com o motivo (um `cmd && echo` não interrompe com set -e)
  if ! x npx --no-install prisma migrate deploy > "$D/$L-deploy.log" 2>&1; then
    grep -E 'Error|P[0-9]{4}' "$D/$L-deploy.log" | cut -c1-160 || true; pare "o migrate deploy falhou (§4, Falha de migration; nunca rolled-back às cegas)"
  fi
  grep -E 'Applying|applied' "$D/$L-deploy.log" | cut -c1-160 || true
  x npx --no-install prisma migrate status > "$D/$L-status.log" 2>&1 || { tail -4 "$D/$L-status.log"; pare "o status não está em dia depois do deploy"; }
  tail -1 "$D/$L-status.log"
  x npx --no-install prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code > "$D/$L-diff.log" 2>&1 || { head -20 "$D/$L-diff.log"; pare "o schema difere do código"; }
  echo "schema igual ao do código"
  n1=$(echo "$SQL_INV_CONVITES" | q | wc -l | tr -d ' '); n2=$(echo "$SQL_INV_EXPERIENCIA" | q | wc -l | tr -d ' ')
  [ "$n1" = 5 ] && [ "$n2" = 2 ] || pare "inventários $n1 e $n2 (esperado 5 e 2)"
  inv=$(( $(echo "$SQL_INVALIDADOS" | q) - inv0 )); rest=$(echo "$SQL_PENDENTES" | q)
  [ "$inv" = "$pendentes" ] && [ "$rest" = 0 ] || pare "invalidados $inv, pendentes antes $pendentes, depois $rest"
  echo "inventários 5 e 2; $inv convites invalidados, com trilha; nenhum pendente"
  echo "convites invalidados pela migration (trilha invite.invalidated): $inv" >> "$D/convites-invalidados.txt"
  echo "── as experiências: todas em crm ──"; echo "$SQL_EXPERIENCIAS" | q
  [ "$(echo "$SQL_NAO_CRM" | q)" = 0 ] || pare "há workspace fora de crm logo depois da migration"
  echo "── as FKs entre workspaces e o Clinics (ativo só no demo) ──"
  x node dist/cli/check-cross-tenant-fk.js > "$D/$L-fk.log" 2>&1 || { tail -5 "$D/$L-fk.log"; pare "o check:fk acusou FK entre workspaces"; }
  tail -2 "$D/$L-fk.log"
  [ "$(echo "$SQL_CLINICS_FORA" | q)" = 0 ] && [ "$(echo "$SQL_CLINICS_DEMO" | q)" = 1 ] || pare "o Clinics não está ativo só no demo"
  echo "o Clinics ativo só no demo"
  date -u > "$D/migrations-ok.txt"
  echo MIGRATIONS_E4_OK
)

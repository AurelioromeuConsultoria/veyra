# E-4 — BLOCO 4: o ensaio numa CÓPIA isolada do snapshot da janela, com a imagem
# NOVA (pelo id, a do container que o vigia aprovou). O banco do staging não é tocado.
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
  # a marca do ensaio, que o bloco 5 exige: só existe se este bloco chegar ao fim
  rm -f "$D/ensaio-ok.txt"; L=copia
  [ -s "$D/bloco3-ok.txt" ] || pare "sem o BLOCO3_OK do vigia"
  API=$(rodando api)
  [ "$(docker inspect "$API" --format '{{.Id}}' 2>/dev/null || true)" = "$(sed -n 1p "$D/bloco3-ok.txt" 2>/dev/null || true)" ] || pare "a API rodando não é a que o vigia aprovou (bloco 3)"
  AMB=$(nao_secreto "$API"); grep -qx 'MAINTENANCE_MODE=true' <<<"$AMB" || { parar_tudo; pare "a API não está em manutenção"; }
  web_parado
  IMG_API=$(sed -n 2p "$D/bloco3-ok.txt")
  [ "$(docker inspect "$API" --format '{{.Image}}')" = "$IMG_API" ] || pare "a imagem da API mudou desde o vigia"
  DB=$(nome db); F=$(cat "$D/janela-arquivo.txt"); [ -s "$F" ] || pare "o dump da janela não está em $F"
  IMG_DB=$(docker inspect "$DB" --format '{{.Image}}')
  echo "imagem nova: $(docker inspect "$API" --format '{{.Config.Image}}') ($(cut -c1-19 <<<"$IMG_API"))"
  R=veyra-ensaio-e4; EC=veyra-ensaio-e4-db
  limpar() { docker rm -f -v "$EC" >/dev/null 2>&1 || true; docker network rm "$R" >/dev/null 2>&1 || true; }
  trap limpar EXIT; limpar
  # a cópia, numa rede SEM saída; as imagens pelo id, sem baixar nada
  docker network create --internal "$R" >/dev/null
  docker run -d --pull never --name "$EC" --network "$R" --network-alias ensaio-db -e POSTGRES_USER=ensaio -e POSTGRES_PASSWORD=ensaio -e POSTGRES_DB=ensaio "$IMG_DB" >/dev/null
  n=0; until docker exec "$EC" pg_isready -h 127.0.0.1 -U ensaio >/dev/null 2>&1; do n=$((n+1)); [ "$n" -lt 120 ] || pare "a cópia não subiu"; sleep 1; done; sleep 2
  docker exec -i "$EC" pg_restore --single-transaction --exit-on-error --no-owner --no-privileges -U ensaio -d ensaio < "$F"
  q() { docker exec -i "$EC" psql -U ensaio -d ensaio -At -v ON_ERROR_STOP=1 -F " "; }
  # o container AVULSO da imagem nova: as variáveis são só estas (segredos
  # fictícios, gerados agora e descartados; manutenção e jobs desligados;
  # transporte simulado), e ele só alcança a cópia
  fict() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
  F1=$(fict); F2=$(fict); F3=$(fict); F4=$(fict)
  cli() { docker run --rm --pull never --network "$R" -e DATABASE_URL=postgresql://ensaio:ensaio@ensaio-db:5432/ensaio \
    -e NODE_ENV=production -e VEYRA_ENV=staging -e META_TRANSPORT_MODE=fake -e MAINTENANCE_MODE=true -e DISABLE_JOBS=true \
    -e WEB_ORIGIN=https://ensaio.invalid -e JWT_SECRET="$F1" -e TOKEN_ENCRYPTION_KEY="$F2" -e ADDRESS_LOCK_KEY="$F3" \
    -e OUTBOUND_APPROVAL_KEY="$F4" "$IMG_API" "$@"; }
  echo "── o snapshot restaurado tem as contagens da origem (escrita congelada) ──"
  echo "$SQL_CONTAGENS" | q > "$D/copia-contagens.txt"
  diff "$D/janela-contagens.txt" "$D/copia-contagens.txt" >/dev/null || { diff "$D/janela-contagens.txt" "$D/copia-contagens.txt" | head || true; pare "as contagens da cópia diferem da origem"; }
  echo "contagens iguais"
  echo "── PARADA: convite de Owner pendente em workspace sem Owner ativo ──"
  parada=$(echo "$SQL_PARADA" | q)
  [ -z "$parada" ] || pare "$parada (sem caminho seguro de reemissão; nenhum criador é inventado)"
  echo "nenhuma"
  pendentes=$(echo "$SQL_PENDENTES" | q); echo "convites pendentes que a invite_authority vai invalidar: $pendentes"
  inv0=$(echo "$SQL_INVALIDADOS" | q)
  echo "── as migrations pendentes, pelo ESTADO REAL: as pastas da imagem nova menos as aplicadas ──"
  em=$(echo "$SQL_EM_ANDAMENTO" | q); [ -z "$em" ] || pare "migration em andamento ou falhada (§4): $em"
  cli ls prisma/migrations | grep -E '^[0-9]{14}_' | LC_ALL=C sort > "$D/migrations-da-imagem.txt"
  echo "$SQL_APLICADAS" | q | LC_ALL=C sort > "$D/migrations-aplicadas-copia.txt"
  fora=$(LC_ALL=C comm -13 "$D/migrations-da-imagem.txt" "$D/migrations-aplicadas-copia.txt")
  [ -z "$fora" ] || pare "o banco tem migration que a imagem nova não tem: $fora"
  LC_ALL=C comm -23 "$D/migrations-da-imagem.txt" "$D/migrations-aplicadas-copia.txt" > "$D/migrations-pendentes.txt"
  echo "aplicadas: $(wc -l < "$D/migrations-aplicadas-copia.txt" | tr -d ' '); pendentes:"; cat "$D/migrations-pendentes.txt"
  printf '%s\n' 20261029220000_invite_authority 20261030090000_workspace_experience > "$D/migrations-esperadas.txt"
  diff "$D/migrations-esperadas.txt" "$D/migrations-pendentes.txt" >/dev/null || pare "as pendentes reais diferem das esperadas; o roteiro é revisto antes de seguir"
  # cada conferência para com o motivo (um `cmd && echo` não interrompe com set -e)
  if ! cli npx --no-install prisma migrate deploy > "$D/$L-deploy.log" 2>&1; then
    grep -E 'Error|P[0-9]{4}' "$D/$L-deploy.log" | cut -c1-160 || true; pare "o migrate deploy falhou (§4, Falha de migration; nunca rolled-back às cegas)"
  fi
  grep -E 'Applying|applied' "$D/$L-deploy.log" | cut -c1-160 || true
  cli npx --no-install prisma migrate status > "$D/$L-status.log" 2>&1 || { tail -4 "$D/$L-status.log"; pare "o status não está em dia depois do deploy"; }
  tail -1 "$D/$L-status.log"
  cli npx --no-install prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code > "$D/$L-diff.log" 2>&1 || { head -20 "$D/$L-diff.log"; pare "o schema difere do código"; }
  echo "schema igual ao do código"
  echo "── os inventários (5 e 2) e os convites invalidados ──"
  n1=$(echo "$SQL_INV_CONVITES" | q | wc -l | tr -d ' '); n2=$(echo "$SQL_INV_EXPERIENCIA" | q | wc -l | tr -d ' ')
  [ "$n1" = 5 ] && [ "$n2" = 2 ] || pare "inventários $n1 e $n2 (esperado 5 e 2)"
  inv=$(( $(echo "$SQL_INVALIDADOS" | q) - inv0 )); rest=$(echo "$SQL_PENDENTES" | q)
  [ "$inv" = "$pendentes" ] && [ "$rest" = 0 ] || pare "invalidados $inv, pendentes antes $pendentes, depois $rest"
  echo "inventários 5 e 2; $inv convites invalidados, com trilha; nenhum pendente"
  echo "── as experiências: todas em crm ──"; echo "$SQL_EXPERIENCIAS" | q
  [ "$(echo "$SQL_NAO_CRM" | q)" = 0 ] || pare "há workspace fora de crm logo depois da migration"
  echo "── a troca SÓ do demo, pela CLI ──"
  cli node dist/cli/workspace-experience.js --slug demo --experience clinics || pare "a CLI recusou a troca"
  echo "$SQL_EXPERIENCIAS" | q
  [ "$(echo "$SQL_FORA_DO_ESPERADO" | q)" = 0 ] || pare "algum workspace fora do esperado"
  echo "── a trilha da troca (uma, a do demo, pela CLI) ──"; echo "$SQL_TROCAS" | q
  [ "$(echo "$SQL_TROCA_DEMO" | q)" = 1 ] && [ "$(echo "$SQL_TROCAS_TOTAL" | q)" = 1 ] || pare "a trilha não tem exatamente uma troca, a do demo para clinics pela CLI"
  echo "── as FKs entre workspaces e o Clinics (ativo só no demo) ──"
  cli node dist/cli/check-cross-tenant-fk.js > "$D/$L-fk.log" 2>&1 || { tail -5 "$D/$L-fk.log"; pare "o check:fk acusou FK entre workspaces"; }
  tail -2 "$D/$L-fk.log"
  [ "$(echo "$SQL_CLINICS_FORA" | q)" = 0 ] && [ "$(echo "$SQL_CLINICS_DEMO" | q)" = 1 ] || pare "o Clinics não está ativo só no demo"
  echo "o Clinics ativo só no demo"
  { echo "$IMG_API"; echo "$F"; cat "$D/migrations-pendentes.txt"; } > "$D/ensaio-ok.txt"
  echo ENSAIO_DA_JANELA_E4_OK
)

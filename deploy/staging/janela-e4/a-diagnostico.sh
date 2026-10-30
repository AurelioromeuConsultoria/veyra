# E-4 — BLOCO A: diagnóstico SÓ DE LEITURA (no terminal do SERVIDOR no Coolify).
# Nada é parado, reiniciado nem alterado. Nenhum segredo é impresso: das
# variáveis, só os modos e o NOME das chaves com valor. A saída fica em
# /root/veyra-e4 (só root) e é mostrada na tela.
( set -uo pipefail
  P="${E4_P:-umoaea9vz6qchhhh5wkg0bv9}"; D="${E4_D:-/root/veyra-e4}"; URL="${E4_URL:-https://veyra-staging.malachdigital.com.br}"; umask 077; mkdir -p "$D"; chmod 700 "$D"
  O="$D/diagnostico-$(date -u +%Y%m%dT%H%M%SZ).txt"
  {
  c() { docker ps -a --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=$1" --format '{{.Names}}' | head -1; }
  API=$(c api); WEB=$(c web); DB=$(c db); BK=$(c backup)
  sql() { docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " | " -c "$1"' sh "$1"; }
  echo "== quando: $(date -u)"; uptime; df -h / /var/lib/docker 2>/dev/null | tail -n +1
  echo "== os projetos com um serviço api (confira que o do Veyra é $P)"
  docker ps -a --filter "label=com.docker.compose.service=api" --format '{{.Label "com.docker.compose.project"}} | {{.Names}} | {{.Image}}'
  echo "== os containers do Veyra"
  docker ps -a --filter "label=com.docker.compose.project=$P" --format '{{.Names}} | {{.Status}} | {{.Image}} | {{.CreatedAt}}'
  echo "== a imagem e o commit da API em uso"
  IMG=$(docker inspect "$API" --format '{{.Config.Image}}'); echo "imagem: $IMG"
  docker image inspect "$IMG" --format '{{.Created}}' | sed 's/^/construída em: /'
  docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(SOURCE_COMMIT|COOLIFY_BRANCH)=' || echo "(sem SOURCE_COMMIT no ambiente: confira o commit no painel, no último deploy)"
  echo "== o ambiente NÃO secreto da API"
  docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^(MAINTENANCE_MODE|DISABLE_JOBS|META_TRANSPORT_MODE|VEYRA_ENV|NODE_ENV)='
  echo "== as chaves com valor (só o nome)"
  docker inspect "$API" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -oE '^(ADDRESS_LOCK_KEY|OUTBOUND_APPROVAL_KEY|JWT_SECRET|TOKEN_ENCRYPTION_KEY)=.' | cut -d= -f1 | sort
  echo "== as migrations no BANCO (as 6 últimas; o total; alguma em andamento ou falhada?)"
  sql 'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 6'
  sql 'SELECT count(*) AS total FROM _prisma_migrations WHERE rolled_back_at IS NULL'
  sql 'SELECT migration_name AS EM_ANDAMENTO_OU_FALHADA FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL'
  echo "== o status das migrations pela imagem EM USO (o esperado: em dia com ela)"
  docker exec -e NPM_CONFIG_UPDATE_NOTIFIER=false "$API" npx --no-install prisma migrate status 2>&1 | grep -E 'migrations? found|not yet been applied|^[0-9]{14}_|up to date|failed|Error|P[0-9]{4}' || echo "(o status saiu com pendentes ou erro: leia as linhas acima)"
  echo "== os workspaces; a coluna experience ainda NÃO deve existir"
  sql 'SELECT slug, name, "createdAt" FROM "Workspace" ORDER BY slug'
  sql "SELECT count(*) AS coluna_experience FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Workspace' AND column_name = 'experience'"
  echo "== o Clinics, por workspace (só no demo)"
  sql 'SELECT w.slug, s.status, s."activatedAt" FROM "ClinicsSettings" s JOIN "Workspace" w ON w.id = s."workspaceId" ORDER BY 1'
  echo "== os convites PENDENTES que a invite_authority vai invalidar (o número vai para o log da janela)"
  sql 'SELECT w.slug, r.name AS papel, count(*) FROM "Invite" i JOIN "Workspace" w ON w.id = i."workspaceId" JOIN "Role" r ON r."workspaceId" = i."workspaceId" AND r.id = i."roleId" WHERE i."acceptedAt" IS NULL GROUP BY 1, 2 ORDER BY 1, 2'
  sql 'SELECT count(*) AS pendentes_total FROM "Invite" WHERE "acceptedAt" IS NULL'
  echo "== PARADA: convite de Owner pendente em workspace SEM Owner ativo (o esperado: nenhuma linha)"
  sql 'SELECT i."workspaceId", count(*) AS convites_de_owner FROM "Invite" i JOIN "Role" r ON r."workspaceId" = i."workspaceId" AND r."id" = i."roleId" WHERE i."acceptedAt" IS NULL AND r."systemKey" = '"'"'owner'"'"' AND NOT EXISTS (SELECT 1 FROM "Membership" m JOIN "Role" o ON o."workspaceId" = m."workspaceId" AND o."id" = m."roleId" WHERE m."workspaceId" = i."workspaceId" AND m."status" = '"'"'active'"'"' AND o."systemKey" = '"'"'owner'"'"') GROUP BY i."workspaceId"'
  echo "== os campos personalizados de contato, por workspace (obrigatórios contam para o Novo interessado)"
  sql 'SELECT w.slug, count(*) AS campos, count(*) FILTER (WHERE d.required) AS obrigatorios FROM "CustomFieldDefinition" d JOIN "Workspace" w ON w.id = d."workspaceId" WHERE d."entityType" = '"'"'contact'"'"' GROUP BY 1 ORDER BY 1'
  echo "== o tamanho do demo (contatos, pacientes, agendamentos) e os despachos pendentes ou em voo"
  sql 'SELECT w.slug, (SELECT count(*) FROM "Contact" c WHERE c."workspaceId" = w.id) AS contatos, (SELECT count(*) FROM "ClinicsPatient" p WHERE p."workspaceId" = w.id) AS pacientes, (SELECT count(*) FROM "ClinicsAppointment" a WHERE a."workspaceId" = w.id) AS agendamentos FROM "Workspace" w ORDER BY 1'
  sql 'SELECT state, count(*) FROM "MessageDispatch" WHERE state IN ('"'"'reserved'"'"', '"'"'failed_before_send'"'"', '"'"'sending'"'"') GROUP BY 1'
  echo "== a saúde: loopback, rede interna e de fora"
  docker exec "$API" curl -sS -o /dev/null -w 'loopback %{http_code}\n' http://127.0.0.1:3001/api/health
  docker exec "$DB" wget -S -O /dev/null http://api:3001/api/health 2>&1 | grep -m1 -E 'HTTP/' || true
  curl -sS -o /dev/null -w 'de fora %{http_code}\n' "$URL/api/health"
  echo "== o backup: o container, a versão do restic, se há destino (só o nome) e o horário diário"
  [ -n "$BK" ] && docker inspect "$BK" --format '{{.Name}} | {{.State.Status}}'
  [ -n "$BK" ] && docker exec "$BK" restic version
  [ -n "$BK" ] && docker inspect "$BK" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -oE '^RESTIC_REPOSITORY=.' | cut -d= -f1 | sed 's/$/ com valor/' || true
  [ -n "$BK" ] && docker inspect "$BK" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^BACKUP_AT='
  echo "== o dump da janela anterior (ainda guardado?)"
  ls -la /root/veyra-inc-2026-10-26/*.dump 2>/dev/null | cut -c1-120 || echo "(nenhum)"
  echo DIAGNOSTICO_FIM
  } 2>&1 | tee "$O"
  echo "salvo em $O"
)

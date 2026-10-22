---
name: create-migration
description: Change the database schema safely — catch destructive statements before they run, wrap every new migration in an explicit transaction (ADR-051), rehearse its failure and recovery, keep migrations paired with code, and never edit a published migration.
---

# create-migration

Referências: `docs/DOMAIN_MODEL.md §1`, `docs/SECURITY.md §2`, `docs/DECISIONS.md` ADR-051 (a regra) e ADR-048 adendo 7 (o ensaio que a motivou), `docs/DEPLOY_STAGING.md §4` ("Falha de migration"), hook `block-destructive-migration.sh`.

**Por quê:** o `prisma migrate deploy` executa a migration instrução por instrução, sem transação. Uma falha no meio deixa aplicado o que veio antes, e repetir depois do `resolve --rolled-back` falha nos objetos que já existem. Isso foi ensaiado (ADR-048 adendo 7).

## Passos

1. **Altere o schema em `prisma/schema/`** (o arquivo do dono: `schema.prisma` para o Core, um arquivo por vertical) seguindo as convenções (workspaceId, índices compostos, FKs compostas). Revise o diff do schema antes de gerar.
2. **Gere SEM aplicar**: `prisma migrate dev --create-only --name <snake_case_descritivo>`. A migration precisa ser editada (passo 4) antes da primeira aplicação, porque editar depois muda o checksum.
3. **Leia o SQL gerado inteiro** antes de aceitar. Procure destrutividade:
   - `DROP TABLE` / `TRUNCATE` → não passa (hook nega); exige plano aprovado com backup e migração de dados.
   - `DROP COLUMN` → só com plano: código que lia a coluna já removido em release anterior? Dados migrados?
   - `NOT NULL` sem `DEFAULT` em tabela com linhas → duas etapas (adicionar nullable + backfill + constraint) ou DEFAULT.
   - Estreitamento de tipo / mudança de unique → verifique dados existentes primeiro.
4. **Transação explícita (ADR-051).** Envolva tudo em `BEGIN;` … `COMMIT;`. Configuração de sessão vai com `SET LOCAL` (por exemplo, `SET LOCAL lock_timeout = '5s';` quando houver lock em tabela muito escrita); nada de `RESET`.
   - **Exceção**, só para o que o Postgres recusa com "cannot run inside a transaction block" (por exemplo, `CREATE/DROP/REINDEX ... CONCURRENTLY` e `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY`; `VACUUM`, `CREATE/DROP DATABASE` e `ALTER SYSTEM` nem cabem numa migration): a instrução vai **isolada numa migration própria**, sem `BEGIN`. O cabeçalho justifica a exceção e diz como recuperar a falha dela (um `CREATE INDEX CONCURRENTLY` falho deixa índice `INVALID`, que precisa ser removido antes de repetir).
   - **Backfill longo** vai numa migration transacional própria, separada do DDL que trava tabela. A separação já existia na `20261021090100_message_dispatch_ai_origin_backfill`, anterior à regra e sem `BEGIN`.
   - **Valor novo de enum** (`ALTER TYPE ... ADD VALUE`) não é exceção: roda em transação, mas só pode ser usado depois do `COMMIT`. Quem precisa usá-lo faz duas migrations transacionais, a do valor primeiro.
   - **Cabeçalho da migration:** o que ela faz, os locks que pede e a **estimativa** das esperas por lock (o `lock_timeout` limita cada espera, não a soma nem o tempo de execução), e "se falhar: `DEPLOY_STAGING` §4, nunca `rolled-back` às cegas".
5. **Aplique** com `prisma migrate dev` (aplica a migration já editada) e confira o resultado.
6. **Recuperação verificável, antes do commit** (ADR-051 §3 e adendo 1). A evidência corresponde ao que a migration muda:
   - **objetos novos:** o inventário (zero depois da falha, completo depois da aplicação);
   - **objetos existentes alterados:** as definições anteriores e finais. O bloco abaixo imprime a diferença entre os dois dumps, e ela precisa conter só o que a migration declara;
   - **migration de dados:** a conferência dos dados, com a base semeada e uma consulta cujo resultado esperado é escrito antes do ensaio (`SEMEIA`, `DADOS` e `DADOS_ESPERADO` no bloco). O dump só de schema não prova o rollback de um backfill. Coluna nova que a migration preenche entra também aqui: a consulta lê `to_jsonb(linha) ->> 'coluna'`, que vale antes e depois de a coluna existir, e a mesma consulta prova a falha (nada preenchido) e a aplicação (tudo preenchido). Foi assim na `20261022120000_clinics_returns`, com o `recordedAt`. "Inventário zero" só vale para objetos novos; sem objeto novo, `ESPERADO` é 0 e o inventário pode ser uma consulta vazia.

   - **Inventário:** escreva a consulta que lista cada objeto criado pela migration (tipo, tabela, coluna, índice, restrição com `contype <> 'n'`, função, gatilho), com a contagem esperada. Ela vai para o `DEPLOY_STAGING` §4, em "Falha de migration", como a da `20261021120000_clinics_packages`.
   - **Ensaie a falha forçada pelo mesmo `prisma migrate deploy`**, com o bloco abaixo, rodado da raiz do repositório depois de trocar os três valores. Ele tem travas:
     - o banco descartável tem **sempre** o prefixo `veyra_ensaio_` e é apagado no fim, mesmo em falha. Nunca use `veyra`, `veyra_test` nem `veyra_e2e`;
     - a cópia das migrations (com o `migration_lock.toml`) e a config do ensaio ficam num diretório temporário, **fora do repositório**;
     - todo comando do Prisma leva o `DATABASE_URL` do descartável e a `--config` do ensaio. A config padrão carrega o `.env` e apontaria para a `veyra`;
     - o bloco recusa a migration sem `BEGIN` e com mais ou menos de um `COMMIT` (ADR-051).

     O que ele prova:
     - a falha forçada antes do `COMMIT` faz o deploy falhar, com o `pg_dump --schema=public` **idêntico** ao de antes e o inventário em zero;
     - num banco novo, a aplicação limpa dá o inventário completo e o `migrate diff` vazio.

     **O bloco foi ensaiado**, com cada trava num teste por linha (com `set -e`, um teste no meio de `&&` não interrompe):
     - sobre a `20261021120000_clinics_packages`: "Ensaio OK";
     - interrompe com mensagem nos outros casos: valores sem trocar, migration sem `BEGIN`, migration com duas transações e inventário com SQL inválido (já no passo 1);
     - numa migration de dados sintética, numa cópia temporária do repositório: a falha deixou os dados intactos e a aplicação deu o esperado. Com o esperado errado, ou com só um de `DADOS` e `DADOS_ESPERADO`, interrompeu.

     Na falha, os logs aparecem antes de o diretório temporário ser apagado.

     ```bash
     (
     set -euo pipefail
     NOVA='<pasta da migration nova>'          # em apps/api/prisma/migrations
     INV='<arquivo com o inventário>'           # a consulta que vai para o DEPLOY_STAGING §4
     ESPERADO='<objetos que ela cria>'          # a contagem do inventário com ela aplicada (0 se não cria objeto)
     # migration de DADOS (backfill, correção): o dump só de schema não prova o rollback
     SEMEIA=''          # opcional: SQL que semeia a base com linhas representativas e FICTÍCIAS (nunca dado copiado de ambiente real)
     DADOS=''           # opcional: consulta de conferência dos dados (contagem, soma, md5)
     DADOS_ESPERADO=''  # opcional: a saída esperada da consulta depois da migration
     BASE="veyra_ensaio_$(date +%s)"            # SEMPRE com o prefixo veyra_ensaio_
     PG=postgresql://veyra:veyra_dev@localhost:5434   # o Postgres local de dev (container veyra-postgres)
     API=$(git rev-parse --show-toplevel)/apps/api
     M="$API/prisma/migrations/$NOVA/migration.sql"
     case "$BASE" in veyra_ensaio_*) ;; *) echo "banco do ensaio sem o prefixo veyra_ensaio_" >&2; exit 1 ;; esac
     # uma trava por linha: com `set -e`, um teste no meio de `&&` não interrompe
     pare() { echo "ENSAIO INTERROMPIDO: $*" >&2; exit 1; }
     [ -f "$M" ] || pare "migration não encontrada: $M"
     [ -f "$INV" ] || pare "inventário não encontrado: $INV"
     for f in "$SEMEIA" "$DADOS" "$DADOS_ESPERADO"; do [ -z "$f" ] || [ -f "$f" ] || pare "arquivo não encontrado: $f"; done
     # a conferência dos dados só vale inteira: a consulta E o resultado esperado
     if { [ -n "$DADOS" ] && [ -z "$DADOS_ESPERADO" ]; } || { [ -z "$DADOS" ] && [ -n "$DADOS_ESPERADO" ]; }; then
       pare "DADOS e DADOS_ESPERADO andam juntos"
     fi
     # a regra do ADR-051: transação explícita, exatamente um BEGIN e um COMMIT
     [ "$(grep -c '^BEGIN;$' "$M")" = 1 ] || pare "ADR-051: a migration precisa de exatamente um BEGIN;"
     [ "$(grep -c '^COMMIT;$' "$M")" = 1 ] || pare "ADR-051: a migration precisa de exatamente um COMMIT;"
     E=$(mktemp -d)
     # no fim, sempre: o banco descartável apagado. Na falha, os logs antes de sumirem
     trap 'st=$?; [ "$st" = 0 ] || tail -n 30 "$E"/*.log 2>/dev/null; rm -rf "$E"; docker exec veyra-postgres dropdb --if-exists -U veyra "$BASE"' EXIT
     psql_() { docker exec -i veyra-postgres psql -U veyra -X -q -At -v ON_ERROR_STOP=1 "$@"; }
     esquema() { docker exec veyra-postgres pg_dump -U veyra -d "$BASE" --schema=public --schema-only --no-owner --no-privileges | grep -vE '^--|^\\(un)?restrict' | sed '/^$/d'; }
     deploy() { (cd "$API" && DATABASE_URL="$PG/$BASE" npx prisma migrate deploy --config "$E/prisma.config.ts"); }
     inventario() { psql_ -d "$BASE" -f - < "$INV" | wc -l | tr -d ' '; }
     dados() { psql_ -d "$BASE" -f - < "$DADOS"; }
     semeia() { [ -z "$SEMEIA" ] || psql_ -d "$BASE" -f - < "$SEMEIA"; }
     # 1. a base: todas as migrations ANTES da nova, numa cópia fora do repositório
     mkdir -p "$E/migrations"; cp "$API/prisma/migrations/migration_lock.toml" "$E/migrations/"
     for d in "$API"/prisma/migrations/*/; do d=${d%/}; [ "${d##*/}" = "$NOVA" ] || cp -R "$d" "$E/migrations/"; done
     printf "export default { schema: '%s/prisma/schema', migrations: { path: '%s/migrations' }, datasource: { url: process.env.DATABASE_URL } };\n" "$API" "$E" > "$E/prisma.config.ts"
     docker exec veyra-postgres createdb -U veyra "$BASE"
     deploy > "$E/base.log" 2>&1
     semeia
     esquema > "$E/antes.sql"
     [ -z "$DADOS" ] || { dados > "$E/dados-antes.txt"; echo "dados antes: $(tr '\n' ' ' < "$E/dados-antes.txt")"; }
     n=$(inventario); [ "$n" = 0 ] || pare "antes da migration, o inventário deu $n (esperado 0)"
     # 2. a falha forçada antes do COMMIT: o deploy falha e NADA muda
     mkdir "$E/migrations/$NOVA"
     awk '/^COMMIT;$/ { print "DO $$ BEGIN RAISE EXCEPTION '\''falha forçada'\''; END $$;" } { print }' "$M" > "$E/migrations/$NOVA/migration.sql"
     if deploy > "$E/falha.log" 2>&1; then pare "a falha forçada NÃO falhou"; fi
     esquema > "$E/depois.sql"
     diff "$E/antes.sql" "$E/depois.sql" || pare "a falha deixou o schema diferente do de antes"
     n=$(inventario); [ "$n" = 0 ] || pare "depois da falha, o inventário deu $n (esperado 0)"
     if [ -n "$DADOS" ]; then dados > "$E/dados-falha.txt"; echo "dados depois da falha: $(tr '\n' ' ' < "$E/dados-falha.txt")"; diff "$E/dados-antes.txt" "$E/dados-falha.txt" || pare "a falha mudou os dados"; fi
     echo "falha forçada: schema intacto, inventário 0$([ -z "$DADOS" ] || echo ', dados intactos')"
     # 3. a aplicação limpa, num banco novo: a base (semeada), depois a nova
     docker exec veyra-postgres dropdb -U veyra "$BASE"; docker exec veyra-postgres createdb -U veyra "$BASE"
     rm -r "$E/migrations/$NOVA"; deploy > "$E/limpa-base.log" 2>&1; semeia
     mkdir "$E/migrations/$NOVA"; cp "$M" "$E/migrations/$NOVA/migration.sql"
     deploy > "$E/limpa.log" 2>&1
     n=$(inventario); [ "$n" = "$ESPERADO" ] || pare "aplicada, o inventário deu $n (esperado $ESPERADO)"
     if [ -n "$DADOS" ]; then dados > "$E/dados-depois.txt"; echo "dados depois da aplicação: $(tr '\n' ' ' < "$E/dados-depois.txt")"; diff "$DADOS_ESPERADO" "$E/dados-depois.txt" || pare "aplicada, os dados não deram o esperado"; fi
     # as definições que mudaram: o efeito INTEIRO da migration no schema, para conferir
     # que são só as declaradas (objetos existentes alterados aparecem aqui)
     esquema > "$E/aplicada.sql"
     echo "== mudanças de definição (antes → aplicada), confira que são só as declaradas:"
     diff "$E/antes.sql" "$E/aplicada.sql" || true
     (cd "$API" && DATABASE_URL="$PG/$BASE" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code --config "$E/prisma.config.ts") > "$E/diff.log"
     echo "aplicação limpa: inventário $ESPERADO e migrate diff vazio. Ensaio OK"
     )
     ```

   - Numa **exceção** do passo 4, ensaie a falha da própria instrução isolada e a recuperação escrita no cabeçalho, com as mesmas travas de nome e de `DATABASE_URL`.
7. **FKs compostas**: se a migration cria relação entre entidades de workspace, confirme que a FK é `(workspaceId, xId)`. Rode `check:fk` depois de aplicar.
8. **Nunca edite migration já aplicada** em ambiente compartilhado, nem migration **publicada** (enviada ao remoto), e nunca ajuste o checksum delas (ADR-051 §4). Errou? Nova migration corretiva.
9. **Commite a migration junto do código** que a usa, nunca separado, e o inventário no `DEPLOY_STAGING` §4 no mesmo commit.
10. **Teste**: a suíte de integração passa contra banco migrado do zero (`migrate deploy` em DB limpo).
11. Migration tocando tabelas de identidade/acesso (Workspace, User, Membership, Role, Permission) → revisão `security` + `reviewer` obrigatória.

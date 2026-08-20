/**
 * Auditoria de FKs cross-workspace (SECURITY.md §2, ADR-010) — genérica:
 * varre o catálogo do Postgres (pg_constraint, pares de colunas ORDENADOS)
 * em vez de manter lista fixa de relações.
 *
 * O QUE CHECA
 * -----------
 * Para toda tabela do schema `public` com coluna "workspaceId":
 *  1) SCHEMA/FK: toda FK para outra tabela com "workspaceId" deve incluir o par
 *     workspaceId→workspaceId (FK composta, ADR-010). FK sem o par = achado.
 *  2) DADOS: para FKs não-compostas, JOIN filho↔pai pelos pares reais da FK e
 *     lista linhas cujo workspaceId difere (só ids, nunca conteúdo).
 *  3) HEURÍSTICA: coluna `*Id` (exceto workspaceId) SEM nenhuma FK declarada =
 *     achado — relação "solta" é invisível ao banco e ao check de dados.
 *
 * FKs para tabelas globais (User, Permission) e para a raiz Workspace ficam
 * fora por definição.
 *
 * USO: pnpm --filter @veyra/api check:fk  (exit 0 limpo; exit 1 se achar algo)
 *
 * NOTA DE COBERTURA: em CI este check roda contra o banco de teste (valida o
 * SCHEMA; os dados foram truncados pelos testes). O scan de DADOS tem valor
 * real contra staging/produção — rode lá antes de qualquer consolidação.
 *
 * Cliente pg CRU de propósito: o filtro automático de workspace esconderia
 * exatamente o que queremos encontrar. Identificadores vêm do catálogo do
 * próprio Postgres e ainda assim são escapados (aspas duplicadas).
 */
import 'dotenv/config';
import { Client } from 'pg';

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/**
 * Exceções DOCUMENTADAS à heurística de coluna *Id sem FK (DOMAIN_MODEL §9,
 * ADR-011): polimórficos tenant-scoped NÃO-navegáveis por design — a limpeza é
 * responsabilidade do service dono da entidade (coberto por teste). Adicionar
 * aqui exige a mesma documentação no DOMAIN_MODEL e revisão de security.
 */
const DOCUMENTED_LOOSE_COLUMNS = new Set([
  // valor de campo personalizado: polimórfico tenant-scoped, não navegável;
  // limpeza no service dono da entidade (DOMAIN_MODEL §9, testado)
  'CustomFieldValue.entityId',
  // AuditLog é a trilha: por definição SOBREVIVE ao registro auditado (uma FK
  // apagaria a prova junto com o dado). SECURITY.md §5.
  'AuditLog.entityId',
  // origem NÃO-usuária do evento (id de API key, nome de job, AiRun) — texto
  // livre por natureza; o ator usuário usa actorMembershipId, que TEM FK composta
  'AuditLog.actorId',
  // correlação de request (uuid/observabilidade), não referência a entidade
  'AuditLog.requestId',
  // id da mensagem NO PROVEDOR externo (Message-ID de e-mail, wamid do
  // WhatsApp): opaco, de outro sistema, sem tabela local para referenciar.
  // A integridade que importa aqui é o unique de dedup por canal
  // (workspaceId, channelId, externalId), que existe. ADR-023.
  'Message.externalId',
  // identificadores DO PROVEDOR (Meta), não referências locais: número,
  // conta business e id da mensagem enviada (wamid). Não há tabela nossa para
  // referenciar; a integridade que importa é o unique de roteamento
  // (phoneNumberId) e o unique de dedupe do dispatch. ADR-037/039.
  'ChannelCredential.phoneNumberId',
  'ChannelCredential.businessAccountId',
  'MessageDispatch.externalId',
]);

interface FkRow {
  constraint_name: string;
  child_table: string;
  parent_table: string;
  /** pares ordenados coluna-filha → coluna-pai, na ordem da constraint */
  child_columns: string[];
  parent_columns: string[];
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não definida.');
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  let dirty = false;

  try {
    // pg_constraint com generate_subscripts preserva a ORDEM posicional dos
    // pares (conkey[i] ↔ confkey[i]) — information_schema a perderia.
    const { rows: fks } = await client.query<FkRow>(`
      SELECT
        con.conname AS constraint_name,
        child.relname AS child_table,
        parent.relname AS parent_table,
        array_agg(ca.attname::text ORDER BY s.i) AS child_columns,
        array_agg(pa.attname::text ORDER BY s.i) AS parent_columns
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace ns ON ns.oid = child.relnamespace
      CROSS JOIN LATERAL generate_subscripts(con.conkey, 1) AS s(i)
      JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[s.i]
      JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[s.i]
      WHERE con.contype = 'f' AND ns.nspname = 'public'
      GROUP BY con.conname, child.relname, parent.relname
    `);

    const { rows: wsTables } = await client.query<{ table_name: string }>(`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'workspaceId'
    `);
    const workspaceTables = new Set(wsTables.map((r) => r.table_name));

    // (1)+(2) — FKs entre tabelas de workspace
    for (const fk of fks) {
      if (fk.parent_table === 'Workspace') continue; // ancoragem no tenant raiz — ok
      if (!workspaceTables.has(fk.child_table) || !workspaceTables.has(fk.parent_table)) {
        continue; // envolve tabela global — fora do escopo
      }

      const pairIndex = fk.child_columns.findIndex(
        (c, i) => c === 'workspaceId' && fk.parent_columns[i] === 'workspaceId',
      );
      if (pairIndex >= 0) {
        console.log(`ok (composta): ${fk.constraint_name}`);
        continue;
      }

      dirty = true;
      console.error(
        `SCHEMA: ${fk.constraint_name} (${fk.child_table} → ${fk.parent_table}) sem o par ` +
          `workspaceId→workspaceId — FK deveria ser composta (ADR-010).`,
      );

      // checagem de dados pelos pares REAIS da FK, na ordem da constraint
      const joinOn = fk.child_columns
        .map((c, i) => `c.${q(c)} = p.${q(fk.parent_columns[i])}`)
        .join(' AND ');
      const { rows } = await client.query(
        `SELECT c."id"::text AS child_id
           FROM ${q(fk.child_table)} c
           JOIN ${q(fk.parent_table)} p ON ${joinOn}
          WHERE c."workspaceId" <> p."workspaceId"
          LIMIT 20`,
      );
      for (const row of rows) {
        console.error(`  DADO cross-workspace: ${fk.child_table}.id=${row.child_id}`);
      }
    }

    // (3) — colunas *Id "soltas" (sem FK): invisíveis a qualquer check de banco
    const fkColumnsByTable = new Map<string, Set<string>>();
    for (const fk of fks) {
      const set = fkColumnsByTable.get(fk.child_table) ?? new Set<string>();
      for (const c of fk.child_columns) set.add(c);
      fkColumnsByTable.set(fk.child_table, set);
    }
    for (const table of workspaceTables) {
      const { rows: cols } = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name LIKE '%Id'`,
        [table],
      );
      for (const { column_name } of cols) {
        if (column_name === 'workspaceId') continue;
        if (!fkColumnsByTable.get(table)?.has(column_name)) {
          if (DOCUMENTED_LOOSE_COLUMNS.has(`${table}.${column_name}`)) {
            console.log(`ok (exceção documentada, ADR-011): ${table}.${column_name}`);
            continue;
          }
          dirty = true;
          console.error(
            `SCHEMA: ${table}.${column_name} parece FK mas não tem constraint — relação solta ` +
              `sem integridade (declare a FK, composta se o alvo for tabela de workspace).`,
          );
        }
      }
    }
  } finally {
    await client.end();
  }

  if (dirty) {
    console.error('\ncheck:fk SUJO — corrija antes de prosseguir (P0).');
    process.exit(1);
  }
  console.log('\ncheck:fk limpo.');
}

main().catch((error) => {
  console.error('check:fk falhou:', error);
  process.exit(1);
});

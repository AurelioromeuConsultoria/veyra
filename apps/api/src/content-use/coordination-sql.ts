import { Prisma } from '../generated/prisma/client';

/**
 * Os ÚNICOS modelos de SQL cru que o client protegido (`prisma.db`) aceita
 * (ADR-047 adendos 6 e 7; exceção ao §3.3 do CLAUDE.md, "coordenação de
 * restrição"). A coordenação precisa rodar NA transação de quem muda a
 * restrição ou usa o conteúdo — e essas transações são do client protegido.
 *
 * A liberação é pelo TEXTO do modelo (as `strings` do `Prisma.sql`), nunca pelo
 * valor: chaves e prazos vão sempre como parâmetros. Nenhum modelo lê nem
 * escreve dado de tenant (a lápide do uso passa pelo client filtrado). Um teste
 * estático fixa esta lista: mexer nela é decisão de segurança. O que vai ao
 * banco é RECONSTRUÍDO do modelo (`sqlDeCoordenacao`), nunca o objeto recebido.
 */
export const COORDENACAO = {
  travaCompartilhada: (chave: string) =>
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${chave}, 0))`,
  travaExclusiva: (chave: string) =>
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${chave}, 0))`,
  tentarTravaExclusiva: (chave: string) =>
    Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${chave}, 0)) AS obtida`,
  prazoDeTrava: (ms: string) => Prisma.sql`SELECT set_config('lock_timeout', ${ms}, true)`,
  prazoOcioso: (ms: string) =>
    Prisma.sql`SELECT set_config('idle_in_transaction_session_timeout', ${ms}, true)`,
  prazoDeInstrucao: (ms: string) => Prisma.sql`SELECT set_config('statement_timeout', ${ms}, true)`,
  pidDaSessao: () => Prisma.sql`SELECT pg_backend_pid() AS pid`,
  provaDeVida: () => Prisma.sql`SELECT 1 AS vivo`,
  savepoint: () => Prisma.sql`SAVEPOINT veyra_persistencia`,
  voltarAoSavepoint: () => Prisma.sql`ROLLBACK TO SAVEPOINT veyra_persistencia`,
} as const;

/** A chave de um modelo: suas partes de texto, inteiras e na ordem, sem os valores. */
function chaveDoModelo(strings: readonly string[]): string {
  return JSON.stringify(strings);
}

const MODELOS_LIBERADOS: ReadonlySet<string> = new Set(
  [
    COORDENACAO.travaCompartilhada('x'),
    COORDENACAO.travaExclusiva('x'),
    COORDENACAO.tentarTravaExclusiva('x'),
    COORDENACAO.prazoDeTrava('0'),
    COORDENACAO.prazoOcioso('0'),
    COORDENACAO.prazoDeInstrucao('0'),
    COORDENACAO.pidDaSessao(),
    COORDENACAO.provaDeVida(),
    COORDENACAO.savepoint(),
    COORDENACAO.voltarAoSavepoint(),
  ].map((sql) => chaveDoModelo(sql.strings)),
);

/**
 * O SQL cru recebido pelo hook do client protegido é um modelo de coordenação?
 * O hook recebe um objeto novo `{ strings, values }` (não o `Prisma.sql`
 * original), então a conferência é pelo texto. Os valores são só parâmetros
 * simples, um por lacuna: um `Prisma.Sql` como valor seria emendado no texto.
 */
export function ehSqlDeCoordenacao(args: unknown): boolean {
  const { strings, values } = (args ?? {}) as { strings?: unknown; values?: unknown };
  return (
    Array.isArray(strings) &&
    strings.every((s) => typeof s === 'string') &&
    MODELOS_LIBERADOS.has(chaveDoModelo(strings as string[])) &&
    Array.isArray(values) &&
    values.length === strings.length - 1 &&
    values.every((v) => typeof v === 'string' || typeof v === 'number')
  );
}

/**
 * O SQL que vai ao banco, RECONSTRUÍDO do modelo, ou `null` se não for um. O
 * Prisma executa o `text` do objeto que recebe; um objeto forjado poderia trazer
 * as `strings` de um modelo e o `text` de outro SQL. A reconstrução descarta
 * tudo que não sejam as partes de texto conferidas e os parâmetros.
 */
export function sqlDeCoordenacao(args: unknown): Prisma.Sql | null {
  if (!ehSqlDeCoordenacao(args)) return null;
  const { strings, values } = args as { strings: string[]; values: (string | number)[] };
  return new Prisma.Sql([...strings], [...values]);
}

/** Para o teste estático: o texto de cada modelo liberado. */
export function modelosLiberados(): string[] {
  return [...MODELOS_LIBERADOS];
}

import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Relógio do Node DESLOCADO em relação ao banco, só durante `corpo` (ADR-049).
 * A falha intermitente da integração era exatamente isto: a VM do Docker
 * atrasada sob carga, com o Node 19 s à frente do Postgres. Aqui o desvio é
 * artificial e determinístico: `new Date()` e `Date.now()` do processo andam
 * `desvioMs` à frente (positivo) ou atrás (negativo); o banco não muda.
 *
 * Datas criadas com argumentos (`new Date(x)`) e `Date.parse`/`Date.UTC` não
 * mudam; as instâncias continuam `instanceof Date`.
 */
/** O `Date` do processo, guardado na carga do módulo: o real. */
const DATA_REAL = Date;

/** Devolve o `Date` real — para o `afterEach` de quem usa o desvio. */
export function restaurarRelogioDoNode(): void {
  globalThis.Date = DATA_REAL;
}

export async function comRelogioDoNode<T>(desvioMs: number, corpo: () => Promise<T>): Promise<T> {
  const DataReal = DATA_REAL;
  function DataDeslocada(...args: unknown[]): Date | string {
    if (!new.target) return new DataReal(DataReal.now() + desvioMs).toString();
    return args.length === 0
      ? new DataReal(DataReal.now() + desvioMs)
      : (Reflect.construct(DataReal, args) as Date);
  }
  DataDeslocada.prototype = DataReal.prototype;
  Object.setPrototypeOf(DataDeslocada, DataReal);
  (DataDeslocada as unknown as { now: () => number }).now = () => DataReal.now() + desvioMs;
  globalThis.Date = DataDeslocada as unknown as DateConstructor;
  try {
    return await corpo();
  } finally {
    globalThis.Date = DataReal;
  }
}

/** Agora, pelo relógio do BANCO (ms desde a época) — para testes que comparam com ele. */
export async function agoraNoBanco(prisma: PrismaService): Promise<number> {
  const [{ ms }] = await prisma.raw.$queryRawUnsafe<{ ms: string }[]>(
    `SELECT (extract(epoch from clock_timestamp()) * 1000)::bigint::text AS ms`,
  );
  return Number(ms);
}

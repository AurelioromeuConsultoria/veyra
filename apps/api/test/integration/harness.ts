import type { ClsService } from 'nestjs-cls';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * ClsService falso: o PrismaService só lê `cls.get('workspaceId')` (lazy,
 * dentro do hook de query), então um Map controlável simula o contexto de
 * workspace por request nos testes.
 */
export class FakeCls {
  private readonly store = new Map<string, unknown>();
  get<T = unknown>(key: string): T {
    return this.store.get(key) as T;
  }
  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }
}

export function createPrisma(cls: FakeCls = new FakeCls()): {
  prisma: PrismaService;
  cls: FakeCls;
} {
  const prisma = new PrismaService(cls as unknown as ClsService);
  return { prisma, cls };
}

/** Trunca todas as tabelas de domínio (preserva o histórico de migrations). */
export async function resetDb(prisma: PrismaService): Promise<void> {
  // Guarda NA FUNÇÃO que causa o dano (não só na configuração): se um arquivo
  // de teste escapar do runner de integração, o TRUNCATE ainda se recusa a
  // rodar fora de um banco cujo nome contenha "test".
  const [{ current_database }] = await prisma.raw.$queryRawUnsafe<{ current_database: string }[]>(
    'SELECT current_database()',
  );
  if (!current_database.includes('test')) {
    throw new Error(
      `resetDb recusado: banco atual é "${current_database}" (o nome precisa conter "test").`,
    );
  }
  const rows = await prisma.raw.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename.replace(/"/g, '""')}"`).join(', ');
  await prisma.raw.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

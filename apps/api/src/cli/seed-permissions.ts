/**
 * Semeia o catálogo GLOBAL de permissões (idempotente).
 *
 * Vive em `src/cli` — e não só em `prisma/seed.ts` — porque a imagem de
 * produção carrega apenas `dist`: sem isto, um ambiente novo não consegue
 * semear o catálogo, e o provisionamento falha na FK de `RolePermission`
 * com uma mensagem que não explica nada.
 *
 * `prisma/seed.ts` passou a chamar esta mesma função: uma implementação, dois
 * pontos de entrada (o de desenvolvimento por tsx, o de produção compilado).
 */
import 'dotenv/config';
import { PERMISSION_CATALOG } from '@veyra/contracts';
import { PrismaClient } from '../generated/prisma/client';
import { prismaAdapter } from '../prisma/prisma-adapter';

export async function seedPermissions(): Promise<number> {
  const prisma = new PrismaClient({
    // Prisma 7 exige adapter explícito; sem ele o cliente nem instancia
    adapter: prismaAdapter(process.env.DATABASE_URL),
  });
  try {
    for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
      await prisma.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      });
    }
    return prisma.permission.count();
  } finally {
    await prisma.$disconnect();
  }
}

// executado diretamente (`node dist/cli/seed-permissions.js`)
if (require.main === module) {
  seedPermissions()
    .then((total) => {
      console.log(`Seed ok: ${total} permissões no catálogo.`);
    })
    .catch((error: unknown) => {
      console.error('Seed falhou:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

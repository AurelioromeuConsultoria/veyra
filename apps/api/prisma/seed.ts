/**
 * Seed do catálogo GLOBAL de permissões (idempotente: upsert por chave).
 * Roles de sistema NÃO são semeados aqui — são criados POR WORKSPACE no
 * provisionamento (Entrega 2), a partir de SYSTEM_ROLE_TEMPLATES.
 *
 * PrismaClient cru: Permission é catálogo global fora do filtro de workspace
 * (exceção documentada em SECURITY.md §2 e workspace-models.ts).
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PERMISSION_CATALOG } from '@veyra/contracts';
import { PrismaClient } from '../src/generated/prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg(process.env.DATABASE_URL as string),
  });
  try {
    for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
      await prisma.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      });
    }
    const total = await prisma.permission.count();
    console.log(`Seed ok: ${total} permissões no catálogo.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Seed falhou:', error);
  process.exit(1);
});

/**
 * Entrada de DESENVOLVIMENTO do seed (`pnpm prisma:seed`, via tsx).
 *
 * A implementação mora em `src/cli/seed-permissions.ts` para viajar na imagem
 * de produção, que só carrega `dist`. Duas cópias da mesma lógica divergiriam
 * na primeira permissão nova.
 */
import { seedPermissions } from '../src/cli/seed-permissions';

seedPermissions()
  .then((total) => {
    console.log(`Seed ok: ${total} permissões no catálogo.`);
  })
  .catch((error: unknown) => {
    console.error('Seed falhou:', error instanceof Error ? error.message : error);
    process.exit(1);
  });

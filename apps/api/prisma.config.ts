import 'dotenv/config';
import { defineConfig } from '@prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // process.env em vez de env() do Prisma: `prisma generate` (build/CI) não
    // conecta ao banco e não deve exigir DATABASE_URL. Em migrate/deploy a
    // variável está definida e é resolvida normalmente.
    url: process.env.DATABASE_URL ?? '',
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});

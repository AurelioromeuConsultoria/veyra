/**
 * globalSetup (roda uma vez): garante que o database de teste existe e aplica
 * as migrations. Não toca no dev — a URL é validada por assertIsTestDb().
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { TEST_DATABASE_URL, assertIsTestDb } from './db-url';

export default async function globalSetup(): Promise<void> {
  const dbName = assertIsTestDb();
  if (!/^[a-z0-9_]+$/i.test(dbName)) {
    throw new Error(`Nome de database inválido para CREATE DATABASE: "${dbName}"`);
  }

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  const apiRoot = path.resolve(__dirname, '../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'inherit',
  });
}

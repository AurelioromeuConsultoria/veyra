/**
 * Antes da API principal do E2E: o banco precisa EXISTIR, porque ela lê a trava
 * de manutenção na subida (ADR-053, adendo 1) e não sobe sem ele. O Playwright
 * sobe os servidores antes do setup global, que recria o banco depois; aqui só
 * se cria o que falta, sem apagar nada. Dados fictícios; nenhum outro ambiente.
 */
import { Client } from 'pg';
import { conferirBanco } from './semeadura';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('E2E: sem DATABASE_URL para a API principal.');
  const nome = conferirBanco(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nome]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${nome}"`);
  } finally {
    await admin.end();
  }
}

main().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});

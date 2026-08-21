import { Client } from 'pg';
import { expect, type Page } from '@playwright/test';
import { assertIsE2eDb, E2E_DATABASE_URL, E2E_PASSWORD } from '../env';

/** Login pela UI (o caminho do usuário, não atalho de API). */
export async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Contatos' })).toBeVisible();
}

/**
 * Conexão de teste com a TRAVA na própria função: o `assertIsE2eDb` do
 * global-setup só protege quem passa por lá, e um spec que abre a conexão
 * direto ficaria sem defesa se a URL apontasse para outro banco.
 */
export async function openE2eDb(): Promise<Client> {
  // `assertIsE2eDb` devolve o NOME do banco (e lança se não contiver "e2e"):
  // chamar por causa da trava, conectar com a URL
  assertIsE2eDb();
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  return db;
}

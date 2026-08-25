import { Client } from 'pg';
import { expect, type Page } from '@playwright/test';
import { assertIsE2eDb, E2E_DATABASE_URL, E2E_PASSWORD } from '../env';

/**
 * Login pela UI (o caminho do usuário, não atalho de API).
 *
 * O destino do login passou a ser a visão executiva "Hoje" — antes era
 * `/contacts`, e o helper assertava o heading "Contatos". Quem PRECISA cair
 * numa seção específica pede por ela: o helper navega pelo mesmo link da barra
 * lateral que a pessoa usaria, em vez de fingir que o produto abre ali.
 */
export async function login(page: Page, email: string, secao?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
  if (secao) {
    await page.getByRole('link', { name: secao, exact: true }).click();
    await expect(page.getByRole('heading', { name: secao, level: 1 })).toBeVisible();
  }
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

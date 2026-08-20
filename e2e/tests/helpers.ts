import { expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from '../env';

/** Login pela UI (o caminho do usuário, não atalho de API). */
export async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Contatos' })).toBeVisible();
}

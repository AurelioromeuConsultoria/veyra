import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

test.describe('Auth (UI)', () => {
  test('login inválido mostra erro único; login válido entra no workspace', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(OWNER_A);
    await page.getByLabel('Senha').fill('senha-completamente-errada');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('Credenciais inválidas');

    await login(page, OWNER_A);
    await expect(page.getByText('ACME', { exact: true })).toBeVisible(); // workspace na sidebar
  });

  test('rota protegida sem sessão redireciona para /login; sair encerra a sessão', async ({
    page,
  }) => {
    await page.goto('/contacts');
    await expect(page).toHaveURL(/\/login/);

    await login(page, OWNER_A);
    await page.getByRole('button', { name: 'Sair' }).click();
    await expect(page).toHaveURL(/\/login/);
    // a sessão morreu de verdade: voltar à rota protegida não entra
    await page.goto('/contacts');
    await expect(page).toHaveURL(/\/login/);
  });
});

import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

test.describe('Uso e plano (UI)', () => {
  test('mostra plano vigente, consumo e a natureza de cada métrica', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Uso e plano' }).click();

    await expect(page.getByRole('heading', { name: 'Uso e plano' })).toBeVisible();
    await expect(page.getByText(/Plano Base/)).toBeVisible();

    // gauge diz que cai ao arquivar; counter diz quando zera
    await expect(page.getByText('Contatos ativos')).toBeVisible();
    await expect(page.getByText(/cai ao arquivar ou excluir/).first()).toBeVisible();
    await expect(page.getByText('Execuções de IA')).toBeVisible();
    await expect(page.getByText(/zera em/).first()).toBeVisible();

    // a métrica declarada mas não cobrada aparece marcada como tal
    await expect(page.getByText('Mensagens enviadas')).toBeVisible();
    await expect(page.getByText('não cobrada').first()).toBeVisible();
  });

  test('criar contato move o medidor de contatos', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Uso e plano' }).click();
    const usados = () => page.getByTestId('usage-contacts-used');
    const antes = Number((await usados().textContent()) ?? '0');

    await page.getByRole('link', { name: 'Contatos' }).click();
    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill(`Medidor ${Date.now()}`);
    await page.getByRole('button', { name: 'Salvar' }).click();

    await page.getByRole('link', { name: 'Uso e plano' }).click();
    const depois = Number((await usados().textContent()) ?? '0');
    expect(depois).toBe(antes + 1);
  });
});

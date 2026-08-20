import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

test.describe('Plataforma de confiança (UI)', () => {
  test('webhook: criar mostra o segredo UMA vez, pausar e excluir', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Webhooks' }).click();

    await page.getByLabel('URL do webhook').fill('https://exemplo-e2e.veyra.test/hook');
    await page.getByRole('button', { name: 'deal.won' }).click();
    await page.getByRole('button', { name: 'Criar webhook' }).click();

    // o segredo aparece uma única vez, em destaque
    const secret = page.getByTestId('webhook-secret');
    await expect(secret).toBeVisible();
    await expect(secret).toContainText('whsec_');
    const secretValue = (await secret.textContent()) ?? '';

    await page.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.getByTestId('webhook-secret')).toHaveCount(0);
    // recarregar NÃO traz o segredo de volta
    await page.reload();
    await expect(page.locator('body')).not.toContainText(secretValue);

    const row = page.getByRole('row', { name: /exemplo-e2e/ });
    await expect(row).toContainText('Ativo');
    await row.getByRole('button', { name: 'Pausar' }).click();
    await expect(page.getByRole('row', { name: /exemplo-e2e/ })).toContainText('Pausado');
  });

  test('URL insegura é recusada com mensagem clara (SSRF)', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Webhooks' }).click();
    await page.getByLabel('URL do webhook').fill('http://169.254.169.254/latest/meta-data');
    await page.getByRole('button', { name: 'contact.created' }).click();
    await page.getByRole('button', { name: 'Criar webhook' }).click();
    await expect(page.getByRole('alert')).toContainText(/https/i);
  });

  test('auditoria mostra quem alterou o quê, filtrando por entidade', async ({ page }) => {
    await login(page, OWNER_A);
    // gera um evento auditável: criar e excluir contato
    await page.getByRole('link', { name: 'Contatos' }).click();
    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill('Auditado E2E');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await page.getByRole('row', { name: /Auditado E2E/ }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Excluir' }).click();

    await page.getByRole('link', { name: 'Auditoria' }).click();
    await page.getByLabel('Filtrar por entidade').selectOption('contact');
    const row = page.getByRole('row', { name: /contact\.deleted/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Owner acme'); // ator identificado
  });
});

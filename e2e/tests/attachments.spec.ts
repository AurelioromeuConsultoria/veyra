import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

/** PNG mínimo válido (assinatura + bytes) montado no browser. */
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];

test.describe('Anexos (UI)', () => {
  test('anexa arquivo à mensagem e o link de download aparece na thread', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Inbox' }).click();

    const assunto = `Com anexo ${Date.now()}`;
    await page.getByLabel('Assunto da nova conversa').fill(assunto);
    await page.getByRole('button', { name: 'Criar conversa' }).click();
    await expect(page.getByRole('heading', { name: assunto })).toBeVisible();

    await page.getByLabel('Anexar arquivo').setInputFiles({
      name: 'relatorio.png',
      mimeType: 'image/png',
      buffer: Buffer.from(PNG_BYTES),
    });
    await expect(page.getByText('relatorio.png')).toBeVisible();

    await page.getByLabel('Corpo da mensagem').fill('Segue o relatório.');
    await page.getByRole('button', { name: 'Enviada' }).click();

    const link = page.getByRole('link', { name: /relatorio\.png/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', /\/api\/files\/[0-9a-f-]{36}\/content/);
  });

  test('extensão que diverge do conteúdo é recusada com mensagem clara', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Inbox' }).click();

    const assunto = `Anexo invalido ${Date.now()}`;
    await page.getByLabel('Assunto da nova conversa').fill(assunto);
    await page.getByRole('button', { name: 'Criar conversa' }).click();
    await expect(page.getByRole('heading', { name: assunto })).toBeVisible();

    // bytes de PNG com nome .pdf: a política do §7.1 barra no servidor
    await page.getByLabel('Anexar arquivo').setInputFiles({
      name: 'disfarcado.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(PNG_BYTES),
    });
    await expect(page.getByRole('alert')).toContainText(/não corresponde ao conteúdo/i);
    await expect(page.getByText('disfarcado.pdf')).toHaveCount(0);
  });
});

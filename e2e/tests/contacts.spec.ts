import { expect, test } from '@playwright/test';
import { OWNER_A, OWNER_B } from '../env';
import { login } from './helpers';

test.describe('Contatos (UI)', () => {
  test('criar contato pela UI, ver na tabela densa e buscar', async ({ page }) => {
    await login(page, OWNER_A);

    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill('Ana Prospect E2E');
    await page.getByLabel('E-mail').fill('ana@e2e.veyra');
    await page.getByRole('button', { name: 'Salvar' }).click();

    const row = page.getByRole('row', { name: /Ana Prospect E2E/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('ana@e2e.veyra');

    // busca server-side filtra
    await page.getByLabel('Buscar contatos').fill('inexistente-xyz');
    await expect(page.getByText('Nenhum contato para esta busca.')).toBeVisible();
    await page.getByLabel('Buscar contatos').fill('Ana');
    await expect(page.getByRole('row', { name: /Ana Prospect E2E/ })).toBeVisible();
  });

  test('CRITÉRIO DA ENTREGA: workspace B não vê os contatos do workspace A', async ({
    browser,
  }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await login(pageA, OWNER_A);
    await pageA.getByRole('button', { name: 'Novo contato' }).click();
    await pageA.getByLabel('Nome').fill('Segredo do A');
    await pageA.getByRole('button', { name: 'Salvar' }).click();
    await expect(pageA.getByRole('row', { name: /Segredo do A/ })).toBeVisible();
    await contextA.close();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await login(pageB, OWNER_B);
    await expect(pageB.getByText('BETA', { exact: true })).toBeVisible();
    await expect(pageB.getByText(/Segredo do A/)).toHaveCount(0);
    await contextB.close();
  });

  test('import básico por CSV pela UI (critério da entrega)', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByLabel('Arquivo CSV').setInputFiles({
      name: 'contatos.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        'nome,email,telefone\nCSV Um,csv1@e2e.veyra,\nCSV Dois,,+55 11 90000-0000\n',
      ),
    });
    await expect(page.getByText('2 contatos importados')).toBeVisible();
    await expect(page.getByRole('row', { name: /CSV Um/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /CSV Dois/ })).toBeVisible();
  });

  test('editar e arquivar contato pelo drawer', async ({ page }) => {
    await login(page, OWNER_A);
    const row = page.getByRole('row', { name: /Ana Prospect E2E/ });
    await row.click();
    await page.getByLabel('Nome').fill('Ana Prospect Editada');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('row', { name: /Ana Prospect Editada/ })).toBeVisible();

    await page.getByRole('row', { name: /Ana Prospect Editada/ }).click();
    await page.getByRole('button', { name: 'Arquivar' }).click();
    await expect(page.getByRole('row', { name: /Ana Prospect Editada/ })).toHaveCount(0);
    // filtro de arquivados encontra
    await page.getByLabel('Filtrar por status').selectOption('archived');
    await expect(page.getByRole('row', { name: /Ana Prospect Editada/ })).toBeVisible();
  });
});

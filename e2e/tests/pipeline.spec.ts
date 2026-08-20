import { expect, test } from '@playwright/test';
import { OWNER_A, OWNER_B } from '../env';
import { login } from './helpers';

test.describe('Pipeline (UI)', () => {
  test('criar oportunidade e mover PELO TECLADO atualiza coluna, soma e timeline', async ({
    page,
  }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Pipeline' }).click();

    await page.getByRole('button', { name: 'Nova oportunidade' }).click();
    await page.getByLabel('Título').fill('Proposta E2E');
    await page.getByLabel('Valor (R$)').fill('1500');
    await page.getByRole('button', { name: 'Salvar' }).click();

    const novo = page.getByRole('region', { name: 'Novo' });
    const qualificado = page.getByRole('region', { name: 'Qualificado' });
    const card = page.getByRole('article', { name: /Proposta E2E/ });
    await expect(card).toBeVisible();
    await expect(novo).toContainText('R$ 1.500,00');

    // CRITÉRIO DO ROADMAP: kanban usável por teclado — foco + "]" move adiante
    await card.focus();
    await page.keyboard.press(']');
    await expect(qualificado.getByRole('article', { name: /Proposta E2E/ })).toBeVisible();
    await expect(qualificado).toContainText('R$ 1.500,00');
    await expect(novo).toContainText('R$ 0,00');

    // a timeline do deal registrou a mudança de estágio
    await qualificado.getByRole('article', { name: /Proposta E2E/ }).click();
    await expect(page.getByText('moveu de Novo para Qualificado')).toBeVisible();
  });

  test('workspace B não vê o board de A', async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await login(pageA, OWNER_A);
    await pageA.getByRole('link', { name: 'Pipeline' }).click();
    await pageA.getByRole('button', { name: 'Nova oportunidade' }).click();
    await pageA.getByLabel('Título').fill('Sigilo do A');
    await pageA.getByRole('button', { name: 'Salvar' }).click();
    await expect(pageA.getByRole('article', { name: /Sigilo do A/ })).toBeVisible();
    await contextA.close();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await login(pageB, OWNER_B);
    await pageB.getByRole('link', { name: 'Pipeline' }).click();
    await expect(pageB.getByRole('region', { name: 'Novo' })).toBeVisible();
    await expect(pageB.getByText(/Sigilo do A/)).toHaveCount(0);
    await contextB.close();
  });

  test('tarefa criada aparece na lista e conclui', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Tarefas' }).click();
    await page.getByLabel('Título da nova tarefa').fill('Follow-up E2E');
    await page.getByRole('button', { name: 'Adicionar' }).click();

    const item = page.getByText('Follow-up E2E');
    await expect(item).toBeVisible();
    // click (não check): ao concluir, o item sai da lista de abertas e o
    // Playwright não conseguiria confirmar o estado final do checkbox
    await page.getByLabel('Concluir Follow-up E2E').click();
    // sai da lista de abertas
    await expect(page.getByText('Follow-up E2E')).toHaveCount(0);
    await page.getByLabel('Filtrar tarefas').selectOption('done');
    await expect(page.getByText('Follow-up E2E')).toBeVisible();
  });
});

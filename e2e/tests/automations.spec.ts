import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

/**
 * O EFEITO ("contato criado → tarefa de follow-up") é verificado no teste de
 * integração, que pode acionar o dispatcher do outbox diretamente. Aqui cobrimos
 * a jornada de configuração — deliberadamente sem abrir um endpoint de dispatch
 * só para teste, que seria superfície nova no produto para conveniência da suíte.
 */
test.describe('Automações (UI)', () => {
  test('configurar, revisar e desativar uma automação', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Automações' }).click();

    const nome = `Follow-up ${Date.now()}`;
    await page.getByLabel('Nome da automação').fill(nome);
    await page.getByLabel('Gatilho').selectOption('contact.created');
    await page.getByLabel('Título da tarefa').fill('Ligar para {{name}}');
    await page.getByLabel('Prazo em dias').fill('2');
    await page.getByRole('button', { name: 'Criar' }).click();

    // a regra aparece em linguagem de negócio, não em JSON
    const linha = page.getByRole('listitem').filter({ hasText: nome });
    await expect(linha).toBeVisible();
    await expect(linha).toContainText('Contato criado → criar “Ligar para {{name}}” em 2 dia(s)');

    // desativar e reativar sem perder a configuração
    await linha.getByRole('button', { name: 'Desativar' }).click();
    await expect(linha.getByRole('button', { name: 'Ativar' })).toBeVisible();
    await page.reload();
    const recarregada = page.getByRole('listitem').filter({ hasText: nome });
    await expect(recarregada.getByRole('button', { name: 'Ativar' })).toBeVisible();
    await recarregada.getByRole('button', { name: 'Ativar' }).click();
    await expect(recarregada.getByRole('button', { name: 'Desativar' })).toBeVisible();

    await recarregada.getByRole('button', { name: `Excluir ${nome}` }).click();
    await expect(page.getByRole('listitem').filter({ hasText: nome })).toHaveCount(0);
  });

  test('o gatilho é um catálogo fechado — não há campo livre', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Automações' }).click();
    // a rota é lazy: espera o formulário existir antes de inspecioná-lo
    const gatilho = page.getByLabel('Gatilho');
    await expect(gatilho).toBeVisible();
    const opcoes = await gatilho.locator('option').allTextContents();
    expect(opcoes).toEqual([
      'Contato criado',
      'Oportunidade criada',
      'Oportunidade ganha',
      'Oportunidade perdida',
      'Tarefa criada',
      'Tarefa concluída',
    ]);
  });
});

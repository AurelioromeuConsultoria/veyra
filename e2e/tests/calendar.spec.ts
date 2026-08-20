import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

test.describe('Agenda e notificações (UI)', () => {
  test('agendar evento na semana e removê-lo', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Agenda' }).click();

    const titulo = `Reunião ${Date.now()}`;
    await page.getByLabel('Título do evento').fill(titulo);
    await page.getByLabel('Duração em minutos').fill('45');
    await page.getByRole('button', { name: 'Agendar' }).click();

    const evento = page.getByText(titulo);
    await expect(evento).toBeVisible();

    // o evento fica na semana atual; navegar para a próxima o esconde
    await page.getByRole('button', { name: 'Próxima semana' }).click();
    await expect(page.getByText(titulo)).toHaveCount(0);
    await page.getByRole('button', { name: 'Hoje' }).click();
    await expect(page.getByText(titulo)).toBeVisible();

    await page.getByRole('button', { name: `Excluir ${titulo}` }).click();
    await expect(page.getByText(titulo)).toHaveCount(0);
  });

  test('o formulário não CONSEGUE criar janela invertida (duração mínima)', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Agenda' }).click();
    await page.getByLabel('Título do evento').fill('Janela inválida');
    // duração 0 produziria endAt = startAt, que o contrato e o CHECK recusam;
    // a validação nativa do campo barra antes de a requisição sair
    await page.getByLabel('Duração em minutos').fill('0');
    await page.getByRole('button', { name: 'Agendar' }).click();
    await expect(page.getByText('Janela inválida')).toHaveCount(0);
    // com duração válida o mesmo evento entra
    await page.getByLabel('Duração em minutos').fill('30');
    await page.getByRole('button', { name: 'Agendar' }).click();
    await expect(page.getByText('Janela inválida')).toBeVisible();
  });

  test('o sino mostra a caixa pessoal, vazia para quem não recebeu nada', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('button', { name: 'Notificações' }).click();
    await expect(page.getByText('Nada por aqui.')).toBeVisible();
  });
});

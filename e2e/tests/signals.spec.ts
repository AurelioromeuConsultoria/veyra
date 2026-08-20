import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

/**
 * O ambiente e2e não tem ANTHROPIC_API_KEY: é exatamente o cenário de
 * degradação — o produto continua funcionando e diz o que está indisponível.
 */
test.describe('Sinais (UI)', () => {
  test('consentimento nasce desligado e pode ser ligado por quem gerencia', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Sinais' }).click();

    // clique + asserção em vez de check(): o input é controlado por estado
    // assíncrono, e check() exige a mudança dentro do próprio clique
    const consentimento = page.getByLabel('Permitir uso de conteúdo de conversa');
    await expect(consentimento).not.toBeChecked();
    await consentimento.click();
    await expect(consentimento).toBeChecked();

    // e a decisão PERSISTE: é configuração do workspace, não estado de tela
    await page.reload();
    await expect(page.getByLabel('Permitir uso de conteúdo de conversa')).toBeChecked();

    // volta ao estado original para não contaminar os outros testes
    await page.getByLabel('Permitir uso de conteúdo de conversa').click();
    await expect(page.getByLabel('Permitir uso de conteúdo de conversa')).not.toBeChecked();
  });

  test('sem consentimento, o resumo explica o motivo em vez de falhar', async ({ page }) => {
    await login(page, OWNER_A);
    // garante o estado inicial: outro teste pode ter ligado o consentimento
    await page.getByRole('link', { name: 'Sinais' }).click();
    const consentimento = page.getByLabel('Permitir uso de conteúdo de conversa');
    if (await consentimento.isChecked()) await consentimento.click();
    await expect(consentimento).not.toBeChecked();

    await page.getByRole('link', { name: 'Inbox' }).click();

    const assunto = `Resumo ${Date.now()}`;
    await page.getByLabel('Assunto da nova conversa').fill(assunto);
    await page.getByRole('button', { name: 'Criar conversa' }).click();
    await expect(page.getByRole('heading', { name: assunto })).toBeVisible();
    await page.getByLabel('Corpo da mensagem').fill('Preciso de uma proposta.');
    await page.getByRole('button', { name: 'Enviada' }).click();

    await page.getByRole('button', { name: 'Resumir' }).click();
    await expect(page.getByText(/não autorizou o uso de conteúdo/i)).toBeVisible();
  });

  test('a página de sinais mostra execuções, inclusive as recusadas', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Sinais' }).click();
    await expect(page.getByRole('heading', { name: 'Sinais' })).toBeVisible();
    // o run recusado por falta de consentimento aparece no histórico
    await expect(page.getByText('conversation_summary').first()).toBeVisible();
    await expect(page.getByText(/no_consent/).first()).toBeVisible();
  });
});

import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login } from './helpers';

test.describe('Inbox (UI)', () => {
  test('conversa manual ponta a ponta: criar, registrar os dois sentidos e fechar', async ({
    page,
  }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Inbox' }).click();

    const assunto = `Renovação ${Date.now()}`;
    await page.getByLabel('Assunto da nova conversa').fill(assunto);
    await page.getByRole('button', { name: 'Criar conversa' }).click();

    // a conversa nova já vem selecionada
    await expect(page.getByRole('heading', { name: assunto })).toBeVisible();
    await expect(page.getByText('Nenhuma mensagem registrada ainda.')).toBeVisible();

    // mensagem enviada pelo time
    await page.getByLabel('Corpo da mensagem').fill('Enviamos a proposta de renovação.');
    await page.getByRole('button', { name: 'Enviada' }).click();
    await expect(page.getByText('Enviamos a proposta de renovação.')).toBeVisible();

    // sem contato vinculado, registrar "recebida" fica indisponível
    await expect(page.getByRole('button', { name: 'Recebida' })).toBeDisabled();

    // a conversa sobe para o topo do inbox, com o horário da última mensagem
    await expect(page.getByRole('button', { name: new RegExp(assunto) }).first()).toBeVisible();

    // fechar tira da lista de abertas
    await page.getByLabel('Status da conversa').selectOption('closed');
    await expect(page.getByRole('button', { name: new RegExp(assunto) })).toHaveCount(0);
    await page.getByLabel('Filtrar por status').selectOption('closed');
    await expect(page.getByRole('button', { name: new RegExp(assunto) }).first()).toBeVisible();
  });

  test('conversa com contato aceita mensagem recebida e aparece na timeline', async ({ page }) => {
    await login(page, OWNER_A);

    // contato dedicado para esta conversa
    const nome = `Cliente Inbox ${Date.now()}`;
    await page.getByRole('link', { name: 'Contatos' }).click();
    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill(nome);
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByRole('cell', { name: nome })).toBeVisible();

    // a conversa é criada pela API para vincular o contato (a UI desta entrega
    // cria conversa só por assunto; vincular contato entra com anexos na 6.3)
    const contactId = await page.evaluate(async (name) => {
      const res = await fetch(`/api/contacts?search=${encodeURIComponent(name)}`, {
        credentials: 'include',
      });
      const page1 = (await res.json()) as { items: { id: string; name: string }[] };
      return page1.items.find((c) => c.name === name)?.id ?? '';
    }, nome);
    expect(contactId).not.toBe('');

    await page.evaluate(async (id) => {
      const csrf = /(?:^|; )veyra_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
      await fetch('/api/conversations', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ contactId: id, subject: 'Suporte' }),
      });
    }, contactId);

    await page.getByRole('link', { name: 'Inbox' }).click();
    await page
      .getByRole('button', { name: new RegExp(nome) })
      .first()
      .click();

    await page.getByLabel('Corpo da mensagem').fill('Obrigado pelo retorno!');
    await page.getByRole('button', { name: 'Recebida' }).click();
    await expect(page.getByText('Obrigado pelo retorno!')).toBeVisible();
    await expect(page.getByText(nome).first()).toBeVisible();
  });
});

import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login, openE2eDb } from './helpers';

test.describe('Inbox (UI)', () => {
  test('conversa manual ponta a ponta: criar, registrar os dois sentidos e fechar', async ({
    page,
  }) => {
    await login(page, OWNER_A);
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Inbox' })
      .click();

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

    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Inbox' })
      .click();
    await page
      .getByRole('button', { name: new RegExp(nome) })
      .first()
      .click();

    await page.getByLabel('Corpo da mensagem').fill('Obrigado pelo retorno!');
    await page.getByRole('button', { name: 'Recebida' }).click();
    await expect(page.getByText('Obrigado pelo retorno!')).toBeVisible();
    await expect(page.getByText(nome).first()).toBeVisible();
  });

  test('canal externo: janela fechada, template indisponível e o pedido de parar (F4.1b)', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const { rows } = await db.query<{ workspace_id: string; membership_id: string }>(
        `SELECT m."workspaceId" AS workspace_id, m."id" AS membership_id
           FROM "Membership" m
           JOIN "User" u ON u."id" = m."userId"
          WHERE u."email" = $1
          LIMIT 1`,
        [OWNER_A],
      );
      const ws = rows[0].workspace_id;
      /**
       * O contato é criado AQUI. A versão anterior pegava "o primeiro contato do
       * workspace", que só existia porque `contacts.spec.ts` roda antes na ordem
       * alfabética: rodar este teste isolado quebrava no INSERT do consentimento,
       * apontando para o lugar errado.
       *
       * O contato tem o número da conversa, com as colunas derivadas, como a
       * ingestão o deixaria (ADR-052): sem ele, a resposta é bloqueada por
       * "o número saiu do contato", e a tela não chega à janela. O número é
       * único deste teste: o pedido de parar abaixo vale para o workspace.
       */
      const numero = `+55119${String(Date.now()).slice(-8)}`;
      const contatoRow = await db.query<{ id: string }>(
        `INSERT INTO "Contact" ("id","workspaceId","name","phones","phonesNormalized","phoneMatchKeys","updatedAt")
         VALUES (gen_random_uuid(), $1, 'Paciente Externo', ARRAY[$2], ARRAY[$2], ARRAY[right($2, 8)], now())
         RETURNING "id"`,
        [ws, numero],
      );
      const contato = contatoRow.rows[0].id;

      // canal externo com JANELA FECHADA: é o estado que a tela precisa explicar
      const canal = await db.query<{ id: string }>(
        `INSERT INTO "Channel" ("id","workspaceId","type","name")
         VALUES (gen_random_uuid(), $1, 'whatsapp', 'WhatsApp E2E') RETURNING "id"`,
        [ws],
      );
      const assunto = `Fora da janela ${Date.now()}`;
      await db.query(
        `INSERT INTO "Conversation"
           ("id","workspaceId","channelId","contactId","subject","externalAddress","lastInboundAt","lastMessageAt")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() - interval '25 hours', now())`,
        [ws, canal.rows[0].id, contato, assunto, numero],
      );
      /**
       * O consentimento da 9.1 e templates aprovados — MESMO NOME em dois
       * idiomas, o caso que já expôs um defeito do compositor. Na transição da
       * F4.1b, nada disso autoriza template: a tela explica a indisponibilidade
       * e não oferece o compositor de template.
       */
      await db.query(
        `INSERT INTO "ContactChannelConsent"
           ("id","workspaceId","contactId","channelType","source","activeMark")
         VALUES (gen_random_uuid(), $1, $2, 'whatsapp', 'agent', TRUE)`,
        [ws, contato],
      );
      await db.query(
        `INSERT INTO "MessageTemplate" ("id","workspaceId","channelId","name","language","paramCount","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, 'retorno_consulta', 'pt_BR', 1, now()),
                (gen_random_uuid(), $1, $2, 'retorno_consulta', 'en_US', 2, now())`,
        [ws, canal.rows[0].id],
      );

      await login(page, OWNER_A);
      await page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Inbox' })
        .click();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();

      // selo do canal na LISTA (triagem) e o veredito acima do compositor
      await expect(page.getByText('whatsapp', { exact: true }).first()).toBeVisible();
      const veredito = page.getByTestId('send-policy');
      await expect(veredito).toContainText('janela fechada');
      await expect(veredito).toContainText(/template está indisponível/);
      // o estado da 9.1 não aparece mais: ele não autoriza nada (C7)
      await expect(veredito).not.toContainText('opt-in');
      await expect(page.getByTestId('template-composer')).toHaveCount(0);
      // bloqueado: o botão não envia, em vez de deixar o atendente descobrir pelo erro
      await page.getByLabel('Corpo da mensagem').fill('Podemos reagendar?');
      await expect(page.getByRole('button', { name: /Enviada|Enviar template/ })).toBeDisabled();

      // o pedido de parar do número: a tela mostra o bloqueio, antes da janela
      await db.query(
        `INSERT INTO "StopBlock" ("id","workspaceId","number","origin","receipt","createdByMembershipId")
         VALUES (gen_random_uuid(), $1, $2, 'phone', $3, $4)`,
        [ws, numero, `PAR-E2E-${Date.now()}`, rows[0].membership_id],
      );
      await page.reload();
      await page.getByRole('button', { name: new RegExp(assunto.slice(0, 12)) }).click();
      await expect(veredito).toContainText('pediu para não receber mensagens');
      await expect(page.getByTestId('template-composer')).toHaveCount(0);
    } finally {
      await db.end();
    }
  });
});

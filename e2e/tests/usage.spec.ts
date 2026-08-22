import { expect, test } from '@playwright/test';
import { OWNER_A } from '../env';
import { login, openE2eDb } from './helpers';

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

    // desde a 9.1.b existe envio externo de verdade, e a métrica é cobrada
    await expect(page.getByText('Mensagens enviadas')).toBeVisible();
    await expect(page.getByTestId('usage-messages_sent-used')).toBeVisible();
  });

  test('criar contato move o medidor de contatos', async ({ page }) => {
    await login(page, OWNER_A);
    await page.getByRole('link', { name: 'Uso e plano' }).click();
    // pt-BR insere ponto de milhar: sanitiza antes de comparar
    const lerUsados = async () =>
      Number(
        ((await page.getByTestId('usage-contacts-used').textContent()) ?? '0').replace(/\D/g, ''),
      );
    const antes = await lerUsados();

    await page.getByRole('link', { name: 'Contatos' }).click();
    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill(`Medidor ${Date.now()}`);
    await page.getByRole('button', { name: 'Salvar' }).click();

    await page.getByRole('link', { name: 'Uso e plano' }).click();
    // asserção com RETRY: ao voltar para a tela, o TanStack Query serve o valor
    // em cache antes de o refetch chegar — ler uma vez é uma corrida perdida
    await expect.poll(lerUsados, { timeout: 10_000 }).toBe(antes + 1);
  });

  test('assinatura cancelada mostra o plano APLICADO, não o contratado', async ({ page }) => {
    const db = await openE2eDb();
    let ws: string | null = null;
    let anterior: string | null = null;
    try {
      /**
       * Antes desta entrega a tela dizia "Plano Base · renova em …" mesmo com a
       * assinatura cancelada, enquanto o teto aplicado vinha do plano padrão
       * (ADR-041) — quem esbarrasse no limite não tinha como entender por quê.
       */
      // ESCOPADO ao workspace deste teste: sem o WHERE, o update atingia beta
      // também e o `finally` "consertava" para ativo linhas que talvez não
      // estivessem — flakiness cruzada entre specs
      const { rows } = await db.query<{ workspace_id: string; status: string }>(
        `SELECT m."workspaceId" AS workspace_id, s."status" FROM "Membership" m
           JOIN "User" u ON u."id" = m."userId"
           JOIN "Subscription" s ON s."workspaceId" = m."workspaceId"
          WHERE u."email" = $1 LIMIT 1`,
        [OWNER_A],
      );
      ws = rows[0].workspace_id;
      anterior = rows[0].status;
      await db.query(`UPDATE "Subscription" SET "status" = 'canceled' WHERE "workspaceId" = $1`, [
        ws,
      ]);
      await login(page, OWNER_A);
      await page.getByRole('link', { name: 'Uso e plano' }).click();

      await expect(page.getByTestId('usage-applied-plan')).toContainText(
        /aplicado por ausência de assinatura ativa/i,
      );
      // e a assinatura registrada aparece como alerta, não como se estivesse valendo
      await expect(page.getByText(/Assinatura registrada/i)).toBeVisible();
    } finally {
      // devolve o status ANTERIOR: restaurar 'active' por decreto inventaria
      // estado para uma linha que talvez não estivesse ativa
      if (ws && anterior) {
        await db.query(
          `UPDATE "Subscription" SET "status" = $2::"SubscriptionStatus" WHERE "workspaceId" = $1`,
          [ws, anterior],
        );
      }
      await db.end();
    }
  });

  test('membro sem billing vê o medidor, não a situação comercial', async ({ page }) => {
    const db = await openE2eDb();
    try {
      /**
       * A API é a fronteira: antes, esconder a faixa na tela deixava qualquer
       * portador do medidor obter status, preço e período chamando /api/usage.
       */
      const { rows } = await db.query<{ role_id: string; ws: string }>(
        `SELECT r."id" AS role_id, r."workspaceId" AS ws
           FROM "Role" r
           JOIN "Membership" m ON m."workspaceId" = r."workspaceId"
           JOIN "User" u ON u."id" = m."userId"
          WHERE u."email" = $1 AND r."systemKey" = 'member' LIMIT 1`,
        [OWNER_A],
      );
      // rebaixa o owner do teste a Member (sem `billing:manage`)
      await db.query(
        `UPDATE "Membership" SET "roleId" = $1 WHERE "workspaceId" = $2
           AND "userId" = (SELECT "id" FROM "User" WHERE "email" = $3)`,
        [rows[0].role_id, rows[0].ws, OWNER_A],
      );

      await login(page, OWNER_A);
      await page.getByRole('link', { name: 'Uso e plano' }).click();

      // uso e plano aplicado continuam visíveis
      await expect(page.getByTestId('usage-applied-plan')).toContainText(/Plano/);
      await expect(page.getByTestId('usage-contacts-used')).toBeVisible();
      // e a resposta da API não traz situação comercial nenhuma
      const overview = await page.request.get('/api/usage');
      const corpo = await overview.json();
      expect(corpo.subscription).toBeNull();
      expect(JSON.stringify(corpo)).not.toContain('priceCents');
    } finally {
      await db.end();
    }
  });
});

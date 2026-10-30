import { expect, test } from '@playwright/test';
import { MEMBER_C, OWNER_C } from '../env';
import { abrirConfiguracao, login, openE2eDb } from './helpers';

/**
 * Liberação de contatos para IA do Veyra Clinics (F2.1, ADR-048 adendo 2)
 * pela UI, no workspace `clinica`. Dados FICTÍCIOS, com nomes únicos por
 * execução (seguro para o retry do CI). O paciente nasce direto no banco: a
 * tela de paciente não faz parte da F2.1.
 */
test.describe('Clinics — liberação para IA', () => {
  test('Owner: libera um contato, vê o paciente como não liberável, e revogar apaga a liberação', async ({
    page,
  }) => {
    const sufixo = Date.now().toString(36);
    const fornecedor = `Distribuidora Luvas ${sufixo}`;
    const paciente = `Paciente Ficticia ${sufixo}`;
    const db = await openE2eDb();
    try {
      const dona = (
        await db.query<{ workspaceId: string; membershipId: string }>(
          `SELECT w."id" AS "workspaceId", m."id" AS "membershipId"
             FROM "Membership" m JOIN "User" u ON u."id" = m."userId"
             JOIN "Workspace" w ON w."id" = m."workspaceId"
            WHERE u."email" = $1 AND w."slug" = 'clinica'`,
          [OWNER_C],
        )
      ).rows[0];
      const contato = async (nome: string) =>
        (
          await db.query<{ id: string }>(
            `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
             VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
            [dona.workspaceId, nome],
          )
        ).rows[0].id;
      const idFornecedor = await contato(fornecedor);
      const idPaciente = await contato(paciente);
      await db.query(
        `INSERT INTO "ClinicsPatient" ("id","workspaceId","contactId","createdByMembershipId")
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [dona.workspaceId, idPaciente, dona.membershipId],
      );

      await login(page, OWNER_C);
      await abrirConfiguracao(page, /^Privacidade e IA/, 'Liberação para IA');
      await expect(page.getByText(/Paciente nunca é liberável/)).toBeVisible();

      const liberar = async (nome: string, motivo: string) => {
        await page.getByRole('button', { name: 'Liberar contato' }).click();
        await page.getByLabel(/^Buscar contato/).fill(nome);
        await page.getByRole('radio', { name: nome }).check();
        await page.getByLabel(/^Motivo/).selectOption({ label: motivo });
        await page.getByRole('button', { name: 'Liberar para IA' }).click();
      };

      await liberar(fornecedor, 'Fornecedor');
      const linha = page.getByRole('row').filter({ hasText: fornecedor });
      // o nome não contém o rótulo: a célula prova o MOTIVO gravado
      await expect(linha.getByRole('cell', { name: 'Fornecedor', exact: true })).toBeVisible();
      const liberacao = async (id: string) =>
        (
          await db.query<{ reason: string }>(
            `SELECT "reason" FROM "ClinicsContactRelease" WHERE "contactId" = $1`,
            [id],
          )
        ).rows;
      expect(await liberacao(idFornecedor)).toEqual([{ reason: 'supplier' }]);

      // a Owner lê pacientes: o paciente aparece, mas não pode ser escolhido
      // (o 409 de quem não lê pacientes está no teste de integração e no web)
      await page.getByRole('button', { name: 'Liberar contato' }).click();
      await page.getByLabel(/^Buscar contato/).fill(paciente);
      await expect(page.getByRole('radio', { name: paciente })).toBeDisabled();
      await expect(page.getByText('· paciente — não liberável')).toBeVisible();
      expect(await liberacao(idPaciente)).toEqual([]);
      await page.getByRole('button', { name: 'Fechar' }).click();

      await page.getByRole('button', { name: `Revogar liberação de ${fornecedor}` }).click();
      await expect(page.getByRole('row').filter({ hasText: fornecedor })).toHaveCount(0);
      expect(await liberacao(idFornecedor)).toEqual([]);
      const trilhas = (
        await db.query<{ action: string }>(
          `SELECT "action" FROM "AuditLog" WHERE "entityType" = 'clinicsContactRelease'
              AND ("before"->>'contactId' = $1 OR "after"->>'contactId' = $1)
            ORDER BY "createdAt"`,
          [idFornecedor],
        )
      ).rows.map((r) => r.action);
      expect(trilhas).toEqual(['clinics.ai_release.granted', 'clinics.ai_release.revoked']);
    } finally {
      await db.end();
    }
  });

  test('recepção (Member): sem a entrada na lateral, e a URL direta só explica', async ({
    page,
  }) => {
    await login(page, MEMBER_C);
    await page.goto('/clinics/ai-releases');
    await expect(page.getByText('Você não tem acesso à liberação para IA.')).toBeVisible();
    // a seção mora nas Configurações, e a recepção não tem as chaves dela
    const lateral = page.getByRole('navigation', { name: 'Principal' });
    await expect(lateral.getByRole('link', { name: 'Liberação para IA' })).toHaveCount(0);
    await lateral.getByRole('link', { name: 'Configurações', exact: true }).click();
    await expect(page.getByRole('main').getByRole('link', { name: /^Clínica/ })).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('link', { name: /^Privacidade e IA/ }),
    ).toHaveCount(0);
  });
});

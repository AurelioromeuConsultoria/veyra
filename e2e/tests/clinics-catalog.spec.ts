import { expect, test } from '@playwright/test';
import { MEMBER_C, OWNER_A, OWNER_C } from '../env';
import { login, openE2eDb } from './helpers';

/**
 * Catálogo do Veyra Clinics (F1.c, ADR-048 adendo 1) pela UI, no workspace
 * `clinica`, o único com o vertical ativado (pela CLI compilada, no setup).
 * Seguro para o retry do CI: nomes únicos por execução, e o vínculo anterior
 * da recepção é desfeito antes de vincular de novo.
 */
test.describe('Clinics — catálogo da clínica', () => {
  test('Owner: cadastra serviço e profissional (perfil salvo junto), e o vínculo de conta avisa que não muda papel', async ({
    page,
  }) => {
    const sufixo = Date.now().toString(36);
    const servico = `Limpeza de pele ${sufixo}`;
    const profissional = `Ana Souza ${sufixo}`;
    const db = await openE2eDb();
    try {
      const recepcao = async () =>
        (
          await db.query<{ id: string; systemKey: string; tokenVersion: number }>(
            `SELECT m."id", r."systemKey", m."tokenVersion"
               FROM "Membership" m JOIN "User" u ON u."id" = m."userId"
               JOIN "Role" r ON r."id" = m."roleId"
              WHERE u."email" = $1`,
            [MEMBER_C],
          )
        ).rows[0];
      const antes = await recepcao();
      await db.query(
        `UPDATE "ClinicsProfessional" SET "membershipId" = NULL WHERE "membershipId" = $1`,
        [antes.id],
      );

      await login(page, OWNER_C, 'Catálogo');

      await page.getByRole('button', { name: 'Novo serviço' }).click();
      await page.getByLabel('Nome', { exact: true }).fill(servico);
      await page.getByLabel('Duração (minutos)').fill('60');
      await page.getByLabel('Preço (R$)').fill('150,00');
      await page.getByRole('button', { name: 'Salvar serviço' }).click();
      await expect(page.getByRole('cell', { name: servico, exact: true })).toBeVisible();

      await page.getByRole('tab', { name: 'Profissionais' }).click();
      await page.getByRole('button', { name: 'Novo profissional' }).click();
      await page.getByLabel('Nome', { exact: true }).fill(profissional);
      await page.getByLabel(servico).check();
      // dois intervalos padrão (08:00–12:00) na segunda: sobrepostos
      await page.getByRole('button', { name: 'Acrescentar intervalo na segunda' }).click();
      await page.getByRole('button', { name: 'Acrescentar intervalo na segunda' }).click();
      await page.getByRole('button', { name: 'Salvar perfil' }).click();
      await expect(page.getByRole('alert')).toContainText('Nada foi salvo');

      await page.getByLabel('Segunda: início').nth(1).fill('13:00');
      await page.getByLabel('Segunda: fim').nth(1).fill('18:00');
      await page.getByRole('button', { name: 'Salvar perfil' }).click();
      await expect(page.getByRole('status')).toContainText('Perfil salvo');

      // vínculo: ação SEPARADA, com o aviso de que não muda papel nem permissões
      await expect(page.getByText(/não muda o papel nem concede permissões/)).toBeVisible();
      await page
        .getByRole('region', { name: /Conta vinculada/ })
        .getByRole('combobox')
        .selectOption({ label: `Recepção Clínica · ${MEMBER_C}` });
      await page.getByRole('button', { name: 'Salvar vínculo' }).click();
      await expect(page.getByText('Vínculo salvo.')).toBeVisible();

      // no banco: papel e versão do token da recepção IGUAIS a antes do vínculo
      const depois = await recepcao();
      expect({ systemKey: depois.systemKey, tokenVersion: depois.tokenVersion }).toEqual({
        systemKey: 'member',
        tokenVersion: antes.tokenVersion,
      });
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "ClinicsWorkingHours" h
           JOIN "ClinicsProfessional" p ON p."id" = h."professionalId"
          WHERE p."name" = $1`,
        [profissional],
      );
      expect(rows[0].n).toBe('2');
    } finally {
      await db.end();
    }
  });

  test('recepção (Member): vê o catálogo, sem nenhuma ação de escrita', async ({ page }) => {
    await login(page, MEMBER_C, 'Catálogo');
    await expect(page.getByRole('tab', { name: 'Serviços' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Novo serviço' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Profissionais' }).click();
    await expect(page.getByRole('tab', { name: 'Profissionais' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Novo profissional' })).toHaveCount(0);
  });

  test('workspace SEM o Clinics: a URL direta diz que não está ativo, e a lateral não tem a entrada', async ({
    page,
  }) => {
    await login(page, OWNER_A);
    await page.goto('/clinics/catalog');
    // a mensagem prova que o status já respondeu — só então a lateral é conferida
    await expect(page.getByText('O Clinics não está ativo neste workspace.')).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Catálogo' }),
    ).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';
import { DOIS_PRODUTOS } from '../env';
import { login } from './helpers';

/**
 * A experiência por produto (ADR-055, adendo 2), de ponta a ponta. A mesma
 * pessoa é Member em `acme` (o CRM) e em `clinica` (a experiência da clínica,
 * posta pela semeadura). O que se prova: cada produto com o seu menu, o seu
 * início, as suas rotas e a sua busca; a troca pelo seletor; a rota de outro
 * produto levando ao início com o aviso. Dados fictícios.
 */
test.describe('Experiência por produto (ADR-055)', () => {
  test('a mesma pessoa, dois produtos: o seletor troca o menu, o início, as rotas e a busca', async ({
    page,
  }) => {
    await login(page, DOIS_PRODUTOS);
    const menu = page.getByRole('navigation', { name: 'Principal' });

    // o CRM (o workspace mais antigo): o menu de sempre, sem o Clinics
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Empresas', exact: true })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Agenda da clínica' })).toHaveCount(0);
    await expect(page).toHaveTitle(/ACME · Veyra$/);

    // a rota do Clinics não existe no CRM
    await page.goto('/clinics/agenda');
    await expect(page.getByTestId('fora-da-experiencia')).toContainText(
      'Esta seção não faz parte do Veyra.',
    );
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();

    // a troca para a clínica, pelo seletor
    await page.getByRole('button', { name: /Trocar de workspace/ }).click();
    await page.getByRole('button', { name: /CLINICA/ }).click();
    await expect(page.getByRole('heading', { name: 'Agenda da clínica', level: 1 })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Pacientes' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Empresas', exact: true })).toHaveCount(0);
    await expect(menu.getByRole('link', { name: 'Hoje', exact: true })).toHaveCount(0);
    await expect(page).toHaveTitle(/CLINICA · Veyra Clinics$/);

    // a rota do CRM não existe na clínica
    await page.goto('/companies');
    await expect(page.getByTestId('fora-da-experiencia')).toContainText(
      'Esta seção não faz parte do Veyra Clinics.',
    );
    await expect(page.getByRole('heading', { name: 'Agenda da clínica', level: 1 })).toBeVisible();

    // a busca é do produto: a seção do CRM não aparece
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByLabel('Buscar no workspace').fill('empresas');
    await expect(page.getByText('Nada com esse nome.')).toBeVisible();
    await expect(page.getByRole('option', { name: /^Empresas/ })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // e de volta ao CRM
    await page.getByRole('button', { name: /Trocar de workspace/ }).click();
    await page.getByRole('button', { name: /ACME/ }).click();
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Empresas', exact: true })).toBeVisible();
    // a troca vai ao início do produto, não à rota anterior com o aviso
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('fora-da-experiencia')).toHaveCount(0);
  });
});

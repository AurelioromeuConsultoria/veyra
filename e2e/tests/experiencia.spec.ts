import { expect, test } from '@playwright/test';
import { DOIS_PRODUTOS, OWNER_C, PROF_C } from '../env';
import { abrirNoMenu, login } from './helpers';

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
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Pacientes' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Empresas', exact: true })).toHaveCount(0);
    // o Hoje é o da clínica, não o do CRM
    await expect(menu.getByRole('link', { name: 'Hoje', exact: true })).toHaveAttribute(
      'href',
      '/clinics/today',
    );
    await expect(page).toHaveTitle(/CLINICA · Veyra Clinics$/);

    // a rota do CRM não existe na clínica
    await page.goto('/companies');
    await expect(page.getByTestId('fora-da-experiencia')).toContainText(
      'Esta seção não faz parte do Veyra Clinics.',
    );
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();

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

  test('Clinics (Owner): o Hoje da clínica, o menu sem o CRM, o interessado que vira paciente, e a busca sem sair do produto', async ({
    page,
  }) => {
    const nome = `Interessada E2E ${Date.now()}`;
    await login(page, OWNER_C);
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Retornos vencidos' })).toBeVisible();
    await expect(page).toHaveTitle(/^Hoje · CLINICA · Veyra Clinics$/);
    const menu = page.getByRole('navigation', { name: 'Principal' });
    for (const fora of ['Empresas', 'Contatos', 'Tarefas', 'Sinais', 'Automações']) {
      await expect(menu.getByRole('link', { name: fora, exact: true })).toHaveCount(0);
    }
    // os grupos agrupam: fechados até a pessoa abrir
    await expect(menu.getByRole('button', { name: 'Captação' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // o interessado, criado pela interface (D-E3.4), e a passagem explícita
    await abrirNoMenu(page, 'Captação', 'Interessados');
    await expect(page.getByRole('heading', { name: 'Interessados', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /Novo interessado/ }).click();
    await page.getByRole('textbox', { name: 'Nome', exact: true }).fill(nome);
    await page.getByRole('button', { name: 'Criar interessado' }).click();
    // criado, a tela vai à pessoa
    await expect(page).toHaveURL(/\/clinics\/person\?id=/);
    await expect(page.getByRole('heading', { name: nome, level: 1 })).toBeVisible();
    await expect(page.getByText('Clínica · Interessado')).toBeVisible();
    await page.getByRole('button', { name: 'Tornar paciente' }).click();
    await expect(page.getByText('Ao tornar paciente:')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar: tornar paciente' }).click();
    await expect(page).toHaveURL(/\/clinics\/patient\?id=/);
    await expect(page.getByRole('heading', { name: nome, level: 1 })).toBeVisible();

    // a busca: o paciente, com o rótulo, leva à ficha — nunca ao CRM
    await page.goto('/clinics/today');
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByLabel('Buscar no workspace').fill(nome);
    await page.getByRole('option', { name: new RegExp(`${nome}.*Paciente`) }).click();
    await expect(page).toHaveURL(/\/clinics\/patient\?id=/);
    await expect(page.getByTestId('fora-da-experiencia')).toHaveCount(0);
  });

  test('Clinics (Profissional): o Hoje sem conversas nem envios, e nenhuma consulta deles', async ({
    page,
  }) => {
    const consultas: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/(conversations|contacts|deals|pipelines|clinics\/outreach)/.test(r.url()))
        consultas.push(r.url());
    });
    await login(page, PROF_C);
    await expect(page.getByRole('heading', { name: 'Hoje', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Retornos vencidos' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Conversas com janela aberta' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Confirmar amanhã' })).toHaveCount(0);
    const menu = page.getByRole('navigation', { name: 'Principal' });
    await expect(menu.getByRole('link', { name: 'Conversas', exact: true })).toHaveCount(0);
    await expect(menu.getByRole('button', { name: 'Captação' })).toHaveCount(0);
    await page.waitForLoadState('networkidle');
    expect(consultas).toEqual([]);
  });
});

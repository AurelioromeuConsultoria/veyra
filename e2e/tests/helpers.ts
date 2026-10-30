import { Client } from 'pg';
import { expect, type Page } from '@playwright/test';
import { assertIsE2eDb, E2E_DATABASE_URL, E2E_PASSWORD } from '../env';

/**
 * Login pela UI (o caminho do usuário, não atalho de API).
 *
 * O destino do login é o início do PRODUTO do workspace (ADR-055): o "Hoje" do
 * CRM ou o Hoje da clínica. O helper espera o menu do produto, sem supor qual.
 * Quem PRECISA cair numa seção específica pede por ela: o helper navega pelo
 * mesmo link da barra lateral que a pessoa usaria.
 */
export async function login(page: Page, email: string, secao?: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
  if (secao) {
    await page.getByRole('link', { name: secao, exact: true }).click();
    await expect(page.getByRole('heading', { name: secao, level: 1 })).toBeVisible();
  }
}

/**
 * Um item dentro de um grupo recolhível do menu (ADR-055, E-3): o grupo começa
 * fechado, e é aberto se for preciso. Um grupo com um item só mostra o item
 * direto, sem botão.
 */
export async function abrirNoMenu(page: Page, grupo: string, item: string): Promise<void> {
  const menu = page.getByRole('navigation', { name: 'Principal' });
  const botao = menu.getByRole('button', { name: grupo, exact: true });
  if ((await botao.count()) > 0 && (await botao.getAttribute('aria-expanded')) === 'false') {
    await botao.click();
  }
  await menu.getByRole('link', { name: item, exact: true }).click();
}

/** Uma seção das Configurações do produto: a entrada do menu, a página, a seção. */
export async function abrirConfiguracao(page: Page, secao: RegExp, titulo: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: 'Configurações', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Configurações', level: 1 })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: secao }).first().click();
  await expect(page.getByRole('heading', { name: titulo, level: 1 })).toBeVisible();
}

/**
 * Conexão de teste com a TRAVA na própria função: o `assertIsE2eDb` do
 * global-setup só protege quem passa por lá, e um spec que abre a conexão
 * direto ficaria sem defesa se a URL apontasse para outro banco.
 */
export async function openE2eDb(url = E2E_DATABASE_URL): Promise<Client> {
  // `assertIsE2eDb` devolve o NOME do banco (e lança se não contiver "e2e"):
  // chamar por causa da trava, conectar com a URL
  assertIsE2eDb(url);
  const db = new Client({ connectionString: url });
  await db.connect();
  return db;
}

/**
 * A resposta do GET do consentimento de conteúdo (ADR-028). Enquanto ela não
 * chega, a caixa da tela de Sinais aparece desmarcada: quem lê ou clica a
 * caixa antes disso afirma, ou muda, um estado que ainda não conhece.
 * Arme ANTES da navegação que dispara a consulta.
 */
export function esperarConsentimento(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (r) =>
      r.url().endsWith('/api/intelligence/consent') && r.request().method() === 'GET' && r.ok(),
  );
}

import { expect, test, type Page } from '@playwright/test';
import { E2E_PASSWORD, E2E_WEB_ORIGIN, MEMBER_C, OWNER_A } from '../env';
import { abrirNoMenu, login, openE2eDb } from './helpers';

/**
 * Duas sessões na MESMA aba, sem recarregar a página (ADR-050), no navegador
 * real: a sessão de A expira sem logout (revogada no banco) e B entra em OUTRO
 * workspace. Uma resposta de A, buscada no servidor com a sessão de A, fica
 * RETIDA até depois do login de B — e a troca de sessão ABORTA o pedido no
 * navegador, então ela nunca chega ao JavaScript. Este teste afirma o abort
 * (`requestfailed` do pedido retido) e que nada de A aparece para B; a resposta
 * que chega mesmo assim (o caminho da época) é provada no Vitest, com um stub
 * que ignora o abort. Dados fictícios.
 */
const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Segura no navegador as respostas de contatos de uma busca escolhida. */
async function reterBuscas(page: Page) {
  const retidas: { termo: string; soltar: () => void }[] = [];
  let reter: string | null = null;
  await page.route(
    // a busca de contatos do CRM e a de interessados da clínica (ADR-055, E-3)
    (url) => url.pathname === '/api/contacts' || url.pathname === '/api/clinics/leads',
    async (route) => {
      const termo = new URL(route.request().url()).searchParams.get('search');
      if (reter === null || termo !== reter) return route.continue();
      reter = null;
      // a resposta é calculada AGORA, com a sessão do momento; só a entrega atrasa
      const resposta = await route.fetch();
      await new Promise<void>((soltar) => retidas.push({ termo, soltar }));
      // a aba pode ter abortado o pedido na troca de sessão
      await route.fulfill({ response: resposta }).catch(() => undefined);
    },
  );
  return {
    reter: (termo: string) => (reter = termo),
    retidas,
  };
}

async function entrarNaMesmaAba(page: Page, email: string) {
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  // o início do produto do workspace (ADR-055), sem supor qual
  await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible();
}

const linha = (page: Page, nome: string) => page.getByRole('row', { name: new RegExp(nome) });

test('duas sessões na mesma aba: expiração sem logout, outro workspace e resposta antiga depois do novo login — nada da sessão anterior', async ({
  page,
}) => {
  const db = await openE2eDb();
  try {
    const s = sufixo();
    const nomeA = `Contato Sessao A ${s}`;
    const nomeC = `Contato Sessao C ${s}`;
    for (const [slug, nome] of [
      ['acme', nomeA],
      ['clinica', nomeC],
    ]) {
      await db.query(
        `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
         SELECT gen_random_uuid(), "id", $2, now() FROM "Workspace" WHERE "slug" = $1`,
        [slug, nome],
      );
    }
    const rede = await reterBuscas(page);

    // A, no workspace acme
    await login(page, OWNER_A, 'Contatos');
    const busca = page.getByLabel('Buscar contatos');
    await busca.fill(nomeA);
    await expect(linha(page, nomeA)).toBeVisible();

    // um pedido de A sai e fica a caminho, já com os dados de A
    const termoAntigo = nomeA.slice(0, -1);
    // o pedido retido de A falha NO NAVEGADOR quando a sessão troca (abort)
    const abortado = page.waitForEvent(
      'requestfailed',
      (r) => new URL(r.url()).searchParams.get('search') === termoAntigo,
    );
    rede.reter(termoAntigo);
    await busca.fill(termoAntigo);
    await expect.poll(() => rede.retidas.length).toBe(1);

    // a sessão de A acaba SEM logout; a aba descobre na próxima requisição
    await db.query(
      `UPDATE "RefreshToken" SET "revokedAt" = now()
        WHERE "revokedAt" IS NULL AND "userId" = (SELECT "id" FROM "User" WHERE "email" = $1)`,
      [OWNER_A],
    );
    await page
      .getByRole('navigation', { name: 'Principal' })
      .getByRole('link', { name: 'Empresas' })
      .click();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
    await expect(page.getByText(nomeA)).toHaveCount(0);
    // a troca abortou o pedido de A que estava a caminho
    expect((await abortado).failure()?.errorText).toMatch(/ABORTED|aborted|cancel/i);

    // B, no workspace clinica (a experiência da clínica), na MESMA aba (sem
    // recarregar): os contatos dela estão em Interessados
    await entrarNaMesmaAba(page, MEMBER_C);
    await abrirNoMenu(page, 'Captação', 'Interessados');
    const buscaDeB = page.getByLabel('Buscar interessado pelo nome');
    // B busca o MESMO termo que A buscou; a resposta de B demora
    rede.reter(nomeA);
    await buscaDeB.fill(nomeA);
    await expect.poll(() => rede.retidas.length).toBe(2);
    // enquanto a de B não chega, nada do cache de A aparece
    await expect(page.getByText(nomeA)).toHaveCount(0);

    // a resposta ANTIGA de A é solta agora, depois do login de B (o pedido já foi
    // abortado na troca: ela não tem mais a quem chegar)
    rede.retidas[0].soltar();
    await page.waitForTimeout(500);
    await expect(page.getByText(nomeA)).toHaveCount(0);

    // a de B chega: o contato de A não é do workspace de B
    rede.retidas[1].soltar();
    await expect(page.getByText('Ninguém com esse nome.')).toBeVisible();
    await expect(page.getByText(nomeA)).toHaveCount(0);
    await buscaDeB.fill(nomeC);
    await expect(page.getByRole('link', { name: nomeC })).toBeVisible();
    await expect(page.getByText(nomeA)).toHaveCount(0);
  } finally {
    await db.end();
  }
});

test('aba desatualizada: depois de um login em OUTRA aba, o formulário enviado pela aba velha não grava nada, e ela recomeça na sessão nova', async ({
  page,
}) => {
  const db = await openE2eDb();
  try {
    const nome = `Contato Aba Velha ${sufixo()}`;
    await login(page, OWNER_A, 'Contatos');
    await page.getByRole('button', { name: 'Novo contato' }).click();
    await page.getByLabel('Nome').fill(nome);

    // "outra aba": o mesmo navegador entra como outra pessoa, em outro workspace.
    // O cookie é da origem: a aba de cima passa a falar com a sessão nova
    const outra = await page.context().request.post('/api/auth/login', {
      headers: { Origin: E2E_WEB_ORIGIN },
      data: { email: MEMBER_C, password: E2E_PASSWORD },
    });
    expect(outra.status()).toBe(201);

    // a aba velha envia o que estava preenchido: o servidor recusa antes de executar
    const recusa = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/contacts',
    );
    await page.getByRole('button', { name: 'Salvar' }).click();
    expect((await recusa).status()).toBe(409);
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "Contact" WHERE "name" = $1`,
      [nome],
    );
    expect(rows[0].n).toBe('0');

    // e a aba recomeça na sessão do cookie, sem nada da anterior
    await expect(page.getByText('CLINICA', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Nome')).toHaveCount(0);
  } finally {
    await db.end();
  }
});

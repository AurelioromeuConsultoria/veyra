import { expect, test } from '@playwright/test';
import { CLINICS_PERMISSION_CATALOG } from '../../packages/contracts/src/verticals/clinics';
import { OWNER_C } from '../env';
import { login } from './helpers';

/**
 * A gestão de equipe pela interface (ADR-054, F5.1a), de ponta a ponta, no
 * workspace `clinica` (o Clinics ativo). Dados FICTÍCIOS: o e-mail é de teste,
 * e o Veyra não envia nada — o link sai da tela e é aberto noutro navegador.
 * O que se prova: convidar, aceitar, trocar o papel e remover, com o efeito na
 * sessão de quem foi convidado e a trilha na auditoria.
 */
test.describe('Equipe pela interface (ADR-054)', () => {
  test('convidar, aceitar, trocar o papel e remover — com o efeito na sessão da pessoa', async ({
    page,
    browser,
  }) => {
    const EMAIL = 'convidada-e2e@clinica.test';
    await login(page, OWNER_C, 'Equipe');

    // o Core mostra a descrição que o vertical declarou, sem conhecê-lo
    const profissional = page.locator('details', {
      has: page.locator('summary', { hasText: 'Profissional' }),
    });
    await profissional.locator('summary').click();
    await expect(
      profissional.getByText(CLINICS_PERMISSION_CATALOG['clinics:care:write']),
    ).toBeVisible();

    await page.getByLabel('E-mail do convite').fill(EMAIL);
    await page.getByLabel('Papel do convite').selectOption({ label: 'Member' });
    await page.getByRole('button', { name: 'Criar convite' }).click();
    const painel = page.getByTestId('link-do-convite');
    await expect(painel).toContainText('/convite#');
    const link = (await painel.locator('code').textContent()) ?? '';
    // o token vai no fragmento: nada dele na query string
    expect(new URL(link).search).toBe('');
    await expect(
      page.getByRole('row', { name: new RegExp(EMAIL) }).filter({ hasText: 'Aguardando aceite' }),
    ).toBeVisible();

    // a pessoa convidada, noutro navegador, sem sessão
    const outro = await browser.newContext();
    const convidada = await outro.newPage();
    await convidada.goto(link);
    await expect(convidada.getByRole('heading', { name: 'Aceitar o convite' })).toBeVisible();
    // o fragmento sai do endereço antes de qualquer requisição
    await expect(convidada).toHaveURL(/\/convite$/);
    await convidada.getByLabel('Seu nome').fill('Convidada E2E');
    await convidada.getByLabel(/^Crie uma senha/).fill('senha-e2e-forte-1');
    await convidada.getByRole('button', { name: 'Aceitar e entrar' }).click();
    // o início do produto do workspace (a clínica, ADR-055): o menu dele
    await expect(convidada.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    // Member lê a equipe
    await expect(convidada.getByRole('link', { name: 'Equipe', exact: true })).toBeVisible();

    // quem convidou vê a nova membro, e o convite saiu da lista
    await page.reload();
    const linha = page.getByRole('row', { name: /Convidada E2E/ });
    await expect(linha).toContainText('Member');
    await expect(
      page.getByRole('row', { name: new RegExp(EMAIL) }).filter({ hasText: 'Aguardando aceite' }),
    ).toHaveCount(0);

    // trocar o papel: o efeito aparece antes da confirmação
    await linha.getByRole('button', { name: 'Trocar o papel de Convidada E2E' }).click();
    await page.getByLabel('Novo papel').selectOption({ label: 'Guest' });
    await expect(page.getByTestId('efeito-da-troca')).toContainText('Deixa de poder');
    await page.getByRole('button', { name: 'Confirmar a troca' }).click();
    await expect(page.getByRole('status')).toContainText('Convidada E2E agora tem o papel Guest');

    // na sessão dela, a próxima ação já vale o papel novo: Guest não lê a equipe
    await convidada.reload();
    // o início do produto do workspace (a clínica, ADR-055): o menu dele
    await expect(convidada.getByRole('navigation', { name: 'Principal' })).toBeVisible();
    await expect(convidada.getByRole('link', { name: 'Contatos', exact: true })).toBeVisible();
    await expect(convidada.getByRole('link', { name: 'Equipe', exact: true })).toHaveCount(0);

    // remover: o acesso emitido cai na requisição seguinte
    await page
      .getByRole('row', { name: /Convidada E2E/ })
      .getByRole('button', { name: 'Remover o acesso de Convidada E2E ao workspace' })
      .click();
    await expect(page.getByTestId('efeito-da-remocao')).toContainText(
      'O acesso acaba na próxima requisição',
    );
    await page.getByRole('button', { name: 'Confirmar a remoção do acesso' }).click();
    await expect(page.getByRole('status')).toContainText('não tem mais acesso a este workspace');
    await expect(page.getByRole('row', { name: /Convidada E2E/ })).toHaveCount(0);

    const depois = await convidada.request.get('/api/contacts');
    expect(depois.status()).toBe(401);
    // e a sessão renovada não tem mais este workspace — a pessoa continua com a
    // conta, sem workspace ativo (não foi para o login). A espera vem ANTES do
    // reload: a página renova a sessão (401 → refresh → 200), e só a resposta
    // dela diz que acabou; o link sumido, sozinho, também vale com a tela vazia
    const renovada = convidada.waitForResponse(
      (r) => r.url().endsWith('/api/auth/me') && r.request().method() === 'GET' && r.ok(),
    );
    await convidada.reload();
    const me = await (await renovada).json();
    expect(me.activeMembership).toBeNull();
    await expect(convidada.getByRole('link', { name: 'Contatos', exact: true })).toHaveCount(0);
    await outro.close();

    // a trilha: cada passo, sem o token
    await page.getByRole('link', { name: 'Auditoria', exact: true }).click();
    for (const acao of [
      'invite.created',
      'member.joined',
      'member.role_changed',
      'member.removed',
    ]) {
      await expect(page.getByRole('cell', { name: acao, exact: true }).first()).toBeVisible();
    }
    const token = link.split('#')[1] ?? '';
    expect(token.length).toBeGreaterThan(32);
    await expect(page.locator('body')).not.toContainText(token);
  });
});

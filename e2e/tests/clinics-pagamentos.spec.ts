import { expect, test, type Page, type Route } from '@playwright/test';
import type { Client } from 'pg';
import { OWNER_C } from '../env';
import { login, openE2eDb } from './helpers';

/**
 * Pagamentos de pacotes pela UI (ADR-063, F6.1a e os ajustes), no workspace
 * `clinica`, como Owner. Dados FICTÍCIOS, com nomes únicos por execução; o
 * serviço, o paciente e o pacote com preço nascem direto no banco.
 *
 * O cenário que importa: o servidor GRAVA e a resposta se perde no caminho. A
 * tela guarda o pedido e a `Idempotency-Key`, mesmo com o painel fechado e
 * reaberto; "Tentar de novo" repete a MESMA chave, e o servidor fica com um
 * único lançamento. Enquanto o resultado for incerto, o pacote não aceita outra
 * operação (não há "Descartar"), e as ações só voltam depois de o histórico ser
 * relido com sucesso.
 */

interface Cenario {
  servico: string;
  pacienteId: string;
  pacote: string;
}

const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function cenario(db: Client): Promise<Cenario> {
  const s = sufixo();
  const { rows } = await db.query<{ ws: string; dono: string }>(
    `SELECT w."id" AS ws, m."id" AS dono
       FROM "Workspace" w
       JOIN "Membership" m ON m."workspaceId" = w."id"
       JOIN "User" us ON us."id" = m."userId" AND us."email" = $1
      WHERE w."slug" = 'clinica'`,
    [OWNER_C],
  );
  expect(rows).toHaveLength(1);
  const { ws, dono } = rows[0];
  const um = async (sql: string, params: unknown[]) =>
    (await db.query<{ id: string }>(sql, params)).rows[0].id;
  const servico = `Serviço E2E ${s}`;
  const servicoId = await um(
    `INSERT INTO "ClinicsService" ("id","workspaceId","name","durationMin","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 30, now()) RETURNING "id"`,
    [ws, servico],
  );
  const contato = await um(
    `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
    [ws, `Paciente E2E ${s}`],
  );
  const pacienteId = await um(
    `INSERT INTO "ClinicsPatient" ("id","workspaceId","contactId","createdByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"`,
    [ws, contato, dono],
  );
  // R$ 600,00 de preço total
  const pacote = await um(
    `INSERT INTO "ClinicsPackage" ("id","workspaceId","patientId","serviceId","totalSessions","totalPriceCents","currency","createdByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3, 4, 60000, 'BRL', $4) RETURNING "id"`,
    [ws, pacienteId, servicoId, dono],
  );
  return { servico, pacienteId, pacote };
}

/**
 * Intercepta o POST: o PRIMEIRO vai ao servidor (`route.fetch`), e a resposta
 * é abortada antes de chegar ao navegador; os seguintes seguem normalmente.
 * Guarda a `Idempotency-Key` de cada um.
 */
async function perderAPrimeiraResposta(page: Page, padrao: string): Promise<string[]> {
  const chaves: string[] = [];
  await page.route(padrao, async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    chaves.push((await req.allHeaders())['idempotency-key']);
    if (chaves.length === 1) {
      const resposta = await route.fetch();
      // o servidor respondeu (gravou); o navegador nunca saberá
      expect(resposta.status()).toBe(201);
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  return chaves;
}

async function abrirPainel(page: Page, c: Cenario) {
  await page
    .getByRole('row', { name: `Pacote de ${c.servico}` })
    .getByRole('button', { name: `Pagamentos do pacote de ${c.servico}` })
    .click();
  const painel = page.getByRole('dialog', { name: `Pagamentos · ${c.servico}` });
  await expect(painel).toBeVisible();
  return painel;
}

async function fecharEReabrir(page: Page, c: Cenario) {
  await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return abrirPainel(page, c);
}

test.describe('Clinics — pagamentos de pacotes', () => {
  test('a resposta do registro se perde: a pendência sobrevive a fechar e reabrir, e "Tentar de novo" deixa um único lançamento', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      const lancamentos = async () =>
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM "ClinicsPackagePayment" WHERE "packageId" = $1`,
            [c.pacote],
          )
        ).rows[0].n;
      await login(page, OWNER_C);
      const chaves = await perderAPrimeiraResposta(
        page,
        `**/api/clinics/packages/${c.pacote}/payments`,
      );
      await page.goto(`/clinics/patient?id=${c.pacienteId}&aba=pagamentos`);
      await expect(page.getByRole('row', { name: `Pacote de ${c.servico}` })).toContainText(
        /R\$\s600,00 a receber/,
      );
      let painel = await abrirPainel(page, c);
      await painel.getByRole('button', { name: 'Registrar pagamento' }).click();
      await expect(painel.getByLabel(/Valor recebido/)).toHaveValue('600,00');
      await painel.getByLabel('Forma').selectOption('pix');
      await painel.getByRole('button', { name: 'Revisar pagamento' }).click();
      await painel.getByRole('button', { name: 'Confirmar registro' }).click();

      const pendencia = painel.getByRole('region', { name: 'Registro pendente de confirmação' });
      await expect(pendencia).toContainText(/Pagamento de R\$\s600,00 em pix/);
      await expect(pendencia).toContainText('O resultado não chegou');
      // o servidor gravou, mesmo sem a resposta
      expect(await lancamentos()).toBe('1');

      painel = await fecharEReabrir(page, c);
      await expect(
        painel.getByRole('region', { name: 'Registro pendente de confirmação' }),
      ).toBeVisible();
      await painel.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(painel.getByRole('status')).toHaveText(
        /^Pagamento de R\$\s600,00 registrado\.$/,
      );
      await expect(painel.getByRole('region', { name: /pendente de confirmação/ })).toHaveCount(0);

      // um único lançamento: pela tela, pela API e pelo banco
      const historico = painel.getByRole('region', { name: 'Histórico de pagamentos' });
      await expect(historico.getByRole('listitem')).toHaveCount(1);
      await expect(painel.getByText('Pacote quitado: o recebido cobre o preço.')).toBeVisible();
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toBeDisabled();
      const api = await page.request.get(`/api/clinics/packages/${c.pacote}/payments`);
      expect(api.ok()).toBe(true);
      const corpo = (await api.json()) as {
        payments: unknown[];
        package: { balanceCents: number };
      };
      expect(corpo.payments).toHaveLength(1);
      expect(corpo.package.balanceCents).toBe(0);
      expect(await lancamentos()).toBe('1');
      // as duas requisições, com a MESMA chave
      expect(chaves).toHaveLength(2);
      expect(chaves[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(chaves[1]).toBe(chaves[0]);
    } finally {
      await db.end();
    }
  });

  test('a resposta do registro se perde E a releitura do histórico falha: o pacote fica bloqueado até "Tentar de novo", e as ações só voltam depois da releitura', async ({
    page,
  }) => {
    const db = await openE2eDb();
    // destravado no `finally`, para nenhuma requisição ficar presa no fim
    let soltarLeitura: () => void = () => {};
    try {
      const c = await cenario(db);
      const lancamentos = async () =>
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM "ClinicsPackagePayment" WHERE "packageId" = $1`,
            [c.pacote],
          )
        ).rows[0].n;
      await login(page, OWNER_C);
      // o POST: o primeiro grava e a resposta se perde; os seguintes seguem.
      // A leitura do painel (GET do mesmo caminho) falha enquanto `leituraFalha`
      // e espera `segurarLeitura`, quando houver.
      const estado: { leituraFalha: boolean; segurarLeitura: Promise<void> | null } = {
        leituraFalha: false,
        segurarLeitura: null,
      };
      const chaves: string[] = [];
      await page.route(`**/api/clinics/packages/${c.pacote}/payments`, async (route: Route) => {
        const req = route.request();
        if (req.method() === 'POST') {
          chaves.push((await req.allHeaders())['idempotency-key']);
          if (chaves.length === 1) {
            const resposta = await route.fetch();
            expect(resposta.status()).toBe(201);
            return route.abort('connectionreset');
          }
          return route.continue();
        }
        if (estado.leituraFalha) return route.abort('connectionreset');
        if (estado.segurarLeitura) await estado.segurarLeitura;
        return route.continue();
      });
      await page.goto(`/clinics/patient?id=${c.pacienteId}&aba=pagamentos`);
      const linha = page.getByRole('row', { name: `Pacote de ${c.servico}` });
      await expect(linha).toContainText(/R\$\s600,00 a receber/);
      let painel = await abrirPainel(page, c);
      await painel.getByRole('button', { name: 'Registrar pagamento' }).click();
      await painel.getByLabel(/Valor recebido/).fill('200,00');
      await painel.getByLabel('Forma').selectOption('pix');
      await painel.getByRole('button', { name: 'Revisar pagamento' }).click();
      // a partir daqui, a releitura do histórico também falha
      estado.leituraFalha = true;
      await painel.getByRole('button', { name: 'Confirmar registro' }).click();

      const pendencia = painel.getByRole('region', { name: 'Registro pendente de confirmação' });
      await expect(pendencia).toContainText(/Pagamento de R\$\s200,00 em pix/);
      await expect(pendencia).toContainText('o pagamento pode já ter sido registrado');
      await expect(pendencia.getByRole('button')).toHaveText(['Tentar de novo']);
      await expect(
        painel.getByText('Não foi possível carregar os pagamentos do pacote.'),
      ).toBeVisible();
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);
      expect(await lancamentos()).toBe('1');

      // fechado e reaberto, com a leitura ainda falhando: nada de novo lançamento
      painel = await fecharEReabrir(page, c);
      await expect(
        painel.getByRole('region', { name: 'Registro pendente de confirmação' }),
      ).toBeVisible();
      await expect(
        painel.getByText('Não foi possível carregar os pagamentos do pacote.'),
      ).toBeVisible();
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);
      await expect(painel.getByRole('button', { name: /^Anular/ })).toHaveCount(0);
      // com o painel fechado, a linha da lista mostra o caminho de volta
      await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(linha).toContainText('Operação pendente de confirmação');

      // a rede volta: o histórico relido (já com o lançamento) não resolve nada
      estado.leituraFalha = false;
      painel = await abrirPainel(page, c);
      await expect(
        painel.getByRole('region', { name: 'Histórico de pagamentos' }).getByRole('listitem'),
      ).toHaveCount(1);
      await expect(
        painel.getByRole('region', { name: 'Registro pendente de confirmação' }),
      ).toBeVisible();
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);
      await expect(painel.getByRole('button', { name: /^Anular/ })).toHaveCount(0);

      // "Tentar de novo" (a mesma chave) resolve; a releitura é segurada: até
      // ela chegar, as ações continuam fora
      estado.segurarLeitura = new Promise<void>((r) => {
        soltarLeitura = r;
      });
      await painel.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(painel.getByText('Atualizando o histórico e o saldo…')).toBeVisible();
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toHaveCount(0);
      expect(chaves).toHaveLength(2);
      estado.segurarLeitura = null;
      soltarLeitura();

      await expect(painel.getByRole('status')).toHaveText(
        /^Pagamento de R\$\s200,00 registrado\.$/,
      );
      await expect(painel.getByRole('region', { name: /pendente de confirmação/ })).toHaveCount(0);
      await expect(painel.getByRole('button', { name: 'Registrar pagamento' })).toBeEnabled();
      await expect(
        painel.getByRole('region', { name: 'Histórico de pagamentos' }).getByRole('listitem'),
      ).toHaveCount(1);
      await page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
      await expect(linha).toContainText(/R\$\s400,00 a receber/);
      await expect(linha).not.toContainText('Operação pendente de confirmação');

      // um único lançamento: pela API e pelo banco; as duas requisições na MESMA chave
      const api = await page.request.get(`/api/clinics/packages/${c.pacote}/payments`);
      expect(api.ok()).toBe(true);
      const corpo = (await api.json()) as {
        payments: unknown[];
        package: { balanceCents: number };
      };
      expect(corpo.payments).toHaveLength(1);
      expect(corpo.package.balanceCents).toBe(40000);
      expect(await lancamentos()).toBe('1');
      expect(chaves[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(chaves[1]).toBe(chaves[0]);
    } finally {
      soltarLeitura();
      await db.end();
    }
  });

  test('a resposta da anulação se perde: "Tentar de novo" repete a mesma chave e anula uma vez', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO "ClinicsPackagePayment" ("id","workspaceId","packageId","amountCents","currency","receivedOn","method","createdByMembershipId")
         SELECT gen_random_uuid(), p."workspaceId", p."id", 20000, 'BRL', CURRENT_DATE - 1, 'cash', p."createdByMembershipId"
           FROM "ClinicsPackage" p WHERE p."id" = $1
         RETURNING "id"`,
        [c.pacote],
      );
      const pagamento = rows[0].id;
      const anulacoes = async () =>
        (
          await db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM "ClinicsPackagePaymentVoid" WHERE "paymentId" = $1`,
            [pagamento],
          )
        ).rows[0].n;
      await login(page, OWNER_C);
      const chaves = await perderAPrimeiraResposta(
        page,
        `**/api/clinics/package-payments/${pagamento}/void`,
      );
      await page.goto(`/clinics/patient?id=${c.pacienteId}&aba=pagamentos`);
      let painel = await abrirPainel(page, c);
      await painel.getByRole('button', { name: /^Anular o pagamento de R\$\s200,00/ }).click();
      await painel.getByLabel('Motivo').selectOption('duplicate');
      await painel.getByRole('button', { name: 'Confirmar anulação' }).click();
      await expect(
        painel.getByRole('region', { name: 'Anulação pendente de confirmação' }),
      ).toContainText('motivo: duplicado');
      expect(await anulacoes()).toBe('1');

      painel = await fecharEReabrir(page, c);
      await painel.getByRole('button', { name: 'Tentar de novo' }).click();
      await expect(painel.getByRole('status')).toHaveText(/anulado\.$/);
      await expect(painel.getByText(/^anulado por .+, motivo: duplicado$/)).toBeVisible();
      expect(await anulacoes()).toBe('1');
      expect(chaves).toHaveLength(2);
      expect(chaves[1]).toBe(chaves[0]);
    } finally {
      await db.end();
    }
  });
});

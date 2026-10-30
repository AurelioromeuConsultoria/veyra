import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { E2E_WEB_ORIGIN, OWNER_C, PROF_C } from '../env';
import { abrirNoMenu, login, openE2eDb } from './helpers';

/**
 * O envio da clínica, o vínculo com a oportunidade e as métricas pela UI (F4.4,
 * ADR-048 adendos 8 a 10), no workspace `clinica`. Dados FICTÍCIOS, com nomes
 * e números únicos por execução. A finalidade, o consentimento, o canal e a
 * versão revisada nascem direto no banco: o registro da versão lê a Meta, que
 * o e2e não tem. Pela mesma razão a aprovação é RECUSADA aqui — a releitura na
 * Meta falha — e nada sai: o fluxo aprovado e o despacho estão nos testes de
 * integração; aqui se prova a tela até a prévia, a recusa com o motivo e o
 * acompanhamento, sem nenhum evento inventado.
 */

const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const digitos = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

interface Cenario {
  ws: string;
  amanha: string;
  dono: string;
  paciente: string;
  contato: string;
  profissional: string;
  numero: string;
  /** o rótulo exato da opção: canal · template (idioma) versão · finalidade */
  opcao: string;
  texto: string;
}

const um = async (db: Client, sql: string, params: unknown[]) =>
  (await db.query<{ id: string }>(sql, params)).rows[0].id;

/**
 * O paciente com um agendamento AMANHÃ às 10:00 locais (longe das duas horas
 * que encerram a confirmação), e a finalidade da confirmação com o conteúdo
 * mínimo, o consentimento do número e uma versão revisada para ela.
 */
async function cenario(db: Client): Promise<Cenario> {
  const s = sufixo();
  const { rows } = await db.query<{
    ws: string;
    unidade: string;
    fuso: string;
    amanha: string;
    dono: string;
  }>(
    `SELECT w."id" AS ws, u."id" AS unidade, u."timezone" AS fuso,
            to_char((now() AT TIME ZONE u."timezone")::date + 1, 'YYYY-MM-DD') AS amanha,
            m."id" AS dono
       FROM "Workspace" w
       JOIN "ClinicsUnit" u ON u."workspaceId" = w."id" AND u."archivedAt" IS NULL
       JOIN "Membership" m ON m."workspaceId" = w."id"
       JOIN "User" us ON us."id" = m."userId" AND us."email" = $1
      WHERE w."slug" = 'clinica'`,
    [OWNER_C],
  );
  expect(rows).toHaveLength(1);
  const { ws, unidade, fuso, amanha, dono } = rows[0];

  const servico = await um(
    db,
    `INSERT INTO "ClinicsService" ("id","workspaceId","name","durationMin","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 30, now()) RETURNING "id"`,
    [ws, `Serviço Envio ${s}`],
  );
  const profissional = `Prof Envio ${s}`;
  const profissionalId = await um(
    db,
    `INSERT INTO "ClinicsProfessional" ("id","workspaceId","name","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
    [ws, profissional],
  );
  await db.query(
    `INSERT INTO "ClinicsProfessionalService" ("id","workspaceId","professionalId","serviceId")
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [ws, profissionalId, servico],
  );
  for (let semana = 1; semana <= 7; semana++) {
    await db.query(
      `INSERT INTO "ClinicsWorkingHours" ("id","workspaceId","professionalId","unitId","weekday","startMinute","endMinute")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 1440)`,
      [ws, profissionalId, unidade, semana],
    );
  }
  // fictício pelo prefixo fixo (`+55119000…`), e único desta execução: a
  // coincidência pelos 8 últimos dígitos não acha outro contato
  const numero = `+55119000${digitos(5)}`;
  const paciente = `Paciente Envio ${s}`;
  const contato = await um(
    db,
    `INSERT INTO "Contact" ("id","workspaceId","name","phones","phonesNormalized","phoneMatchKeys","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, ARRAY[$3], ARRAY[$3], ARRAY[right($3, 8)], now())
     RETURNING "id"`,
    [ws, paciente, numero],
  );
  const pacienteId = await um(
    db,
    `INSERT INTO "ClinicsPatient" ("id","workspaceId","contactId","createdByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"`,
    [ws, contato, dono],
  );
  await db.query(
    `INSERT INTO "ClinicsAppointment"
       ("id","workspaceId","patientId","professionalId","serviceId","unitId","startsAt","endsAt","status","createdByMembershipId","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
             ($6::date + time '10:00') AT TIME ZONE $7,
             ($6::date + time '10:30') AT TIME ZONE $7,
             'scheduled', $8, now())`,
    [ws, pacienteId, profissionalId, servico, unidade, amanha, fuso, dono],
  );

  // o canal, com a credencial: o token é fictício e não decifra — a releitura falha
  const nomeDoCanal = `WhatsApp Envio ${s}`;
  const canal = await um(
    db,
    `INSERT INTO "Channel" ("id","workspaceId","type","name")
     VALUES (gen_random_uuid(), $1, 'whatsapp', $2) RETURNING "id"`,
    [ws, nomeDoCanal],
  );
  await db.query(
    `INSERT INTO "ChannelCredential" ("channelId","workspaceId","phoneNumberId","businessAccountId","tokenCipher","updatedAt")
     VALUES ($1, $2, $3, $4, 'token-ficticio-que-nao-decifra', now())`,
    [canal, ws, digitos(15), digitos(15)],
  );
  // a finalidade da confirmação: a versão seguinte, se outra execução já criou uma
  const finalidade = await um(
    db,
    `INSERT INTO "ConsentPurpose" ("id","workspaceId","key","version","description","category","fields")
     SELECT gen_random_uuid(), $1, 'clinics_confirmacao', COALESCE(max("version"), 0) + 1,
            'Confirmação de horário (e2e)', 'utility',
            ARRAY['contato.primeiro_nome','clinics.data','clinics.hora']
       FROM "ConsentPurpose" WHERE "workspaceId" = $1 AND "key" = 'clinics_confirmacao'
     RETURNING "id"`,
    [ws],
  );
  await db.query(
    `INSERT INTO "Consent" ("id","workspaceId","contactId","channelId","number","purposeId","origin","receipt","purposeDescription","grantedByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'in_person', $6, 'Confirmação de horário (e2e)', $7)`,
    [ws, contato, canal, numero, finalidade, `CON-E2E-${s}`, dono],
  );
  const template = `confirmacao_e2e_${s}`;
  const corpo = 'Ola {{1}}, confirma o seu horario em {{2}} as {{3}}?';
  const versao = await um(
    db,
    `INSERT INTO "MessageTemplateVersion"
       ("id","workspaceId","channelId","businessAccountId","metaTemplateId","name","language","version","category","parameterFormat","components","bindings","contentHash")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pt_BR', 1, 'utility', 'positional', $6::jsonb, $7::jsonb, $8)
     RETURNING "id"`,
    [
      ws,
      canal,
      digitos(15),
      digitos(15),
      template,
      JSON.stringify([{ type: 'body', text: corpo }]),
      JSON.stringify({
        'body.1': 'contato.primeiro_nome',
        'body.2': 'clinics.data',
        'body.3': 'clinics.hora',
      }),
      // fixo e consistente com a revisão: o e2e não recalcula a forma canônica
      createHash('sha256').update(`${template}:${corpo}`).digest('hex'),
    ],
  );
  await db.query(
    `INSERT INTO "TemplateReview" ("id","workspaceId","templateVersionId","purposeId","contentHash","reviewedByMembershipId")
     SELECT gen_random_uuid(), $1, $2, $3, v."contentHash", $4
       FROM "MessageTemplateVersion" v WHERE v."id" = $2`,
    [ws, versao, finalidade, dono],
  );
  const [ano, mes, dia] = amanha.split('-');
  return {
    ws,
    amanha,
    dono,
    paciente,
    contato,
    profissional,
    numero,
    opcao: `${nomeDoCanal} · ${template} (pt_BR) v1 · Confirmação de horário (e2e)`,
    texto: `Ola Paciente, confirma o seu horario em ${dia}/${mes}/${ano} as 10:00?`,
  };
}

const quando = (c: Cenario) => {
  const [ano, mes, dia] = c.amanha.split('-');
  return `${dia}/${mes}/${ano} 10:00`;
};

/** As métricas do envio: Indicadores › Envios, no menu da clínica (ADR-055, E-3). */
async function abrirMetricas(page: Page, email: string) {
  await login(page, email);
  await abrirNoMenu(page, 'Indicadores', 'Envios');
  await expect(page.getByRole('heading', { name: 'Métricas do envio', level: 1 })).toBeVisible();
}

test.describe('Clinics — envios, oportunidade e métricas', () => {
  test('candidato, pedido e a prévia com o conteúdo mínimo; a aprovação sem a Meta é recusada, e o pedido continua preparado', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await login(page, OWNER_C);
      // a resposta do transporte ANTES de afirmar: sem ela, o aviso ainda não teria aparecido
      const transporte = page.waitForResponse(
        (r) => r.url().endsWith('/api/clinics/outreach/transport') && r.ok(),
      );
      await abrirNoMenu(page, 'Acompanhamento', 'Confirmações e reativações');
      expect(await (await transporte).json()).toEqual({ simulated: false });
      // fora de staging o transporte não é o falso: sem o aviso de simulado
      await expect(page.getByTestId('envio-simulado')).toHaveCount(0);

      await page.getByRole('checkbox', { name: `Escolher ${c.paciente}, ${quando(c)}` }).check();
      await page.getByLabel('Template revisado').selectOption({ label: c.opcao });
      await page.getByRole('button', { name: /^Preparar e ver a prévia/ }).click();

      const previa = page.getByTestId('previa-da-clinica');
      // o texto exato, com o primeiro nome só: o sobrenome não entra na mensagem
      await expect(previa).toContainText(c.texto);

      await previa.getByRole('button', { name: 'Aprovar e enviar (1)' }).click();
      await expect(page.getByRole('status').last()).toContainText(
        'Recusado: não foi possível reler o template na Meta',
      );
      // nada saiu: o pedido segue preparado, sem mensagem
      const { rows } = await db.query<{ aprovacoes: number }>(
        `SELECT count(*)::int AS aprovacoes FROM "OutboundApproval" WHERE "contactId" = $1`,
        [c.contato],
      );
      expect(rows[0].aprovacoes).toBe(0);

      const acompanhar = page.getByRole('button', { name: `Acompanhar o pedido de ${c.paciente}` });
      await expect(acompanhar).toHaveText('Preparado: aguarda a prévia e a aprovação');
      await acompanhar.click();
      const detalhe = page.getByTestId('detalhe-do-pedido');
      await expect(detalhe).toContainText('Confirmação de horário');
      // o texto da prévia mora no pedido até o desfecho
      await expect(detalhe).toContainText(c.texto);
    } finally {
      await db.end();
    }
  });

  test('o vínculo com a oportunidade pela agenda e as métricas sem dados, sem nada virar zero', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await login(page, OWNER_C);
      const csrf = (await page.context().cookies()).find((k) => k.name === 'veyra_csrf')?.value;
      expect(csrf).toBeTruthy();
      const titulo = `Oportunidade ${c.paciente}`;
      const deal = await page.request.post('/api/deals', {
        data: { title: titulo, contactId: c.contato },
        headers: { Origin: E2E_WEB_ORIGIN, 'x-csrf-token': csrf as string },
      });
      expect(deal.ok()).toBe(true);
      const { id: dealId } = (await deal.json()) as { id: string };

      await page.goto(`/clinics/agenda?dia=${c.amanha}`);
      const quem = `10:00 ${c.paciente} (${c.profissional})`;
      await page.getByRole('button', { name: `Oportunidade: ${quem}` }).click();
      const painel = page.getByTestId('vinculo-com-oportunidade');
      await expect(painel).toContainText('Nenhuma.');
      await painel.getByLabel('Vincular a').selectOption(dealId);
      await painel.getByRole('button', { name: 'Vincular' }).click();
      await expect(painel).toContainText(titulo);
      await expect(painel.getByLabel('Trocar por')).toBeVisible();

      await page.goto('/clinics/outreach-metrics');
      const funil = page.getByRole('region', { name: 'Funil da confirmação' });
      // nada foi enviado no e2e: a entrega é "Sem dados", nunca 0
      const entregues = funil.locator('[data-status]').filter({ hasText: 'Entregues' });
      await expect(entregues).toHaveAttribute('data-status', 'no_data');
      await expect(entregues).toContainText('Sem dados');
      await expect(page.getByTestId('situacao-da-conversao')).toContainText('Em apuração');
    } finally {
      await db.end();
    }
  });

  test('`Profissional` não vê os envios nem a conversão, e a resposta é omitida, não zerada', async ({
    page,
  }) => {
    await abrirMetricas(page, PROF_C);
    const funil = page.getByRole('region', { name: 'Funil da confirmação' });
    const resposta = funil
      .locator('[data-status]')
      .filter({ hasText: 'Com resposta atribuível ao paciente' });
    await expect(resposta).toHaveAttribute('data-status', 'omitted');
    await expect(resposta).toContainText('Omitida');
    await expect(page.getByTestId('conversao-sem-acesso')).toBeVisible();

    // sem TODAS as chaves da tela, o menu não oferece os envios (ADR-055,
    // adendo 4); a URL direta continua só explicando
    await expect(
      page
        .getByRole('navigation', { name: 'Principal' })
        .getByRole('link', { name: 'Confirmações e reativações' }),
    ).toHaveCount(0);
    await page.goto('/clinics/outreach');
    await expect(page.getByText(/Os envios mostram o número do paciente/)).toBeVisible();
  });
});

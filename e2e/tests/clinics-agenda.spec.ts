import { expect, test, type Page } from '@playwright/test';
import type { Client } from 'pg';
import { MEMBER_C, OWNER_A, OWNER_C, PROF_C } from '../env';
import { login, openE2eDb } from './helpers';

/**
 * Agenda e atendimento do Veyra Clinics pela UI (F2.3, ADR-048 adendo 5), no
 * workspace `clinica`. Dados FICTÍCIOS, com nomes únicos por execução. O
 * catálogo e o paciente nascem direto no banco: as telas deles já têm e2e
 * próprios. Expediente de 24 h em todos os dias, para não depender da hora.
 * O DIA vem do banco, no fuso da UNIDADE, e vai na URL: nem o relógio do
 * navegador nem a virada do dia no meio do teste decidem qual agenda a tela mostra.
 */

interface Cenario {
  ws: string;
  dia: string;
  fuso: string;
  unidade: string;
  dono: string;
  servico: string;
  servicoId: string;
  profissional: string;
  profissionalId: string;
  paciente: string;
  pacienteId: string;
}

const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

interface Clinica {
  ws: string;
  unidade: string;
  fuso: string;
  dia: string;
}

/** O workspace `clinica`, a unidade ativa, o fuso DELA e o "hoje" nesse fuso. */
async function workspaceDaClinica(db: Client): Promise<Clinica> {
  const { rows } = await db.query<Clinica>(
    `SELECT w."id" AS ws, u."id" AS unidade, u."timezone" AS fuso,
            to_char((now() AT TIME ZONE u."timezone")::date, 'YYYY-MM-DD') AS dia
       FROM "Workspace" w
       JOIN "ClinicsUnit" u ON u."workspaceId" = w."id" AND u."archivedAt" IS NULL
      WHERE w."slug" = 'clinica'`,
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function cenario(db: Client): Promise<Cenario> {
  const s = sufixo();
  const { ws, dia, fuso, unidade } = await workspaceDaClinica(db);
  const { rows } = await db.query<{ dono: string }>(
    `SELECT m."id" AS dono
       FROM "Membership" m
       JOIN "User" us ON us."id" = m."userId" AND us."email" = $2
      WHERE m."workspaceId" = $1`,
    [ws, OWNER_C],
  );
  const { dono } = rows[0];
  const um = async (sql: string, params: unknown[]) =>
    (await db.query<{ id: string }>(sql, params)).rows[0].id;
  const servico = `Serviço E2E ${s}`;
  const servicoId = await um(
    `INSERT INTO "ClinicsService" ("id","workspaceId","name","durationMin","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 30, now()) RETURNING "id"`,
    [ws, servico],
  );
  const profissional = `Prof E2E ${s}`;
  const profissionalId = await um(
    `INSERT INTO "ClinicsProfessional" ("id","workspaceId","name","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
    [ws, profissional],
  );
  await db.query(
    `INSERT INTO "ClinicsProfessionalService" ("id","workspaceId","professionalId","serviceId")
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [ws, profissionalId, servicoId],
  );
  for (let semana = 1; semana <= 7; semana++) {
    await db.query(
      `INSERT INTO "ClinicsWorkingHours" ("id","workspaceId","professionalId","unitId","weekday","startMinute","endMinute")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 1440)`,
      [ws, profissionalId, unidade, semana],
    );
  }
  const paciente = `Paciente E2E ${s}`;
  const contato = await um(
    `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
    [ws, paciente],
  );
  const pacienteId = await um(
    `INSERT INTO "ClinicsPatient" ("id","workspaceId","contactId","createdByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"`,
    [ws, contato, dono],
  );
  return {
    ws,
    dia,
    fuso,
    unidade,
    dono,
    servico,
    servicoId,
    profissional,
    profissionalId,
    paciente,
    pacienteId,
  };
}

/** Agendamento direto no banco, no DIA do cenário, na hora local da unidade. */
async function agendamentoNoDia(db: Client, c: Cenario, hora: string, status = 'scheduled') {
  await db.query(
    `INSERT INTO "ClinicsAppointment"
       ("id","workspaceId","patientId","professionalId","serviceId","unitId","startsAt","endsAt","status","createdByMembershipId","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
             ($6::date + $7::time) AT TIME ZONE $8,
             ($6::date + $7::time + interval '30 minutes') AT TIME ZONE $8,
             $9::"ClinicsAppointmentStatus", $10, now())`,
    [
      c.ws,
      c.pacienteId,
      c.profissionalId,
      c.servicoId,
      c.unidade,
      c.dia,
      hora,
      c.fuso,
      status,
      c.dono,
    ],
  );
}

async function abrirAgenda(page: Page, email: string, dia: string) {
  await login(page, email);
  await page.goto(`/clinics/agenda?dia=${dia}`);
  await expect(page.getByRole('heading', { name: 'Agenda da clínica', level: 1 })).toBeVisible();
}

const daAgendaDoDia = (dia: string) => (r: { url(): string; request(): { method(): string } }) =>
  r.request().method() === 'GET' && r.url().includes(`/api/clinics/appointments?date=${dia}`);

/** Cartão e ações se identificam por hora, paciente e profissional. */
const quem = (hora: string, c: Cenario) => `${hora} ${c.paciente} (${c.profissional})`;
const cartao = (page: Page, hora: string, c: Cenario) =>
  page.getByRole('article', { name: `Agendamento ${quem(hora, c)}` });

async function preencherAgendamento(page: Page, c: Cenario) {
  const drawer = page.getByRole('dialog', { name: 'Agendar' });
  await drawer.getByLabel(/^Buscar paciente/).fill(c.paciente);
  await drawer.getByRole('radio', { name: c.paciente }).check();
  await drawer.getByLabel(/^Serviço/).selectOption({ label: `${c.servico} · 30 min` });
  await drawer.getByLabel(/^Profissional/).selectOption({ label: c.profissional });
  const horario = drawer.getByLabel(/^Horário/);
  await horario.selectOption({ index: 1 }); // o primeiro livre
  return { drawer, hora: (await horario.inputValue()).split('|')[0] };
}

test.describe('Clinics — agenda da clínica', () => {
  test('recepção agenda pela tela, e o conflito (alguém ocupou o horário no meio) é recusado com o motivo', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await abrirAgenda(page, MEMBER_C, c.dia);

      await page.getByRole('button', { name: 'Agendar' }).click();
      const primeiro = await preencherAgendamento(page, c);
      expect(primeiro.hora).toBe('00:00');
      await primeiro.drawer.getByRole('button', { name: 'Agendar' }).click();
      const coluna = page.getByRole('region', { name: `Agenda de ${c.profissional}` });
      await expect(cartao(page, '00:00', c)).toBeVisible();
      await expect(coluna).toContainText('Marcado');

      // de novo; enquanto o drawer está aberto, outra pessoa ocupa o horário escolhido
      await page.getByRole('button', { name: 'Agendar' }).click();
      const segundo = await preencherAgendamento(page, c);
      expect(segundo.hora).not.toBe('00:00'); // o horário já ocupado não é oferecido
      await agendamentoNoDia(db, c, segundo.hora);
      await segundo.drawer.getByRole('button', { name: 'Agendar' }).click();
      await expect(segundo.drawer.getByRole('alert')).toContainText(
        'Horário já ocupado para este profissional',
      );
    } finally {
      await db.end();
    }
  });

  test('`Profissional` registra o atendimento e recebe o vínculo; a recepção vê "Atendido", sem o vínculo e sem a ação', async ({
    page,
    browser,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await agendamentoNoDia(db, c, '22:00', 'confirmed');

      const antes = page.waitForResponse(daAgendaDoDia(c.dia));
      await abrirAgenda(page, PROF_C, c.dia);
      const lista = (await (await antes).json()) as Record<string, unknown>[];
      // quem lê atendimento recebe o campo — ainda vazio
      expect(lista.find((a) => a.patientName === c.paciente)).toHaveProperty('attendanceId', null);
      await expect(page.getByRole('button', { name: 'Agendar' })).toHaveCount(0);

      const comVinculo = page.waitForResponse(async (r) => {
        if (!daAgendaDoDia(c.dia)(r)) return false;
        const depois = (await r.json()) as Record<string, unknown>[];
        const meu = depois.find((a) => a.patientName === c.paciente);
        return typeof meu?.attendanceId === 'string';
      });
      const doProfissional = cartao(page, '22:00', c);
      await doProfissional
        .getByRole('button', { name: `Registrar atendimento: ${quem('22:00', c)}` })
        .click();
      // a escolha é explícita (F3.3b): sem pacote do paciente, só "avulso"
      const escolha = page.getByRole('dialog', { name: 'Registrar atendimento' });
      await escolha.getByLabel('Avulso (sem pacote)').check();
      await escolha.getByRole('button', { name: 'Registrar atendimento avulso' }).click();
      await expect(escolha.getByRole('status')).toHaveText('Atendimento registrado como avulso.');
      await escolha.getByRole('button', { name: 'Concluir' }).click();
      await expect(doProfissional).toContainText('Atendido');
      await comVinculo;

      const recepcao = await browser.newPage();
      try {
        const resposta = recepcao.waitForResponse(daAgendaDoDia(c.dia));
        await abrirAgenda(recepcao, MEMBER_C, c.dia);
        const daRecepcao = (await (await resposta).json()) as Record<string, unknown>[];
        expect(daRecepcao.some((a) => a.patientName === c.paciente)).toBe(true);
        // autorização de campo: o vínculo nem chega para quem não lê atendimento
        expect(daRecepcao.some((a) => 'attendanceId' in a)).toBe(false);
        const cartaoDaRecepcao = cartao(recepcao, '22:00', c);
        await expect(cartaoDaRecepcao).toContainText('Atendido');
        await expect(
          cartaoDaRecepcao.getByRole('button', { name: /Registrar atendimento/ }),
        ).toHaveCount(0);
      } finally {
        await recepcao.close();
      }
      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "ClinicsAttendance" a
           JOIN "ClinicsAppointment" ag ON ag."id" = a."appointmentId"
          WHERE ag."professionalId" = $1`,
        [c.profissionalId],
      );
      expect(rows[0].n).toBe('1');
    } finally {
      await db.end();
    }
  });

  test('novo paciente: as consequências aparecem antes de confirmar', async ({ page }) => {
    const db = await openE2eDb();
    try {
      const { ws } = await workspaceDaClinica(db);
      const nome = `Contato Paciente ${sufixo()}`;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO "Contact" ("id","workspaceId","name","updatedAt")
         VALUES (gen_random_uuid(), $1, $2, now()) RETURNING "id"`,
        [ws, nome],
      );
      await login(page, MEMBER_C, 'Pacientes');
      await page.getByRole('button', { name: 'Novo paciente' }).click();
      const drawer = page.getByRole('dialog', { name: 'Novo paciente' });
      const consequencias = drawer.getByRole('region', { name: 'Consequências' });
      await expect(consequencias).toContainText('A inteligência deixa de ler este contato');
      await expect(consequencias).toContainText('não pode ser excluído enquanto for paciente');
      await drawer.getByLabel(/^Buscar contato/).fill(nome);
      await drawer.getByRole('radio', { name: nome }).check();
      await drawer.getByRole('button', { name: 'Tornar paciente' }).click();
      await expect(page.getByRole('cell', { name: nome, exact: true })).toBeVisible();
      const perfil = await db.query(`SELECT 1 FROM "ClinicsPatient" WHERE "contactId" = $1`, [
        rows[0].id,
      ]);
      expect(perfil.rowCount).toBe(1);
    } finally {
      await db.end();
    }
  });

  test('workspace SEM o Clinics: as URLs diretas só explicam, nada do vertical é consultado, e a lateral não tem as seções', async ({
    page,
  }) => {
    const consultas: string[] = [];
    page.on('request', (r) => {
      // tudo do vertical, menos o status: é ele que diz que o Clinics não está ativo
      if (/\/api\/clinics\/(?!status)/.test(r.url())) consultas.push(r.url());
    });
    await login(page, OWNER_A);
    for (const caminho of ['/clinics/agenda', '/clinics/patients']) {
      await page.goto(caminho);
      await expect(page.getByText('O Clinics não está ativo neste workspace.')).toBeVisible();
    }
    const lateral = page.getByRole('navigation', { name: 'Principal' });
    await expect(lateral.getByRole('link', { name: 'Agenda da clínica' })).toHaveCount(0);
    await expect(lateral.getByRole('link', { name: 'Pacientes' })).toHaveCount(0);
    await expect(lateral.getByRole('link', { name: 'Agenda', exact: true })).toBeVisible(); // a do Core
    expect(consultas).toEqual([]);
  });
});

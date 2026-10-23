import { expect, test, type Page } from '@playwright/test';
import type { Client } from 'pg';
import { E2E_PASSWORD_HASH, E2E_WEB_ORIGIN, MEMBER_C, OWNER_A, OWNER_C, PROF_C } from '../env';
import { login, openE2eDb } from './helpers';

/**
 * Continuidade do Veyra Clinics pela UI (F3.3b; ADR-048 adendo 7 e as
 * condições da aprovação da F3.3), no workspace `clinica`. Dados FICTÍCIOS,
 * com nomes únicos por execução; o catálogo e o paciente nascem direto no
 * banco. O DIA vem do banco, no fuso da unidade.
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

async function cenario(db: Client, intervalo: number | null = null): Promise<Cenario> {
  const s = sufixo();
  const { rows } = await db.query<{
    ws: string;
    unidade: string;
    fuso: string;
    dia: string;
    dono: string;
  }>(
    `SELECT w."id" AS ws, u."id" AS unidade, u."timezone" AS fuso,
            to_char((now() AT TIME ZONE u."timezone")::date, 'YYYY-MM-DD') AS dia, m."id" AS dono
       FROM "Workspace" w
       JOIN "ClinicsUnit" u ON u."workspaceId" = w."id" AND u."archivedAt" IS NULL
       JOIN "Membership" m ON m."workspaceId" = w."id"
       JOIN "User" us ON us."id" = m."userId" AND us."email" = $1
      WHERE w."slug" = 'clinica'`,
    [OWNER_C],
  );
  expect(rows).toHaveLength(1);
  const { ws, unidade, fuso, dia, dono } = rows[0];
  const um = async (sql: string, params: unknown[]) =>
    (await db.query<{ id: string }>(sql, params)).rows[0].id;
  const servico = `Serviço E2E ${s}`;
  const servicoId = await um(
    `INSERT INTO "ClinicsService" ("id","workspaceId","name","durationMin","returnIntervalDays","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 30, $3, now()) RETURNING "id"`,
    [ws, servico, intervalo],
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

/** Agendamento direto no banco, num dia LOCAL da unidade (`dias` depois de hoje). */
async function agendamento(
  db: Client,
  c: Cenario,
  hora: string,
  status = 'scheduled',
  dias = 0,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO "ClinicsAppointment"
       ("id","workspaceId","patientId","professionalId","serviceId","unitId","startsAt","endsAt","status","createdByMembershipId","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
             (($6::date + $11::int) + $7::time) AT TIME ZONE $8,
             (($6::date + $11::int) + $7::time + interval '30 minutes') AT TIME ZONE $8,
             $9::"ClinicsAppointmentStatus", $10, now())
     RETURNING "id"`,
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
      dias,
    ],
  );
  return rows[0].id;
}

const somarDias = (dia: string, n: number) => {
  const [a, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
};
const dataCurta = (dia: string) => dia.split('-').reverse().join('/');

const quem = (hora: string, c: Cenario) => `${hora} ${c.paciente} (${c.profissional})`;

async function registrarNaAgenda(
  page: Page,
  c: Cenario,
  dia: string,
  hora: string,
  escolha: { pacote: RegExp; botao: RegExp } | 'avulso',
) {
  await page.goto(`/clinics/agenda?dia=${dia}`);
  const cartao = page.getByRole('article', { name: `Agendamento ${quem(hora, c)}` });
  await cartao.getByRole('button', { name: `Registrar atendimento: ${quem(hora, c)}` }).click();
  const painel = page.getByRole('dialog', { name: 'Registrar atendimento' });
  // nada vem marcado, e não se confirma sem escolher
  await expect(painel.getByRole('button', { name: 'Escolha avulso ou um pacote' })).toBeDisabled();
  for (const radio of await painel.getByRole('radio').all()) await expect(radio).not.toBeChecked();
  if (escolha === 'avulso') {
    await painel.getByLabel('Avulso (sem pacote)').check();
    await painel.getByRole('button', { name: 'Registrar atendimento avulso' }).click();
  } else {
    await painel.getByLabel(escolha.pacote).check();
    await painel.getByRole('button', { name: escolha.botao }).click();
  }
  await expect(cartao).toContainText('Atendido');
}

test.describe('Clinics — continuidade (pacotes, retornos e faltas)', () => {
  test('o profissional cria o pacote na ficha e registra o atendimento ESCOLHENDO o pacote: o saldo cai de 10 para 9, uma vez só', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await agendamento(db, c, '22:00', 'confirmed');
      await login(page, PROF_C);
      await page.goto(`/clinics/patient?id=${c.pacienteId}`);
      await expect(page.getByRole('heading', { name: c.paciente, level: 1 })).toBeVisible();
      const pacotes = page.getByRole('region', { name: 'Pacotes do paciente' });
      await pacotes.getByRole('button', { name: 'Novo pacote' }).click();
      const novo = page.getByRole('dialog', { name: 'Novo pacote' });
      await novo.getByLabel('Serviço').selectOption({ label: c.servico });
      await novo.getByLabel(/Total de sessões/).fill('10');
      await novo.getByLabel(/Preço total/).fill('1.500,50');
      await novo.getByRole('button', { name: 'Revisar pacote' }).click();
      await expect(novo).toContainText('ficam congelados');
      await novo.getByRole('button', { name: 'Confirmar e criar pacote' }).click();
      const linha = pacotes.getByRole('row', { name: `Pacote de 10 sessões de ${c.servico}` });
      await expect(linha).toContainText('0 de 10');

      await registrarNaAgenda(page, c, c.dia, '22:00', {
        pacote: /^Pacote de 10 sessões, criado em .+: restam 10, ficam 9 depois deste atendimento$/,
        botao: /^Registrar e consumir 1 sessão do pacote criado em .+ \(restam 10 → 9\)$/,
      });
      await page.goto(`/clinics/patient?id=${c.pacienteId}`);
      await expect(linha).toContainText('1 de 10');
      const consumidas = async () =>
        (
          await db.query<{ consumidas: number; pacote: string; agendamento: string }>(
            `SELECT p."consumedSessions" AS consumidas, p."id" AS pacote, a."appointmentId" AS agendamento
               FROM "ClinicsPackage" p JOIN "ClinicsAttendance" a ON a."packageId" = p."id"
              WHERE p."patientId" = $1`,
            [c.pacienteId],
          )
        ).rows;
      const [registro] = await consumidas();
      expect(registro.consumidas).toBe(1);
      // a REPETIÇÃO não consome de novo: o mesmo pedido devolve o registro; outra
      // escolha (avulso) é recusada, sem efeito
      const csrf = (await page.context().cookies()).find((k) => k.name === 'veyra_csrf')?.value;
      expect(csrf).toBeTruthy();
      const cabecalhos = { Origin: E2E_WEB_ORIGIN, 'x-csrf-token': csrf as string };
      const repetir = (packageId: string | null) =>
        page.request.post(`/api/clinics/appointments/${registro.agendamento}/attendance`, {
          data: { packageId },
          headers: cabecalhos,
        });
      expect((await repetir(registro.pacote)).ok()).toBe(true);
      expect((await repetir(null)).status()).toBe(409);
      expect((await consumidas()).map((r) => r.consumidas)).toEqual([1]);
    } finally {
      await db.end();
    }
  });

  test('a recepção não vê pacotes nem dados de atendimento: a ficha sem a seção, nenhuma consulta, e a API recusa; o cancelado clínico aparece genérico', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      // um retorno manual cancelado com motivo CLÍNICO, por quem pode
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO "ClinicsReturn" ("id","workspaceId","patientId","serviceId","unitId","dueDate","createdByMembershipId")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, ($5::date + 30), $6) RETURNING "id"`,
        [c.ws, c.pacienteId, c.servicoId, c.unidade, c.dia, c.dono],
      );
      await db.query(
        `UPDATE "ClinicsReturn" SET "status" = 'canceled', "cancelReason" = 'not_needed',
           "closedByMembershipId" = $2 WHERE "id" = $1`,
        [rows[0].id, c.dono],
      );
      const aPacotes: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes('/api/clinics/packages')) aPacotes.push(r.url());
      });
      await login(page, MEMBER_C);
      await page.goto(`/clinics/patient?id=${c.pacienteId}`);
      await expect(page.getByRole('heading', { name: c.paciente, level: 1 })).toBeVisible();
      const retornos = page.getByRole('region', { name: 'Retornos do paciente' });
      const cancelado = retornos.getByRole('row', {
        name: `Retorno de ${c.paciente}, ${c.servico}, vence ${dataCurta(somarDias(c.dia, 30))}`,
      });
      await expect(cancelado).toContainText('Cancelado');
      await expect(cancelado).not.toContainText('Não é mais necessário');
      await expect(page.getByRole('region', { name: 'Pacotes do paciente' })).toHaveCount(0);
      expect(aPacotes).toEqual([]);
      const direto = await page.request.get(`/api/clinics/packages?patientId=${c.pacienteId}`);
      expect(direto.status()).toBe(403);

      // a recepção cancela um retorno pendente: só os motivos OPERACIONAIS
      const pendente = await db.query<{ id: string }>(
        `INSERT INTO "ClinicsReturn" ("id","workspaceId","patientId","serviceId","unitId","dueDate","createdByMembershipId")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, ($5::date + 40), $6) RETURNING "id"`,
        [c.ws, c.pacienteId, c.servicoId, c.unidade, c.dia, c.dono],
      );
      await page.reload();
      const contexto = `${c.paciente}, ${c.servico}, vence ${dataCurta(somarDias(c.dia, 40))}`;
      await retornos.getByRole('button', { name: `Cancelar: ${contexto}` }).click();
      const cancelar = page.getByRole('dialog', { name: 'Cancelar retorno' });
      const motivo = cancelar.getByLabel('Motivo do cancelamento');
      await expect(motivo.getByRole('option')).toHaveText([
        'Escolha o motivo',
        'Paciente recusou',
        'Paciente não encontrado',
      ]);
      await motivo.selectOption({ label: 'Paciente recusou' });
      await cancelar.getByRole('button', { name: 'Confirmar cancelamento' }).click();
      await expect(retornos.getByRole('row', { name: `Retorno de ${contexto}` })).toContainText(
        'Cancelado',
      );
      const fechado = await db.query<{ status: string; motivo: string }>(
        `SELECT "status", "cancelReason" AS motivo FROM "ClinicsReturn" WHERE "id" = $1`,
        [pendente.rows[0].id],
      );
      expect(fechado.rows[0]).toEqual({ status: 'canceled', motivo: 'patient_declined' });
    } finally {
      await db.end();
    }
  });

  test('retorno automático: nasce do atendimento de serviço com intervalo; a recepção vincula a consulta futura e atribui; o registro dela conclui', async ({
    page,
    browser,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db, 30);
      await agendamento(db, c, '21:00', 'confirmed');
      await agendamento(db, c, '10:00', 'scheduled', 1);
      await login(page, PROF_C);
      await registrarNaAgenda(page, c, c.dia, '21:00', 'avulso');

      const recepcao = await browser.newPage();
      try {
        await login(recepcao, MEMBER_C);
        await recepcao.goto('/clinics/returns');
        const linha = recepcao.getByRole('row', {
          name: `Retorno de ${c.paciente}, ${c.servico}, vence ${dataCurta(somarDias(c.dia, 30))}`,
        });
        await expect(linha).toContainText('Pendente');
        const contexto = `${c.paciente}, ${c.servico}, vence ${dataCurta(somarDias(c.dia, 30))}`;
        await linha.getByRole('button', { name: `Vincular agendamento: ${contexto}` }).click();
        const vincular = recepcao.getByRole('dialog', { name: 'Vincular agendamento' });
        await expect(vincular).toContainText('pode concluir o retorno');
        await vincular
          .getByRole('button', {
            name: `Vincular o agendamento de ${dataCurta(somarDias(c.dia, 1))} 10:00`,
          })
          .click();
        await expect(linha).toContainText(`${dataCurta(somarDias(c.dia, 1))} 10:00`);
        await linha.getByRole('button', { name: `Responsável: ${contexto}` }).click();
        const responsavel = recepcao.getByRole('dialog', { name: 'Responsável pelo retorno' });
        await responsavel.getByLabel('Responsável').selectOption({ label: 'Profissional Clínica' });
        await responsavel.getByRole('button', { name: 'Salvar responsável' }).click();
        await expect(linha).toContainText('Profissional Clínica');
      } finally {
        await recepcao.close();
      }

      await registrarNaAgenda(page, c, somarDias(c.dia, 1), '10:00', 'avulso');
      await page.goto('/clinics/returns');
      await page.getByLabel('Estado').selectOption({ label: 'Concluídos' });
      await expect(
        page.getByRole('row', {
          name: `Retorno de ${c.paciente}, ${c.servico}, vence ${dataCurta(somarDias(c.dia, 30))}`,
        }),
      ).toContainText('Concluído');
    } finally {
      await db.end();
    }
  });

  test('faltas: "Sem dados" sem atendido nem falta; 0 % LEGÍTIMO com um atendido; uma falta faz 50 %', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      const c = await cenario(db);
      await login(page, MEMBER_C);
      // o período é o "hoje" do BANCO no fuso da unidade, não o do navegador
      const filtrar = async () => {
        await page.goto('/clinics/no-show');
        await page.getByLabel('De (inclusive)').fill(c.dia);
        await page.getByLabel('Até (exclusive)').fill(somarDias(c.dia, 1));
        await page.getByLabel('Profissional').selectOption({ label: c.profissional });
      };
      const resumo = page.getByLabel('Taxa de faltas');
      await filtrar();
      await expect(resumo).toContainText('Sem dados');
      await expect(resumo).toContainText('Nenhum atendido nem falta');

      await agendamento(db, c, '01:00', 'attended');
      await filtrar();
      await expect(resumo.getByText('0 %', { exact: true })).toBeVisible();
      await expect(resumo).toContainText('0 faltas em 1 (atendidos + faltas)');

      await agendamento(db, c, '02:00', 'no_show');
      await filtrar();
      await expect(resumo.getByText('50 %', { exact: true })).toBeVisible();
      await expect(resumo).toContainText('1 falta em 2 (atendidos + faltas)');
    } finally {
      await db.end();
    }
  });

  test('o link direto de quem NÃO tem a permissão mostra a recusa, e nada do vertical é consultado', async ({
    page,
  }) => {
    const db = await openE2eDb();
    try {
      // um convidado fictício no workspace `clinica` (o papel Guest não recebe nada do Clinics)
      const email = `convidado-${sufixo()}@e2e.veyra`;
      const usuario = await db.query<{ id: string }>(
        `INSERT INTO "User" ("id","email","name","passwordHash","updatedAt")
         VALUES (gen_random_uuid(), $1, 'Convidado Fictício', $2, now()) RETURNING "id"`,
        [email, E2E_PASSWORD_HASH],
      );
      const ok = await db.query(
        `INSERT INTO "Membership" ("id","workspaceId","userId","roleId","updatedAt")
         SELECT gen_random_uuid(), w."id", $1, r."id", now()
           FROM "Workspace" w JOIN "Role" r ON r."workspaceId" = w."id" AND r."systemKey" = 'guest'
          WHERE w."slug" = 'clinica'`,
        [usuario.rows[0].id],
      );
      expect(ok.rowCount).toBe(1);
      const consultas: string[] = [];
      page.on('request', (r) => {
        if (/\/api\/clinics\/(?!status)/.test(r.url())) consultas.push(r.url());
      });
      await login(page, email);
      for (const [caminho, recusa] of [
        ['/clinics/returns', 'Você não tem acesso aos retornos da clínica.'],
        ['/clinics/no-show', 'Você não tem acesso às faltas da clínica.'],
        [
          '/clinics/patient?id=0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05',
          'Você não tem acesso aos pacientes da clínica.',
        ],
      ]) {
        await page.goto(caminho);
        await expect(page.getByText(recusa)).toBeVisible();
      }
      expect(consultas).toEqual([]);
    } finally {
      await db.end();
    }
  });

  test('workspace SEM o Clinics: as telas novas só explicam e nada do vertical é consultado', async ({
    page,
  }) => {
    const consultas: string[] = [];
    page.on('request', (r) => {
      if (/\/api\/clinics\/(?!status)/.test(r.url())) consultas.push(r.url());
    });
    await login(page, OWNER_A);
    for (const caminho of [
      '/clinics/returns',
      '/clinics/no-show',
      '/clinics/patient?id=0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e05',
    ]) {
      await page.goto(caminho);
      await expect(page.getByText('O Clinics não está ativo neste workspace.')).toBeVisible();
    }
    const lateral = page.getByRole('navigation', { name: 'Principal' });
    await expect(lateral.getByRole('link', { name: 'Retornos' })).toHaveCount(0);
    await expect(lateral.getByRole('link', { name: 'Faltas' })).toHaveCount(0);
    expect(consultas).toEqual([]);
  });
});

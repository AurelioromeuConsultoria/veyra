/**
 * A preparação da PILHA DA DEMONSTRAÇÃO do E2E (ADR-048 adendo 12, item 3),
 * rodada pelo comando do próprio servidor, ANTES de a API subir: o Playwright
 * sobe os servidores antes do setup global, e o worker — ligado nesta pilha —
 * não pode nascer num banco que será recriado.
 *
 * Cada passo usa o procedimento administrativo da operação: a ativação do
 * Clinics, o script do canal (o token fictício pela entrada padrão, cifrado
 * como na operação), a CLI das finalidades e o `templates:demo`. Nenhum
 * template, revisão, consentimento ou finalidade nasce por SQL: por SQL só a
 * base (como o setup do E2E) e os dados clínicos fictícios (como os testes do
 * Clinics). O consentimento é registrado pela tela, no cenário.
 */
import path from 'node:path';
import { Client } from 'pg';
import { WABA_DA_DEMONSTRACAO } from '../../apps/api/src/demo/catalogo-da-demonstracao';
import {
  CANAL_DEMO,
  E2E_DEMO_DATABASE_URL as URL_DEMO,
  FINALIDADES_DEMO,
  NUMERO_DEMO,
  OWNER_DEMO,
  PACIENTE_DEMO,
} from '../env';
import { RAIZ, cli, criarWorkspace, migrar, recriarBanco, semearCatalogo } from '../semeadura';

/** o par que liga o transporte e o catálogo falsos (`transporteSimulado`) */
const TRANSPORTE_SIMULADO = { META_TRANSPORT_MODE: 'fake', VEYRA_ENV: 'staging' };

const um = async (db: Client, sql: string, params: unknown[]) =>
  (await db.query<{ id: string }>(sql, params)).rows[0].id;

/** O paciente fictício com um agendamento AMANHÃ às 10:00 locais. */
async function semearClinica(db: Client): Promise<void> {
  const { rows } = await db.query<{ ws: string; unidade: string; fuso: string; dono: string }>(
    `SELECT w."id" AS ws, u."id" AS unidade, u."timezone" AS fuso, m."id" AS dono
       FROM "Workspace" w
       JOIN "ClinicsUnit" u ON u."workspaceId" = w."id" AND u."archivedAt" IS NULL
       JOIN "Membership" m ON m."workspaceId" = w."id"
       JOIN "User" us ON us."id" = m."userId" AND us."email" = $1
      WHERE w."slug" = 'demo'`,
    [OWNER_DEMO],
  );
  if (rows.length !== 1) throw new Error('A ativação do Clinics não deixou a unidade da demo');
  const { ws, unidade, fuso, dono } = rows[0];
  const servico = await um(
    db,
    `INSERT INTO "ClinicsService" ("id","workspaceId","name","durationMin","updatedAt")
     VALUES (gen_random_uuid(), $1, 'Limpeza de pele (demonstração)', 30, now()) RETURNING "id"`,
    [ws],
  );
  const profissional = await um(
    db,
    `INSERT INTO "ClinicsProfessional" ("id","workspaceId","name","updatedAt")
     VALUES (gen_random_uuid(), $1, 'Dra. Fictícia', now()) RETURNING "id"`,
    [ws],
  );
  await db.query(
    `INSERT INTO "ClinicsProfessionalService" ("id","workspaceId","professionalId","serviceId")
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [ws, profissional, servico],
  );
  for (let semana = 1; semana <= 7; semana++) {
    await db.query(
      `INSERT INTO "ClinicsWorkingHours" ("id","workspaceId","professionalId","unitId","weekday","startMinute","endMinute")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, 1440)`,
      [ws, profissional, unidade, semana],
    );
  }
  const contato = await um(
    db,
    `INSERT INTO "Contact" ("id","workspaceId","name","phones","phonesNormalized","phoneMatchKeys","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, ARRAY[$3], ARRAY[$3], ARRAY[right($3, 8)], now())
     RETURNING "id"`,
    [ws, PACIENTE_DEMO, NUMERO_DEMO],
  );
  const paciente = await um(
    db,
    `INSERT INTO "ClinicsPatient" ("id","workspaceId","contactId","createdByMembershipId")
     VALUES (gen_random_uuid(), $1, $2, $3) RETURNING "id"`,
    [ws, contato, dono],
  );
  await db.query(
    `INSERT INTO "ClinicsAppointment"
       ("id","workspaceId","patientId","professionalId","serviceId","unitId","startsAt","endsAt","status","createdByMembershipId","updatedAt")
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
             ((now() AT TIME ZONE $6)::date + 1 + time '10:00') AT TIME ZONE $6,
             ((now() AT TIME ZONE $6)::date + 1 + time '10:30') AT TIME ZONE $6,
             'scheduled', $7, now())`,
    [ws, paciente, profissional, servico, unidade, fuso, dono],
  );
}

async function main(): Promise<void> {
  await recriarBanco(URL_DEMO);
  migrar(URL_DEMO);
  const db = new Client({ connectionString: URL_DEMO });
  await db.connect();
  try {
    await semearCatalogo(db);
    await criarWorkspace(db, 'demo', OWNER_DEMO);
    process.stdout.write(
      cli(
        'node',
        ['apps/api/dist/verticals/clinics/cli/clinics.js', 'enable', '--slug', 'demo'],
        URL_DEMO,
      ),
    );
    await semearClinica(db);

    // o canal pelo script administrativo (ADR-037): o token fictício pela
    // entrada padrão, nunca na linha de comando, cifrado como na operação
    process.stdout.write(
      cli(
        path.join(RAIZ, 'apps/api/node_modules/.bin/tsx'),
        [
          'apps/api/scripts/register-whatsapp-channel.ts',
          '--slug',
          'demo',
          '--phone-number-id',
          '000000000000011',
          '--waba',
          WABA_DA_DEMONSTRACAO,
          '--name',
          CANAL_DEMO,
          '--token-stdin',
        ],
        URL_DEMO,
        {},
        'token-ficticio-da-demonstracao',
      ),
    );
    for (const f of FINALIDADES_DEMO) {
      process.stdout.write(
        cli(
          'node',
          [
            'apps/api/dist/cli/consent-purpose.js',
            '--slug',
            'demo',
            '--key',
            f.key,
            '--category',
            'utility',
            '--description',
            f.description,
            '--fields',
            f.fields,
          ],
          URL_DEMO,
        ),
      );
    }
    const canal = await um(
      db,
      `SELECT c."id" FROM "Channel" c JOIN "Workspace" w ON w."id" = c."workspaceId"
        WHERE w."slug" = 'demo' AND c."name" = $1`,
      [CANAL_DEMO],
    );
    // os templates fictícios: cadastro e revisão pelos serviços, em nome do Owner
    process.stdout.write(
      cli(
        'node',
        [
          'apps/api/dist/cli/templates-demo.js',
          '--slug',
          'demo',
          '--channel',
          canal,
          '--reviewer',
          OWNER_DEMO,
        ],
        URL_DEMO,
        TRANSPORTE_SIMULADO,
      ),
    );
  } finally {
    await db.end();
  }
}

main().catch((erro) => {
  console.error('A preparação da pilha da demonstração falhou:', erro);
  process.exit(1);
});

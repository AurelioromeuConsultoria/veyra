/**
 * globalSetup do Playwright: recria o banco e2e do zero (drop → create →
 * migrate deploy) e semeia o cenário: catálogo de permissões + 3 workspaces
 * (acme/beta/clinica) com roles de sistema e um Owner cada — para provar o
 * isolamento cross-workspace pela UI. A pilha da demonstração prepara o
 * próprio banco (`e2e/demo/preparar.ts`).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  E2E_DATABASE_URL,
  E2E_PASSWORD_HASH,
  MEMBER_C,
  PROF_C,
  OWNER_A,
  OWNER_B,
  OWNER_C,
} from './env';
import { cli, criarWorkspace, migrar, recriarBanco, semearCatalogo } from './semeadura';

async function seed(): Promise<void> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    await semearCatalogo(db);
    for (const [slug, ownerEmail] of [
      ['acme', OWNER_A],
      ['beta', OWNER_B],
      ['clinica', OWNER_C],
    ] as const) {
      await criarWorkspace(db, slug, ownerEmail);
    }

    // recepção (Member) da clínica — para provar o catálogo só de leitura
    const recepcao = randomUUID();
    await db.query(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "updatedAt")
       VALUES ($1, $2, 'Recepção Clínica', $3, now())`,
      [recepcao, MEMBER_C, E2E_PASSWORD_HASH],
    );
    await db.query(
      `INSERT INTO "Membership" ("id", "workspaceId", "userId", "roleId", "updatedAt")
       SELECT $1, w."id", $2, r."id", now()
         FROM "Workspace" w JOIN "Role" r ON r."workspaceId" = w."id" AND r."systemKey" = 'member'
        WHERE w."slug" = 'clinica'`,
      [randomUUID(), recepcao],
    );
  } finally {
    await db.end();
  }
}

/**
 * Ativa o Clinics SÓ no workspace `clinica`, com a CLI COMPILADA — o mesmo
 * caminho da operação (ADR-047 §4). Dados fictícios; staging nunca é tocado.
 * `pnpm test:e2e` builda antes, então o `dist/` existe.
 */
function activateClinics(): void {
  process.stdout.write(
    cli(
      'node',
      ['apps/api/dist/verticals/clinics/cli/clinics.js', 'enable', '--slug', 'clinica'],
      E2E_DATABASE_URL,
    ),
  );
}

/**
 * Usuário com o papel `Profissional` do Clinics (systemKey do vertical), que a
 * ATIVAÇÃO cria — por isso depois dela. Dados fictícios.
 */
async function seedProfessionalUser(): Promise<void> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    const userId = randomUUID();
    await db.query(
      `INSERT INTO "User" ("id", "email", "name", "passwordHash", "updatedAt")
       VALUES ($1, $2, 'Profissional Clínica', $3, now())`,
      [userId, PROF_C, E2E_PASSWORD_HASH],
    );
    const { rowCount } = await db.query(
      `INSERT INTO "Membership" ("id", "workspaceId", "userId", "roleId", "updatedAt")
       SELECT $1, w."id", $2, r."id", now()
         FROM "Workspace" w JOIN "Role" r ON r."workspaceId" = w."id" AND r."systemKey" = 'clinics:professional'
        WHERE w."slug" = 'clinica'`,
      [randomUUID(), userId],
    );
    if (rowCount !== 1)
      throw new Error('Papel Profissional do Clinics não encontrado após a ativação');
  } finally {
    await db.end();
  }
}

export default async function globalSetup(): Promise<void> {
  // a trava do nome e do host (`conferirBanco`) vem ANTES do DROP e da ativação
  await recriarBanco(E2E_DATABASE_URL);
  migrar(E2E_DATABASE_URL);
  await seed();
  activateClinics();
  await seedProfessionalUser();
}

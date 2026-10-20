/**
 * globalSetup do Playwright: recria o banco e2e do zero (drop → create →
 * migrate deploy) e semeia o cenário: catálogo de permissões + 2 workspaces
 * (acme/beta) com roles de sistema e um Owner cada — para provar o isolamento
 * cross-workspace pela UI.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES } from '../packages/contracts/src/permissions';
import { DEFAULT_STAGES } from '../apps/api/src/pipelines/pipelines.service';
import {
  E2E_DATABASE_URL,
  E2E_PASSWORD_HASH,
  MEMBER_C,
  PROF_C,
  OWNER_A,
  OWNER_B,
  OWNER_C,
  assertIsE2eDb,
} from './env';

async function recreateDatabase(dbName: string): Promise<void> {
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function seed(): Promise<void> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
      // ON CONFLICT: a migration da Entrega 7 já semeia as chaves de IA, e o
      // seed precisa ser reexecutável de qualquer forma
      await db.query(
        `INSERT INTO "Permission" ("key", "description") VALUES ($1, $2)
         ON CONFLICT ("key") DO NOTHING`,
        [key, description],
      );
    }
    for (const [slug, ownerEmail] of [
      ['acme', OWNER_A],
      ['beta', OWNER_B],
      ['clinica', OWNER_C],
    ] as const) {
      const workspaceId = randomUUID();
      await db.query(
        `INSERT INTO "Workspace" ("id", "name", "slug", "updatedAt") VALUES ($1, $2, $3, now())`,
        [workspaceId, slug.toUpperCase(), slug],
      );
      let ownerRoleId = '';
      for (const [name, keys] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
        const roleId = randomUUID();
        const systemKey = name.toLowerCase();
        await db.query(
          `INSERT INTO "Role" ("id", "workspaceId", "name", "isSystem", "systemKey", "updatedAt")
           VALUES ($1, $2, $3, true, $4, now())`,
          [roleId, workspaceId, name, systemKey],
        );
        for (const key of keys) {
          await db.query(
            `INSERT INTO "RolePermission" ("id", "workspaceId", "roleId", "permissionKey")
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), workspaceId, roleId, key],
          );
        }
        if (systemKey === 'owner') ownerRoleId = roleId;
      }
      // assinatura no plano-base (como o provisionamento real — ADR-034)
      await db.query(
        `INSERT INTO "Subscription" ("workspaceId", "planKey", "status", "currentPeriodStart", "currentPeriodEnd", "updatedAt")
         VALUES ($1, 'base', 'active', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', now())
         ON CONFLICT ("workspaceId") DO NOTHING`,
        [workspaceId],
      );
      // canal interno de sistema (como o provisionamento real — ADR-023)
      await db.query(
        `INSERT INTO "Channel" ("id", "workspaceId", "type", "name", "systemMark")
         VALUES ($1, $2, 'internal', 'Interno', true)`,
        [randomUUID(), workspaceId],
      );
      // pipeline padrão + stages (como o provisionamento real)
      const pipelineId = randomUUID();
      await db.query(
        `INSERT INTO "Pipeline" ("id", "workspaceId", "name", "defaultMark", "updatedAt")
         VALUES ($1, $2, 'Vendas', true, now())`,
        [pipelineId, workspaceId],
      );
      for (const stage of DEFAULT_STAGES) {
        await db.query(
          `INSERT INTO "Stage" ("id", "workspaceId", "pipelineId", "name", "order", "probability", "type")
           VALUES ($1, $2, $3, $4, $5, $6, $7::"StageType")`,
          [
            randomUUID(),
            workspaceId,
            pipelineId,
            stage.name,
            stage.order,
            stage.probability,
            stage.type,
          ],
        );
      }

      const userId = randomUUID();
      await db.query(
        `INSERT INTO "User" ("id", "email", "name", "passwordHash", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [userId, ownerEmail, `Owner ${slug}`, E2E_PASSWORD_HASH],
      );
      await db.query(
        `INSERT INTO "Membership" ("id", "workspaceId", "userId", "roleId", "updatedAt")
         VALUES ($1, $2, $3, $4, now())`,
        [randomUUID(), workspaceId, userId, ownerRoleId],
      );
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
  execSync('node apps/api/dist/verticals/clinics/cli/clinics.js enable --slug clinica', {
    cwd: path.resolve(__dirname, '..'),
    // SÓ o necessário: nada do ambiente do shell (chaves reais exportadas) vaza
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: E2E_DATABASE_URL,
      JWT_SECRET: 'jwt-secret-de-e2e-nunca-em-producao-32ch',
      TOKEN_ENCRYPTION_KEY: 'chave-de-cifra-de-e2e-nunca-em-producao-32',
      DISABLE_JOBS: 'true',
    },
    stdio: 'inherit',
  });
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
  const dbName = assertIsE2eDb();
  // fora do CI, só banco LOCAL — checado ANTES do DROP e da ativação do Clinics
  const host = new URL(E2E_DATABASE_URL).hostname;
  if (!process.env.CI && !['localhost', '127.0.0.1'].includes(host)) {
    throw new Error(`E2E recusado: banco em "${host}", não local (fora do CI).`);
  }
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Nome de database inválido: "${dbName}"`);
  await recreateDatabase(dbName);
  execSync('pnpm exec prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../apps/api'),
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: 'inherit',
  });
  await seed();
  activateClinics();
  await seedProfessionalUser();
}

/**
 * A semeadura comum às duas pilhas do E2E: a principal (o setup global) e a da
 * demonstração (`e2e/demo/preparar.ts`, ADR-048 adendo 12). Recria o banco,
 * aplica as migrations, semeia o catálogo de permissões e os workspaces como o
 * provisionamento real os deixa, e roda as CLIs COMPILADAS — o mesmo caminho
 * da operação. Dados fictícios; nenhum outro ambiente é tocado.
 */
import { execFileSync, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES } from '../packages/contracts/src/permissions';
import { DEFAULT_STAGES } from '../apps/api/src/pipelines/pipelines.service';
import { assertIsE2eDb, E2E_CHAVES, E2E_PASSWORD_HASH } from './env';

export const RAIZ = path.resolve(__dirname, '..');

/** Fora do CI, só banco LOCAL — conferido ANTES do DROP. */
export function conferirBanco(url: string): string {
  const dbName = assertIsE2eDb(url);
  const host = new URL(url).hostname;
  if (!process.env.CI && !['localhost', '127.0.0.1'].includes(host)) {
    throw new Error(`E2E recusado: banco em "${host}", não local (fora do CI).`);
  }
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Nome de database inválido: "${dbName}"`);
  return dbName;
}

export async function recriarBanco(url: string): Promise<void> {
  const dbName = conferirBanco(url);
  const adminUrl = new URL(url);
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

export function migrar(url: string): void {
  conferirBanco(url);
  execSync('pnpm exec prisma migrate deploy', {
    cwd: path.join(RAIZ, 'apps/api'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}

export async function semearCatalogo(db: Client): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
    // ON CONFLICT: a migration da Entrega 7 já semeia as chaves de IA, e o
    // seed precisa ser reexecutável de qualquer forma
    await db.query(
      `INSERT INTO "Permission" ("key", "description") VALUES ($1, $2)
       ON CONFLICT ("key") DO NOTHING`,
      [key, description],
    );
  }
}

/**
 * O workspace como o provisionamento real o deixa: os papéis de sistema, a
 * assinatura no plano-base, o canal interno, o pipeline padrão e o Owner.
 */
export async function criarWorkspace(db: Client, slug: string, ownerEmail: string): Promise<void> {
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

/**
 * Uma CLI administrativa, com SÓ o ambiente necessário: nada do ambiente do
 * shell (chaves reais exportadas) vaza. `extra` acrescenta o do transporte.
 */
export function cli(
  comando: string,
  args: string[],
  url: string,
  extra: Record<string, string> = {},
  entrada?: string,
): string {
  conferirBanco(url);
  return execFileSync(comando, args, {
    cwd: RAIZ,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: url,
      ...E2E_CHAVES,
      DISABLE_JOBS: 'true',
      MAINTENANCE_MODE: 'false',
      ...extra,
    },
    input: entrada,
    stdio: ['pipe', 'pipe', 'inherit'],
    encoding: 'utf8',
  });
}

/**
 * Põe um workspace de TESTE numa experiência de produto (ADR-055, adendo 2,
 * item 10). É fixture, como o resto da semeadura — não um caminho operacional:
 * a operação usa a CLI `workspace:experience` (que exige o vertical ativo), e o
 * staging não passa por aqui.
 */
export async function porNaExperiencia(
  db: Client,
  slug: string,
  experiencia: string,
): Promise<void> {
  // a trava do E2E também aqui, não só no `recriarBanco` de quem chama: nunca
  // um banco que não seja de teste, nem um servidor que não seja local
  conferirBanco(`postgresql://${db.host}:${db.port}/${db.database ?? ''}`);
  const { rowCount } = await db.query(
    `UPDATE "Workspace" SET "experience" = $2 WHERE "slug" = $1`,
    [slug, experiencia],
  );
  if (rowCount !== 1) throw new Error(`Workspace de teste inexistente: ${slug}`);
}

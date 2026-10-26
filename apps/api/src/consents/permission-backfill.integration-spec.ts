import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';
import {
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { createPrisma, resetDb } from '../../test/integration/harness';

/**
 * O PREENCHIMENTO das chaves da F4.1b (ADR-052 item 6, com a revisão do
 * usuário de 2026-10-26): o teste executa EXATAMENTE o trecho da migration
 * entre os marcadores, sobre papéis como estariam antes dela. Prova a matriz
 * explícita dos três papéis do Core, os pré-requisitos, quem fica de fora, o
 * livro (a reaplicação não devolve a chave revogada) e que nada é removido.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../prisma/migrations/20261026120000_consents_and_stop_block/migration.sql',
);
const NOVAS = ['consents:read', 'consents:manage', 'consents:unblock', 'templates:review'];

function trechoDoPreenchimento(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const inicio = sql.indexOf('-- PREENCHIMENTO:INICIO');
  const fim = sql.indexOf('-- PREENCHIMENTO:FIM');
  if (inicio < 0 || fim < inicio) throw new Error('marcadores do preenchimento não encontrados');
  return sql.slice(inicio, fim);
}

describe('F4.1b — o preenchimento das permissões (a migration, integração)', () => {
  let prisma: PrismaService;
  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  const extras: Record<string, string> = {};

  beforeAll(async () => {
    ({ prisma } = createPrisma());
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  const chavesDe = async (roleId: string) =>
    (
      await prisma.raw.rolePermission.findMany({
        where: { roleId, permissionKey: { in: NOVAS } },
        select: { permissionKey: true },
      })
    )
      .map((r) => r.permissionKey)
      .sort();
  const preencher = () => prisma.raw.$executeRawUnsafe(trechoDoPreenchimento());
  const antigas = () =>
    prisma.raw.rolePermission.count({ where: { permissionKey: { notIn: NOVAS } } });
  const papel = async (
    ws: string,
    nome: string,
    chaves: string[],
    sistema: { systemKey: string } | null,
  ) => {
    const role = await prisma.raw.role.create({
      data: {
        workspaceId: ws,
        name: nome,
        isSystem: sistema !== null,
        systemKey: sistema?.systemKey ?? null,
      },
    });
    await prisma.raw.rolePermission.createMany({
      data: chaves.map((permissionKey) => ({ workspaceId: ws, roleId: role.id, permissionKey })),
    });
    return role.id;
  };

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    // os papéis como estavam ANTES da migration: sem as chaves novas — salvo o
    // `consents:read` do owner do B, que o livro registra sem nova concessão
    await prisma.raw.rolePermission.deleteMany({
      where: {
        permissionKey: { in: NOVAS },
        NOT: { roleId: wsB.roles.owner, permissionKey: 'consents:read' },
      },
    });
    // no B, o member e o admin sem contacts:write (o pré-requisito)
    await prisma.raw.rolePermission.deleteMany({
      where: {
        roleId: { in: [wsB.roles.member, wsB.roles.admin] },
        permissionKey: 'contacts:write',
      },
    });
    const amplas = ['contacts:read', 'contacts:write', 'conversations:read'];
    extras.profissional = await papel(wsA.workspaceId, 'Profissional', amplas, {
      systemKey: 'profissional',
    });
    extras.vertical = await papel(wsA.workspaceId, 'Recepção', amplas, {
      systemKey: 'clinics_recepcao',
    });
    // o NOME não decide nada: um personalizado com nome de papel de sistema fica
    // de fora (o único por nome é por workspace: o "Admin" do Core está no A)
    extras.personalizado = await papel(wsA.workspaceId, 'Administrador', amplas, null);
  });

  it('a matriz explícita: owner e admin as quatro, member duas; guest, Profissional, vertical e personalizado intocados', async () => {
    const antes = await antigas();
    await preencher();
    expect(await chavesDe(wsA.roles.owner)).toEqual([...NOVAS].sort());
    expect(await chavesDe(wsA.roles.admin)).toEqual([...NOVAS].sort());
    expect(await chavesDe(wsA.roles.member)).toEqual(['consents:manage', 'consents:read']);
    for (const roleId of [
      wsA.roles.guest,
      extras.profissional,
      extras.vertical,
      extras.personalizado,
    ]) {
      expect(await chavesDe(roleId)).toEqual([]);
    }
    // só acréscimo: nenhuma concessão anterior some
    expect(await antigas()).toBe(antes);
  });

  it('os pré-requisitos: sem contacts:write, só consents:read — no member e no admin', async () => {
    await preencher();
    expect(await chavesDe(wsB.roles.member)).toEqual(['consents:read']);
    expect(await chavesDe(wsB.roles.admin)).toEqual(['consents:read']);
    expect(await chavesDe(wsB.roles.owner)).toEqual([...NOVAS].sort());
  });

  it('o livro registra cada alvo; a auditoria, só o que foi concedido de fato', async () => {
    await preencher();
    // A: 4 + 4 + 2; B: owner 4, admin 1, member 1
    expect(await prisma.raw.permissionBackfill.count()).toBe(16);
    const trilha = await prisma.raw.auditLog.findMany({
      where: { action: 'role.permission_backfilled' },
    });
    // o owner do B já tinha consents:read: está no livro, sem concessão nova
    expect(trilha).toHaveLength(15);
    expect(
      trilha.some(
        (t) =>
          t.entityId === wsB.roles.owner &&
          (t.after as { permissionKey: string }).permissionKey === 'consents:read',
      ),
    ).toBe(false);
    expect(trilha[0]).toMatchObject({
      actorType: 'system',
      actorId: 'migration:20261026120000_consents_and_stop_block',
      entityType: 'role',
    });
  });

  it('reaplicar é idempotente e NÃO devolve a chave revogada depois', async () => {
    await preencher();
    await prisma.raw.rolePermission.deleteMany({
      where: { roleId: wsA.roles.member, permissionKey: 'consents:manage' },
    });
    const livro = await prisma.raw.permissionBackfill.count();
    const trilha = await prisma.raw.auditLog.count();
    await preencher();
    expect(await chavesDe(wsA.roles.member)).toEqual(['consents:read']);
    expect(await prisma.raw.permissionBackfill.count()).toBe(livro);
    expect(await prisma.raw.auditLog.count()).toBe(trilha);
  });
});

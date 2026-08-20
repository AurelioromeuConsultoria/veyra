import { FakeCls, createPrisma, resetDb } from '../../test/integration/harness';

/**
 * Teste de SEGURANÇA, não só de funcionalidade: comprova que o client extension
 * do PrismaService isola workspaces de verdade contra um Postgres real, e que
 * as FKs compostas (ADR-010) bloqueiam relação cross-workspace no banco.
 * Se este teste falhar, é vazamento entre workspaces — trate como P0.
 */
describe('PrismaService — isolamento multi-workspace (integração)', () => {
  const cls = new FakeCls();
  const { prisma } = createPrisma(cls);

  let workspaceA: string;
  let workspaceB: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
  });
  afterAll(async () => {
    await prisma.onModuleDestroy();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    cls.set('workspaceId', undefined);
    // raw justificado: provisionamento de workspaces é rotina administrativa
    const a = await prisma.raw.workspace.create({ data: { name: 'A', slug: 'a' } });
    const b = await prisma.raw.workspace.create({ data: { name: 'B', slug: 'b' } });
    workspaceA = a.id;
    workspaceB = b.id;
  });

  // helper: create em modelo protegido SEM passar workspaceId (o extension carimba)
  function createRole(name: string) {
    return (
      prisma.db.role.create as (arg: unknown) => Promise<{ id: string; workspaceId: string }>
    )({ data: { name } });
  }

  it('create via db carimba o workspace do contexto CLS', async () => {
    cls.set('workspaceId', workspaceA);
    const role = await createRole('Vendas');
    expect(role.workspaceId).toBe(workspaceA);
  });

  it('um workspace nunca enxerga dados de outro', async () => {
    cls.set('workspaceId', workspaceA);
    await createRole('A-role');
    cls.set('workspaceId', workspaceB);
    await createRole('B-role');

    cls.set('workspaceId', workspaceA);
    const asA = await prisma.db.role.findMany();
    expect(asA.map((r) => r.name)).toEqual(['A-role']);

    cls.set('workspaceId', workspaceB);
    const asB = await prisma.db.role.findMany();
    expect(asB.map((r) => r.name)).toEqual(['B-role']);
  });

  it('updateMany de um workspace não alcança linha de outro', async () => {
    cls.set('workspaceId', workspaceA);
    await createRole('A-role');
    cls.set('workspaceId', workspaceB);
    await createRole('B-role');

    // B tenta renomear "tudo" — só pode tocar no que é dele
    cls.set('workspaceId', workspaceB);
    await prisma.db.role.updateMany({ data: { name: 'renomeada' } });

    cls.set('workspaceId', workspaceA);
    const asA = await prisma.db.role.findMany();
    expect(asA.map((r) => r.name)).toEqual(['A-role']);
  });

  it('deleteMany de um workspace não apaga linha de outro', async () => {
    cls.set('workspaceId', workspaceA);
    await createRole('A-role');
    cls.set('workspaceId', workspaceB);
    await createRole('B-role');

    cls.set('workspaceId', workspaceB);
    await prisma.db.role.deleteMany();

    cls.set('workspaceId', workspaceA);
    expect(await prisma.db.role.count()).toBe(1);
  });

  it('query sem workspace no contexto é bloqueada (fail-closed)', async () => {
    cls.set('workspaceId', undefined);
    await expect(prisma.db.role.findMany()).rejects.toThrow(/proteção multitenant/);
  });

  it('operação por chave única (findUnique) é bloqueada em modelo protegido', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(
      prisma.db.role.findUnique({
        where: { id: '00000000-0000-0000-0000-000000000000' },
      }),
    ).rejects.toThrow(/tenant-safe/);
  });

  it('update/delete/upsert por chave única também são bloqueados', async () => {
    cls.set('workspaceId', workspaceA);
    const id = '00000000-0000-0000-0000-000000000000';
    await expect(prisma.db.role.update({ where: { id }, data: { name: 'x' } })).rejects.toThrow(
      /tenant-safe/,
    );
    await expect(prisma.db.role.delete({ where: { id } })).rejects.toThrow(/tenant-safe/);
    await expect(
      prisma.db.role.upsert({ where: { id }, create: { name: 'x' } as never, update: {} }),
    ).rejects.toThrow(/tenant-safe/);
  });

  it('include que sai do perímetro protegido (membership → user) é bloqueado', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(
      prisma.db.membership.findMany({ include: { user: true } } as never),
    ).rejects.toThrow(/perímetro protegido/);
    // travessia transitiva (o exploit original: user → memberships de OUTROS workspaces)
    await expect(
      prisma.db.membership.findMany({
        include: { user: { include: { memberships: true } } },
      } as never),
    ).rejects.toThrow(/perímetro protegido/);
  });

  it('filtro de relação que sai do perímetro (where.user) é bloqueado — sem oráculo', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(
      prisma.db.membership.count({
        where: { user: { memberships: { some: { workspaceId: workspaceB } } } },
      } as never),
    ).rejects.toThrow(/perímetro protegido/);
  });

  it('include protegido→protegido (membership → role) continua permitido', async () => {
    const user = await prisma.raw.user.create({
      data: { email: 'inc@veyra.test', name: 'Inc', passwordHash: 'hash-de-teste' },
    });
    cls.set('workspaceId', workspaceA);
    const role = await createRole('Com-include');
    await prisma.db.membership.create({
      data: { userId: user.id, roleId: role.id },
    } as never);
    const rows = await prisma.db.membership.findMany({ include: { role: true } } as never);
    expect((rows[0] as unknown as { role: { name: string } }).role.name).toBe('Com-include');
  });

  it('modelos globais (Workspace/User) são PROIBIDOS no db — só via raw', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(prisma.db.workspace.findMany()).rejects.toThrow(/prisma\.raw/);
    await expect(prisma.db.user.findMany()).rejects.toThrow(/prisma\.raw/);
  });

  it('SQL cru é proibido no db', async () => {
    cls.set('workspaceId', workspaceA);
    // o hook do $extends dispara na execução (lazy) — validar via rejeição
    await expect(
      Promise.resolve(prisma.db.$queryRawUnsafe('SELECT 1')).catch((e) => {
        throw e;
      }),
    ).rejects.toThrow(/prisma\.raw/);
  });

  it('data.workspaceId divergente do contexto é rejeitado (create e updateMany)', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(
      prisma.db.role.create({ data: { name: 'x', workspaceId: workspaceB } } as never),
    ).rejects.toThrow(/diverge do contexto/);
    await createRole('minha');
    await expect(
      prisma.db.role.updateMany({ data: { workspaceId: workspaceB } } as never),
    ).rejects.toThrow(/diverge do contexto/);
  });

  it('escrita aninhada por relação é rejeitada — use FK escalar', async () => {
    cls.set('workspaceId', workspaceA);
    await expect(
      prisma.db.membership.create({
        data: { user: { create: { email: 'x@x', name: 'x', passwordHash: 'h' } } },
      } as never),
    ).rejects.toThrow(/FK escalar/);
  });

  it('where com workspaceId de outro workspace não vaza (o AND do contexto prevalece)', async () => {
    cls.set('workspaceId', workspaceA);
    await createRole('A-role');
    cls.set('workspaceId', workspaceB);
    await createRole('B-role');

    cls.set('workspaceId', workspaceA);
    const rows = await prisma.db.role.findMany({ where: { workspaceId: workspaceB } });
    expect(rows).toEqual([]);
  });

  it('createMany carimba todos os itens; count/groupBy filtram por workspace', async () => {
    cls.set('workspaceId', workspaceA);
    await prisma.db.role.createMany({
      data: [{ name: 'r1' }, { name: 'r2' }],
    } as never);
    cls.set('workspaceId', workspaceB);
    await createRole('r-de-b');

    cls.set('workspaceId', workspaceA);
    expect(await prisma.db.role.count()).toBe(2);
    const grouped = (await prisma.db.role.groupBy({
      by: ['workspaceId'],
      _count: true,
    } as never)) as Array<{ workspaceId: string }>;
    expect(grouped).toHaveLength(1);
    expect(grouped[0].workspaceId).toBe(workspaceA);
  });

  it('workspaceId não-string no contexto (type confusion) é rejeitado', async () => {
    cls.set('workspaceId', { not: null });
    await expect(prisma.db.role.findMany()).rejects.toThrow(/sem workspace válido/);
    cls.set('workspaceId', 'nao-e-uuid');
    await expect(prisma.db.role.findMany()).rejects.toThrow(/sem workspace válido/);
  });

  it('FK composta impede RolePermission e Invite apontarem para Role de outro workspace', async () => {
    cls.set('workspaceId', workspaceA);
    const roleA = await createRole('A-role');

    await prisma.raw.permission.upsert({
      where: { key: 'contacts:read' },
      create: { key: 'contacts:read', description: 'teste' },
      update: {},
    });
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "RolePermission" ("id", "workspaceId", "roleId", "permissionKey")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'contacts:read')`,
        workspaceB,
        roleA.id,
      ),
    ).rejects.toThrow(/foreign key|RolePermission_workspaceId_roleId_fkey/i);
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "Invite" ("id", "workspaceId", "email", "roleId", "tokenHash", "expiresAt")
         VALUES (gen_random_uuid(), $1::uuid, 'x@x', $2::uuid, 'th-teste', now() + interval '1 day')`,
        workspaceB,
        roleA.id,
      ),
    ).rejects.toThrow(/foreign key|Invite_workspaceId_roleId_fkey/i);
  });

  it('FK composta impede Membership apontar para Role de outro workspace (ADR-010)', async () => {
    // raw justificado: montar cenário de identidade global no teste de segurança
    const user = await prisma.raw.user.create({
      data: { email: 'p0@veyra.test', name: 'P0', passwordHash: 'hash-de-teste' },
    });
    cls.set('workspaceId', workspaceA);
    const roleA = await createRole('A-role');

    // tentativa de gravar em B uma membership usando role de A → o BANCO rejeita.
    // SQL cru de propósito: prova a camada de integridade abaixo do Prisma
    // (parâmetros posicionais; valores são uuids gerados pelo próprio teste).
    await expect(
      prisma.raw.$executeRawUnsafe(
        `INSERT INTO "Membership" ("id", "workspaceId", "userId", "roleId", "updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, now())`,
        workspaceB,
        user.id,
        roleA.id,
      ),
    ).rejects.toThrow(/foreign key|Membership_workspaceId_roleId_fkey/i);
  });
});

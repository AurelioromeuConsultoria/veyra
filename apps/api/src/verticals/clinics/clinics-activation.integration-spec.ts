import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SYSTEM_ROLE_TEMPLATES } from '@veyra/contracts';
import {
  CLINICS_PERMISSION_KEYS,
  CLINICS_PROFESSIONAL_SYSTEM_KEY,
} from '@veyra/contracts/verticals/clinics';
import { ClsService } from 'nestjs-cls';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma/prisma.service';
import { ProvisioningService } from '../../workspaces/provisioning.service';
import { createTestApp } from '../../../test/integration/app';
import { TEST_DATABASE_URL } from '../../../test/integration/db-url';
import {
  TEST_PASSWORD,
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../../test/integration/fixtures';
import { resetDb } from '../../../test/integration/harness';
import { ClinicsActivationService } from './clinics-activation.service';
import { CLINICS_PROFESSIONAL_CORE_KEYS, CLINICS_ROLE_GRANTS } from './clinics-permissions';
import { CLINICS_USAGE, parseClinicsArgs, runClinicsCommand } from './cli/clinics-command';

const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5175';

interface Session {
  cookieHeader: string;
  csrf: string;
}

/**
 * Ciclo de vida da ativação do Clinics (ADR-047 §4 e "Testes exigidos na F1"),
 * pela CLI: o `runClinicsCommand` é o corpo do `clinics.ts`, rodando num
 * contexto de aplicação montado como a CLI o monta.
 */
describe('Clinics — ativação pela CLI, isolamento e ciclo de vida (integração)', () => {
  let app: INestApplication;
  let cliContext: INestApplicationContext;
  let prisma: PrismaService;
  let http: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();
    // o MESMO contexto que `cli/clinics.ts` sobe
    cliContext = await NestFactory.createApplicationContext(AppModule, { logger: false });
  });
  afterAll(async () => {
    await cliContext.close();
    await app.close();
  });

  const cli = async (...argv: string[]): Promise<string[]> => {
    const command = parseClinicsArgs(argv);
    if (!command) throw new Error(CLINICS_USAGE);
    return runClinicsCommand(cliContext.get(ClinicsActivationService), command);
  };

  const loginAs = async (email: string): Promise<Session> => {
    const res = await request(http)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email, password: TEST_PASSWORD })
      .expect(201);
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
    return { cookieHeader, csrf: /veyra_csrf=([^;]+)/.exec(cookieHeader)?.[1] ?? '' };
  };
  const get = (path: string, s: Session) => request(http).get(path).set('Cookie', s.cookieHeader);

  /** Concessões `clinics:*` do workspace, como `systemKey|chave` ordenado. */
  const clinicsGrants = async (workspaceId: string): Promise<string[]> => {
    const rows = await prisma.raw.rolePermission.findMany({
      where: { workspaceId, permissionKey: { startsWith: 'clinics:' } },
      include: { role: { select: { systemKey: true, name: true } } },
    });
    return rows.map((r) => `${r.role.systemKey ?? r.role.name}|${r.permissionKey}`).sort();
  };
  const expectedMatrix = () =>
    Object.entries(CLINICS_ROLE_GRANTS)
      .flatMap(([systemKey, keys]) => keys.map((key) => `${systemKey}|${key}`))
      .sort();

  let wsA: WorkspaceFixture;
  let wsB: WorkspaceFixture;
  const tokenVersions = async (workspaceId: string) =>
    Object.fromEntries(
      (
        await prisma.raw.membership.findMany({
          where: { workspaceId },
          include: { role: { select: { systemKey: true } } },
        })
      ).map((m) => [m.role.systemKey, m.tokenVersion]),
    );

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma); // SÓ o catálogo do Core
    wsA = await createWorkspaceFixture(prisma, 'acme');
    wsB = await createWorkspaceFixture(prisma, 'beta');
    for (const systemKey of ['owner', 'admin', 'member', 'guest']) {
      const user = await createUserFixture(prisma, `${systemKey}-a@veyra.test`);
      await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles[systemKey]);
    }
    const ownerB = await createUserFixture(prisma, 'owner-b@veyra.test');
    await createMembershipFixture(prisma, wsB.workspaceId, ownerB, wsB.roles.owner);
  });

  // ── Critério da aprovação: registro global ≠ concessão ─────────────────────

  describe('registro do catálogo pela CLI × provisionamento', () => {
    it('depois que a CLI registra as chaves clinics:*, um workspace NOVO dá ao Owner zero chaves do Clinics até a ativação', async () => {
      expect(
        await prisma.raw.permission.count({ where: { key: { startsWith: 'clinics:' } } }),
      ).toBe(0);
      await cli('enable', '--slug', 'acme');
      // o catálogo GLOBAL agora tem as chaves do vertical
      expect(
        (
          await prisma.raw.permission.findMany({
            where: { key: { startsWith: 'clinics:' } },
            select: { key: true },
          })
        )
          .map((p) => p.key)
          .sort(),
      ).toEqual([...CLINICS_PERMISSION_KEYS].sort());

      // provisionamento REAL (o que a CLI `provision` chama)
      await createUserFixture(prisma, 'dona@nova.test');
      const nova = await cliContext
        .get(ProvisioningService)
        .provision({ name: 'Nova', slug: 'nova', ownerEmail: 'dona@nova.test' });
      expect(nova.owner).toBe('membership');

      expect(await clinicsGrants(nova.workspaceId)).toEqual([]);
      const ownerRole = await prisma.raw.role.findFirst({
        where: { workspaceId: nova.workspaceId, systemKey: 'owner' },
        include: { permissions: { select: { permissionKey: true } } },
      });
      expect(ownerRole!.permissions.map((p) => p.permissionKey).sort()).toEqual(
        [...SYSTEM_ROLE_TEMPLATES.Owner].sort(),
      );
      expect(
        await prisma.raw.role.count({
          where: { workspaceId: nova.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        }),
      ).toBe(0);
      expect(
        await prisma.raw.clinicsSettings.count({ where: { workspaceId: nova.workspaceId } }),
      ).toBe(0);

      // pela API: a sessão do Owner novo não tem nada do Clinics
      const dona = await loginAs('dona@nova.test');
      const me = await get('/api/auth/me', dona).expect(200);
      expect((me.body.permissions as string[]).filter((k) => k.startsWith('clinics:'))).toEqual([]);
      expect((await get('/api/clinics/status', dona).expect(200)).body).toEqual({ active: false });
      await get('/api/clinics/ai-releases', dona).expect(403);

      // ... até a ativação — que é o ÚNICO caminho que concede
      await cli('enable', '--slug', 'nova');
      expect(await clinicsGrants(nova.workspaceId)).toEqual(expectedMatrix());
      const depois = await loginAs('dona@nova.test');
      await get('/api/clinics/ai-releases', depois).expect(200);
    });

    it('argumentos inválidos não sobem nada; slug inexistente falha sem efeito', async () => {
      expect(parseClinicsArgs([])).toBeNull();
      expect(parseClinicsArgs(['enable'])).toBeNull();
      expect(parseClinicsArgs(['enable', '--slug'])).toBeNull();
      expect(parseClinicsArgs(['enable', '--slug', '--outro'])).toBeNull();
      expect(parseClinicsArgs(['activate', '--slug', 'acme'])).toBeNull();
      await expect(cli('enable', '--slug', 'nao-existe')).rejects.toThrow(/não encontrado/);
      expect(
        await prisma.raw.permission.count({ where: { key: { startsWith: 'clinics:' } } }),
      ).toBe(0);
    });
  });

  // ── P0: isolamento das tabelas do vertical ────────────────────────────────

  describe('isolamento por workspace (P0)', () => {
    const asWorkspace = <T>(workspaceId: string, fn: (db: PrismaService['db']) => Promise<T>) => {
      const cls = app.get(ClsService);
      return cls.run(async () => {
        cls.set('workspaceId', workspaceId);
        return fn(prisma.db);
      });
    };

    it('as três tabelas do vertical: um workspace nunca lê, altera nem apaga linha do outro', async () => {
      await cli('enable', '--slug', 'acme');
      await cli('enable', '--slug', 'beta');
      const [contatoA, contatoB] = await Promise.all(
        [wsA, wsB].map((ws) =>
          prisma.raw.contact.create({ data: { workspaceId: ws.workspaceId, name: 'Fornecedor' } }),
        ),
      );
      const [donoA, donoB] = await Promise.all(
        [wsA, wsB].map((ws) =>
          prisma.raw.membership.findFirst({
            where: { workspaceId: ws.workspaceId, role: { systemKey: 'owner' } },
          }),
        ),
      );
      await prisma.raw.clinicsContactRelease.create({
        data: {
          workspaceId: wsA.workspaceId,
          contactId: contatoA.id,
          consumer: 'ai',
          reason: 'supplier',
          releasedByMembershipId: donoA!.id,
        },
      });
      const liberacaoB = await prisma.raw.clinicsContactRelease.create({
        data: {
          workspaceId: wsB.workspaceId,
          contactId: contatoB.id,
          consumer: 'ai',
          reason: 'partner',
          releasedByMembershipId: donoB!.id,
        },
      });

      await asWorkspace(wsA.workspaceId, async (db) => {
        for (const rows of [
          await db.clinicsSettings.findMany(),
          await db.clinicsUnit.findMany(),
          await db.clinicsContactRelease.findMany(),
        ]) {
          expect(rows.length).toBe(1);
          expect(rows.every((r) => r.workspaceId === wsA.workspaceId)).toBe(true);
        }
        // nem por id explícito, nem escrevendo, nem apagando
        expect(
          await db.clinicsContactRelease.findFirst({ where: { id: liberacaoB.id } }),
        ).toBeNull();
        expect(
          (
            await db.clinicsContactRelease.updateMany({
              where: { id: liberacaoB.id },
              data: { reason: 'staff' },
            })
          ).count,
        ).toBe(0);
        expect(
          (await db.clinicsUnit.deleteMany({ where: { workspaceId: wsB.workspaceId } })).count,
        ).toBe(0);
        expect((await db.clinicsSettings.updateMany({ data: { status: 'disabled' } })).count).toBe(
          1,
        );
      });
      expect(
        (await prisma.raw.clinicsSettings.findFirst({ where: { workspaceId: wsB.workspaceId } }))!
          .status,
      ).toBe('active');
      expect(
        (await prisma.raw.clinicsContactRelease.findFirst({ where: { id: liberacaoB.id } }))!
          .reason,
      ).toBe('partner');
      expect(await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsB.workspaceId } })).toBe(
        1,
      );
    });

    it('fail-closed: sem workspace no contexto, e por chave única, o client protegido recusa', async () => {
      await cli('enable', '--slug', 'acme');
      const cls = app.get(ClsService);
      await cls.run(async () => {
        await expect(prisma.db.clinicsSettings.findMany()).rejects.toThrow();
        await expect(prisma.db.clinicsUnit.findMany()).rejects.toThrow();
        await expect(prisma.db.clinicsContactRelease.findMany()).rejects.toThrow();
      });
      const settings = await prisma.raw.clinicsSettings.findFirst({
        where: { workspaceId: wsA.workspaceId },
      });
      await asWorkspace(wsA.workspaceId, async (db) => {
        await expect(
          db.clinicsSettings.findUnique({ where: { workspaceId: wsA.workspaceId } }),
        ).rejects.toThrow();
        await expect(
          db.clinicsSettings.update({ where: { id: settings!.id }, data: { status: 'disabled' } }),
        ).rejects.toThrow();
      });
    });

    it('FK composta: liberação não aponta para contato nem membership de outro workspace', async () => {
      const contatoB = await prisma.raw.contact.create({
        data: { workspaceId: wsB.workspaceId, name: 'De outro workspace' },
      });
      const contatoA = await prisma.raw.contact.create({
        data: { workspaceId: wsA.workspaceId, name: 'Daqui' },
      });
      const donoA = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      const donoB = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsB.workspaceId, role: { systemKey: 'owner' } },
      });
      const liberar = (contactId: string, releasedByMembershipId: string) =>
        prisma.raw.clinicsContactRelease.create({
          data: {
            workspaceId: wsA.workspaceId,
            contactId,
            consumer: 'ai',
            reason: 'supplier',
            releasedByMembershipId,
          },
        });
      await expect(liberar(contatoB.id, donoA!.id)).rejects.toThrow();
      await expect(liberar(contatoA.id, donoB!.id)).rejects.toThrow();
      expect(await prisma.raw.clinicsContactRelease.count()).toBe(0);
      await liberar(contatoA.id, donoA!.id); // o par do MESMO workspace passa
    });
  });

  // ── Ciclo de vida (ADR-047 §4) ────────────────────────────────────────────

  describe('ciclo de vida', () => {
    it('enable concede a matriz por systemKey, cria Profissional e unidade; repetir não muda nada', async () => {
      const antesDoEnable = await tokenVersions(wsA.workspaceId);
      const linhas = await cli('enable', '--slug', 'acme');
      expect(linhas[0]).toMatch(/ATIVADO em acme/);

      expect(await clinicsGrants(wsA.workspaceId)).toEqual(expectedMatrix());
      const profissional = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        include: { permissions: { select: { permissionKey: true } } },
      });
      expect(profissional).toMatchObject({ name: 'Profissional', isSystem: true });
      expect(profissional!.permissions.map((p) => p.permissionKey).sort()).toEqual(
        [
          ...CLINICS_PROFESSIONAL_CORE_KEYS,
          ...CLINICS_ROLE_GRANTS[CLINICS_PROFESSIONAL_SYSTEM_KEY],
        ].sort(),
      );
      // Guest não recebe nada; o workspace B não é tocado
      expect((await clinicsGrants(wsA.workspaceId)).some((g) => g.startsWith('guest|'))).toBe(
        false,
      );
      expect(await clinicsGrants(wsB.workspaceId)).toEqual([]);
      // sessões de quem ganhou permissão caem; a do Guest não
      const depoisDoEnable = await tokenVersions(wsA.workspaceId);
      for (const key of ['owner', 'admin', 'member']) {
        expect(depoisDoEnable[key]).toBe(antesDoEnable[key] + 1);
      }
      expect(depoisDoEnable.guest).toBe(antesDoEnable.guest);

      const fotografia = await clinicsGrants(wsA.workspaceId);
      expect(await cli('enable', '--slug', 'acme')).toEqual([
        'Clinics já estava ativo em acme: nada mudou.',
      ]);
      expect(await clinicsGrants(wsA.workspaceId)).toEqual(fotografia);
      expect(await tokenVersions(wsA.workspaceId)).toEqual(depoisDoEnable);
      expect(await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
        1,
      );
      expect(
        await prisma.raw.auditLog.count({
          where: { workspaceId: wsA.workspaceId, action: { startsWith: 'clinics.' } },
        }),
      ).toBe(1);
    });

    it('enable → disable → enable → disable repetidos convergem: um Profissional, uma unidade, uma linha de ativação', async () => {
      await cli('enable', '--slug', 'acme');
      const ativo = await clinicsGrants(wsA.workspaceId);
      for (let i = 0; i < 2; i++) {
        expect((await cli('disable', '--slug', 'acme'))[0]).toMatch(/DESATIVADO/);
        expect(await cli('disable', '--slug', 'acme')).toEqual([
          'Clinics já não estava ativo em acme: nada mudou.',
        ]);
        expect(await clinicsGrants(wsA.workspaceId)).toEqual([]);
        expect((await cli('enable', '--slug', 'acme'))[0]).toMatch(/REATIVADO em acme/);
        expect(await clinicsGrants(wsA.workspaceId)).toEqual(ativo);
      }
      expect(
        await prisma.raw.role.count({
          where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        }),
      ).toBe(1);
      expect(await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
        1,
      );
      expect(
        await prisma.raw.clinicsSettings.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(1);
      const acoes = (
        await prisma.raw.auditLog.findMany({
          where: { workspaceId: wsA.workspaceId, action: { startsWith: 'clinics.' } },
          orderBy: { createdAt: 'asc' },
        })
      ).map((a) => a.action);
      expect(acoes).toEqual([
        'clinics.enabled',
        'clinics.disabled',
        'clinics.reenabled',
        'clinics.disabled',
        'clinics.reenabled',
      ]);
    });

    it('com o Clinics ATIVO, reexecutar enable preserva o ajuste feito pelo admin (não reconcede)', async () => {
      await cli('enable', '--slug', 'acme');
      // ajuste deliberado: a recepção deixa de remarcar
      await prisma.raw.rolePermission.deleteMany({
        where: {
          workspaceId: wsA.workspaceId,
          roleId: wsA.roles.member,
          permissionKey: 'clinics:schedule:write',
        },
      });
      await cli('enable', '--slug', 'acme');
      expect(await clinicsGrants(wsA.workspaceId)).not.toContain('member|clinics:schedule:write');
    });

    it('papel customizado chamado "Profissional": a ativação ABORTA e nada muda (nem catálogo, nem sessões)', async () => {
      const homonimo = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Profissional', isSystem: false },
      });
      const antes = await tokenVersions(wsA.workspaceId);
      await expect(cli('enable', '--slug', 'acme')).rejects.toThrow(/Já existe um papel chamado/);

      expect(await clinicsGrants(wsA.workspaceId)).toEqual([]);
      expect(
        await prisma.raw.permission.count({ where: { key: { startsWith: 'clinics:' } } }),
      ).toBe(0);
      expect(
        await prisma.raw.clinicsSettings.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(0);
      expect(await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
        0,
      );
      expect(
        await prisma.raw.role.count({
          where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        }),
      ).toBe(0);
      expect(await tokenVersions(wsA.workspaceId)).toEqual(antes);
      expect(await prisma.raw.role.findFirst({ where: { id: homonimo.id } })).toMatchObject({
        name: 'Profissional',
        systemKey: null,
      });

      // renomeado o homônimo, a ativação segue — e o papel do vertical é OUTRO
      await prisma.raw.role.updateMany({
        where: { id: homonimo.id },
        data: { name: 'Profissional (antigo)' },
      });
      await cli('enable', '--slug', 'acme');
      const doVertical = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
      });
      expect(doVertical!.id).not.toBe(homonimo.id);
    });

    it('disable: nenhuma clinics:* resta (nem em papel customizado), Profissional fica só com o Core, dados ficam, sessões caem', async () => {
      await cli('enable', '--slug', 'acme');
      // papel customizado que recebeu chave do vertical por fora da matriz
      const recepcao = await prisma.raw.role.create({
        data: { workspaceId: wsA.workspaceId, name: 'Recepção noturna', isSystem: false },
      });
      await prisma.raw.rolePermission.create({
        data: {
          workspaceId: wsA.workspaceId,
          roleId: recepcao.id,
          permissionKey: 'clinics:schedule:read',
        },
      });
      const noturna = await createUserFixture(prisma, 'noturna@veyra.test');
      await createMembershipFixture(prisma, wsA.workspaceId, noturna, recepcao.id);
      const contato = await prisma.raw.contact.create({
        data: { workspaceId: wsA.workspaceId, name: 'Fornecedor' },
      });
      const dono = await prisma.raw.membership.findFirst({
        where: { workspaceId: wsA.workspaceId, role: { systemKey: 'owner' } },
      });
      await prisma.raw.clinicsContactRelease.create({
        data: {
          workspaceId: wsA.workspaceId,
          contactId: contato.id,
          consumer: 'ai',
          reason: 'supplier',
          releasedByMembershipId: dono!.id,
        },
      });

      const sessoes = {
        owner: await loginAs('owner-a@veyra.test'),
        noturna: await loginAs('noturna@veyra.test'),
        guest: await loginAs('guest-a@veyra.test'),
      };
      for (const s of Object.values(sessoes)) await get('/api/auth/me', s).expect(200);

      await cli('disable', '--slug', 'acme');

      expect(
        await prisma.raw.rolePermission.count({
          where: { workspaceId: wsA.workspaceId, permissionKey: { startsWith: 'clinics:' } },
        }),
      ).toBe(0);
      const profissional = await prisma.raw.role.findFirst({
        where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        include: { permissions: { select: { permissionKey: true } } },
      });
      expect(profissional!.permissions.map((p) => p.permissionKey)).toEqual([
        ...CLINICS_PROFESSIONAL_CORE_KEYS,
      ]);
      // nada de dado apagado; a linha de ativação fica, desativada
      expect(
        await prisma.raw.clinicsSettings.findFirst({ where: { workspaceId: wsA.workspaceId } }),
      ).toMatchObject({ status: 'disabled', disabledAt: expect.any(Date) });
      expect(await prisma.raw.clinicsUnit.count({ where: { workspaceId: wsA.workspaceId } })).toBe(
        1,
      );
      expect(
        await prisma.raw.clinicsContactRelease.count({ where: { workspaceId: wsA.workspaceId } }),
      ).toBe(1);
      // quem tinha chave do vertical cai na request seguinte; o Guest, não
      await get('/api/auth/me', sessoes.owner).expect(401);
      await get('/api/auth/me', sessoes.noturna).expect(401);
      await get('/api/auth/me', sessoes.guest).expect(200);
      // o catálogo GLOBAL não encolhe: ele não concede nada a ninguém
      expect(
        await prisma.raw.permission.count({ where: { key: { startsWith: 'clinics:' } } }),
      ).toBe(CLINICS_PERMISSION_KEYS.length);
    });

    it('com outra ativação EM ANDAMENTO no workspace, enable e disable recusam sem efeito; outro workspace não espera', async () => {
      const trava = new Client({ connectionString: TEST_DATABASE_URL });
      await trava.connect();
      try {
        await trava.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [
          'clinics_activation',
          wsA.workspaceId,
        ]);
        await expect(cli('enable', '--slug', 'acme')).rejects.toThrow(/em andamento/);
        expect(await clinicsGrants(wsA.workspaceId)).toEqual([]);
        expect(
          await prisma.raw.clinicsSettings.count({ where: { workspaceId: wsA.workspaceId } }),
        ).toBe(0);
        expect(
          await prisma.raw.permission.count({ where: { key: { startsWith: 'clinics:' } } }),
        ).toBe(0);
        // a trava é POR workspace
        expect((await cli('enable', '--slug', 'beta'))[0]).toMatch(/ATIVADO em beta/);

        await trava.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          'clinics_activation',
          wsA.workspaceId,
        ]);
        expect((await cli('enable', '--slug', 'acme'))[0]).toMatch(/ATIVADO em acme/);

        await trava.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [
          'clinics_activation',
          wsA.workspaceId,
        ]);
        await expect(cli('disable', '--slug', 'acme')).rejects.toThrow(/em andamento/);
        expect(await clinicsGrants(wsA.workspaceId)).toEqual(expectedMatrix());
      } finally {
        await trava.end();
      }
    });

    it('comandos simultâneos: cada um conclui ou recusa por "em andamento", e o estado final é coerente', async () => {
      await cli('enable', '--slug', 'acme');
      const resultados = await Promise.allSettled([
        cli('disable', '--slug', 'acme'),
        cli('enable', '--slug', 'acme'),
        cli('disable', '--slug', 'acme'),
        cli('enable', '--slug', 'acme'),
      ]);
      for (const r of resultados) {
        if (r.status === 'rejected') expect(String(r.reason)).toMatch(/em andamento/);
      }
      const settings = await prisma.raw.clinicsSettings.findFirst({
        where: { workspaceId: wsA.workspaceId },
      });
      // ativo ⇔ matriz completa; desativado ⇔ nenhuma chave
      expect(await clinicsGrants(wsA.workspaceId)).toEqual(
        settings!.status === 'active' ? expectedMatrix() : [],
      );
      expect(
        await prisma.raw.role.count({
          where: { workspaceId: wsA.workspaceId, systemKey: CLINICS_PROFESSIONAL_SYSTEM_KEY },
        }),
      ).toBe(1);
    });

    it('a CLI avisa sobre webhooks ativos, e a limpeza de IA pós-commit roda (sem aviso de falha)', async () => {
      const dono = await loginAs('owner-a@veyra.test');
      await request(http)
        .post('/api/webhooks')
        .set('Origin', ORIGIN)
        .set('Cookie', dono.cookieHeader)
        .set('x-csrf-token', dono.csrf)
        .send({ url: 'https://destino.veyra.test/hook', events: ['contact.created'] })
        .expect(201);
      const linhas = await cli('enable', '--slug', 'acme');
      expect(linhas).toContainEqual(expect.stringMatching(/^ATENÇÃO: 1 webhook\(s\) ativo\(s\)/));
      expect(linhas.some((l) => /limpeza do conteúdo de IA anterior falhou/.test(l))).toBe(false);
      const report = await cliContext.get(ClinicsActivationService).enable('acme');
      expect(report).toMatchObject({ outcome: 'already_active', activeWebhooks: 1 });
    });

    it('reativar atualiza `activatedAt` para a ativação vigente e limpa `disabledAt`', async () => {
      await cli('enable', '--slug', 'acme');
      const primeira = await prisma.raw.clinicsSettings.findFirst({
        where: { workspaceId: wsA.workspaceId },
      });
      await cli('disable', '--slug', 'acme');
      await cli('enable', '--slug', 'acme');
      const vigente = await prisma.raw.clinicsSettings.findFirst({
        where: { workspaceId: wsA.workspaceId },
      });
      expect(vigente!.activatedAt.getTime()).toBeGreaterThan(primeira!.activatedAt.getTime());
      expect(vigente!.disabledAt).toBeNull();
    });
  });
});

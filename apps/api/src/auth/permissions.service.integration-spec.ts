import { ClsService } from 'nestjs-cls';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { createTestApp } from '../../test/integration/app';
import {
  createMembershipFixture,
  createUserFixture,
  createWorkspaceFixture,
  seedPermissionCatalog,
  type WorkspaceFixture,
} from '../../test/integration/fixtures';
import { resetDb } from '../../test/integration/harness';
import { PermissionsService } from './permissions.service';

/**
 * A primitiva de autorização condicional de CAMPO (§4) não tinha teste próprio,
 * e a linha que importa é a fail-closed: sem `roleId` no contexto, um `where`
 * sem filtro concederia TODA permissão do workspace.
 */
describe('PermissionsService — autorização condicional (integração)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: PermissionsService;
  let cls: ClsService;
  let wsA: WorkspaceFixture;
  let membershipId: string;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    service = app.get(PermissionsService);
    cls = app.get(ClsService);
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    await seedPermissionCatalog(prisma);
    wsA = await createWorkspaceFixture(prisma, 'acme');
    const user = await createUserFixture(prisma, 'owner-a@veyra.test');
    membershipId = await createMembershipFixture(prisma, wsA.workspaceId, user, wsA.roles.owner);
  });

  const auth = () => ({
    userId: 'u',
    email: 'owner-a@veyra.test',
    membershipId,
    workspaceId: wsA.workspaceId,
    sessionId: 's',
  });

  it('sem `roleId` no contexto, NEGA — mesmo para quem tem a permissão', async () => {
    const permitido = await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      // roleId ausente de propósito: é o caso que o `where` sem filtro estragaria
      return service.has(auth(), 'billing:manage');
    });
    expect(permitido).toBe(false);
  });

  it('sem membership ativa na sessão, NEGA', async () => {
    const permitido = await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      cls.set('roleId', wsA.roles.owner);
      return service.has({ ...auth(), membershipId: null }, 'billing:manage');
    });
    expect(permitido).toBe(false);
  });

  it('com contexto completo, decide pela PERMISSÃO do papel', async () => {
    const resultado = await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      cls.set('roleId', wsA.roles.owner);
      return {
        owner: await service.has(auth(), 'billing:manage'),
      };
    });
    expect(resultado.owner).toBe(true);

    // Admin tem tudo MENOS billing:manage — a diferença que separa permissão de papel
    const comoAdmin = await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      cls.set('roleId', wsA.roles.admin);
      return service.has(auth(), 'billing:manage');
    });
    expect(comoAdmin).toBe(false);
  });

  it('`roleId` de OUTRO workspace não concede nada', async () => {
    const wsB = await createWorkspaceFixture(prisma, 'beta');
    const permitido = await cls.run(async () => {
      cls.set('workspaceId', wsA.workspaceId);
      cls.set('roleId', wsB.roles.owner); // role existe, mas é de outro tenant
      return service.has(auth(), 'billing:manage');
    });
    expect(permitido).toBe(false);
  });
});

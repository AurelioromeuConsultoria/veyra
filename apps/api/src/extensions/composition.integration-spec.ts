import { Controller, Get, type INestApplication } from '@nestjs/common';
import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES, type PermissionKey } from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from '../workspaces/provisioning.service';
import { COMPOSITION } from '../composition';
import { createTestApp } from '../../test/integration/app';
import { resetDb } from '../../test/integration/harness';
import { PermissionCatalogCheck } from './permission-catalog.check';
import { EXTENSION_REGISTRY, composeRegistry } from './registry';

/** Rota que exige uma chave que não existe em catálogo nenhum. */
@Controller('test-unknown-permission')
class UnknownPermissionController {
  @RequirePermissions('naoexiste:ler' as PermissionKey)
  @Get()
  handle(): string {
    return 'nunca';
  }
}

/**
 * Extensão de teste com catálogo próprio, composta JUNTO com o que o produto
 * já compõe (as rotas dos verticais reais exigem as chaves deles no boot).
 */
const demoRegistry = () =>
  composeRegistry([
    ...COMPOSITION.extensions,
    {
      name: 'demo',
      permissionCatalog: { 'demo:read': 'Ver demo', 'demo:manage': 'Gerir demo' },
    },
  ]);

describe('composição de extensões (ADR-047 E2, integração)', () => {
  it('BOOT: rota exigindo chave fora do catálogo composto impede a aplicação de subir', async () => {
    await expect(createTestApp([UnknownPermissionController])).rejects.toThrow(
      /naoexiste:ler.*ADR-047/,
    );
  });

  it('BOOT: o Core de hoje sobe limpo — nenhuma rota exige chave desconhecida', async () => {
    const app = await createTestApp();
    try {
      expect(app.get(PermissionCatalogCheck).unknownKeys()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  describe('provisionamento com uma extensão composta', () => {
    let app: INestApplication;
    let prisma: PrismaService;

    beforeAll(async () => {
      app = await createTestApp([], [{ provide: EXTENSION_REGISTRY, useValue: demoRegistry() }]);
      prisma = app.get(PrismaService);
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(async () => {
      await resetDb(prisma);
    });

    it('depois que a extensão REGISTRA suas chaves no catálogo global, provisionar ainda concede zero delas', async () => {
      // o que a CLI de ativação de um vertical fará: gravar as chaves dele no
      // catálogo global `Permission` (a FK de RolePermission exige)
      for (const key of ['demo:read', 'demo:manage']) {
        await prisma.raw.permission.create({ data: { key, description: 'chave de extensão' } });
      }

      await app
        .get(ProvisioningService)
        .provision({ name: 'Nova', slug: 'nova', ownerEmail: 'dono@nova.test' });

      const workspace = await prisma.raw.workspace.findFirst({ where: { slug: 'nova' } });
      const owner = await prisma.raw.role.findFirst({
        where: { workspaceId: workspace!.id, systemKey: 'owner' },
      });
      const doOwner = await prisma.raw.rolePermission.findMany({
        where: { roleId: owner!.id },
        select: { permissionKey: true },
      });
      // o Owner recebe EXATAMENTE o template do Core — nada do catálogo global a mais
      expect(doOwner.map((row) => row.permissionKey).sort()).toEqual(
        [...SYSTEM_ROLE_TEMPLATES.Owner].sort(),
      );
      // e nenhum papel do workspace novo recebe chave da extensão
      const daExtensao = await prisma.raw.rolePermission.count({
        where: { workspaceId: workspace!.id, permissionKey: { startsWith: 'demo:' } },
      });
      expect(daExtensao).toBe(0);
    });

    it('NÃO concede, nem registra no catálogo, nenhuma chave da extensão', async () => {
      await app
        .get(ProvisioningService)
        .provision({ name: 'Clínica X', slug: 'clinica-x', ownerEmail: 'dono@x.test' });

      const concedidas = await prisma.raw.rolePermission.findMany({
        select: { permissionKey: true },
      });
      expect(concedidas.length).toBeGreaterThan(0);
      const core = new Set(Object.keys(PERMISSION_CATALOG));
      expect(concedidas.filter((row) => !core.has(row.permissionKey))).toEqual([]);
      expect(concedidas.some((row) => row.permissionKey.startsWith('demo:'))).toBe(false);

      // o catálogo global também não ganha as chaves: registrá-las é da CLI da
      // extensão, na ativação (F1.b)
      const catalogo = await prisma.raw.permission.findMany({ select: { key: true } });
      expect(catalogo.some((row) => row.key.startsWith('demo:'))).toBe(false);
    });
  });
});

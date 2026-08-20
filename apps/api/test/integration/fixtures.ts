import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES } from '@veyra/contracts';
import { hash } from 'bcryptjs';
import { DEFAULT_STAGES } from '../../src/pipelines/pipelines.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Fixtures de teste — prisma.raw justificado: provisionamento de cenário
 * (workspace + roles de sistema + usuário + membership), o mesmo papel da
 * rotina administrativa real.
 */

export async function seedPermissionCatalog(prisma: PrismaService): Promise<void> {
  for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
    await prisma.raw.permission.upsert({
      where: { key },
      create: { key, description },
      update: {},
    });
  }
}

export interface WorkspaceFixture {
  workspaceId: string;
  roles: Record<string, string>; // systemKey → roleId
  pipelineId: string;
  stages: Record<string, string>; // nome → stageId
}

export async function createWorkspaceFixture(
  prisma: PrismaService,
  slug: string,
): Promise<WorkspaceFixture> {
  const workspace = await prisma.raw.workspace.create({
    data: { name: slug.toUpperCase(), slug },
  });
  const roles: Record<string, string> = {};
  for (const [name, keys] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
    const systemKey = name.toLowerCase();
    const role = await prisma.raw.role.create({
      data: { workspaceId: workspace.id, name, isSystem: true, systemKey },
    });
    await prisma.raw.rolePermission.createMany({
      data: keys.map((key) => ({
        workspaceId: workspace.id,
        roleId: role.id,
        permissionKey: key,
      })),
    });
    roles[systemKey] = role.id;
  }
  // canal interno de sistema, como o provisionamento real faz (ADR-023)
  await prisma.raw.channel.create({
    data: { workspaceId: workspace.id, type: 'internal', name: 'Interno', systemMark: true },
  });
  // pipeline padrão, como o provisionamento real faz
  const pipeline = await prisma.raw.pipeline.create({
    data: { workspaceId: workspace.id, name: 'Vendas', defaultMark: true },
  });
  const stages: Record<string, string> = {};
  for (const stage of DEFAULT_STAGES) {
    const created = await prisma.raw.stage.create({
      data: { ...stage, workspaceId: workspace.id, pipelineId: pipeline.id },
    });
    stages[stage.name] = created.id;
  }
  return { workspaceId: workspace.id, roles, pipelineId: pipeline.id, stages };
}

export const TEST_PASSWORD = 'senha-de-teste-123';

export async function createUserFixture(prisma: PrismaService, email: string): Promise<string> {
  const user = await prisma.raw.user.create({
    data: { email, name: email.split('@')[0], passwordHash: await hash(TEST_PASSWORD, 4) },
  });
  return user.id;
}

export async function createMembershipFixture(
  prisma: PrismaService,
  workspaceId: string,
  userId: string,
  roleId: string,
): Promise<string> {
  const membership = await prisma.raw.membership.create({
    data: { workspaceId, userId, roleId },
  });
  return membership.id;
}

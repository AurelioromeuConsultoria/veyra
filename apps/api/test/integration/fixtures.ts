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
  // o catálogo de planos é GLOBAL e o resetDb o trunca junto com o resto
  // (como acontece com Permission): recriar aqui mantém a fixture fiel ao
  // provisionamento real, que encontra o catálogo já semeado pela migration
  await seedPlanCatalog(prisma);
  const basePlan = await prisma.raw.plan.findFirst({ where: { isDefault: true } });
  if (basePlan) {
    const periodEnd = new Date();
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    await prisma.raw.subscription.create({
      data: {
        workspaceId: workspace.id,
        planKey: basePlan.key,
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
      },
    });
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

/**
 * Catálogo GLOBAL de planos e limites (ADR-034), espelhando a migration.
 * Idempotente: pode ser chamado por qualquer fixture.
 */
export async function seedPlanCatalog(prisma: PrismaService): Promise<void> {
  const plans = [
    { key: 'base', name: 'Base', priceCents: 0, isDefault: true },
    { key: 'pro', name: 'Pro', priceCents: 9900, isDefault: null },
  ];
  for (const plan of plans) {
    await prisma.raw.plan.upsert({ where: { key: plan.key }, create: plan, update: {} });
  }
  const limits: { planKey: string; metric: string; kind: 'gauge' | 'counter'; value: bigint }[] = [
    { planKey: 'base', metric: 'contacts', kind: 'gauge', value: 2000n },
    { planKey: 'base', metric: 'storage_bytes', kind: 'gauge', value: 1073741824n },
    { planKey: 'base', metric: 'ai_runs', kind: 'counter', value: 200n },
    { planKey: 'base', metric: 'ai_cost_cents', kind: 'counter', value: 500n },
    { planKey: 'base', metric: 'messages_sent', kind: 'counter', value: 1000n },
    { planKey: 'pro', metric: 'contacts', kind: 'gauge', value: 50000n },
    { planKey: 'pro', metric: 'storage_bytes', kind: 'gauge', value: 10737418240n },
    { planKey: 'pro', metric: 'ai_runs', kind: 'counter', value: 5000n },
    { planKey: 'pro', metric: 'ai_cost_cents', kind: 'counter', value: 20000n },
    { planKey: 'pro', metric: 'messages_sent', kind: 'counter', value: 20000n },
  ];
  for (const limit of limits) {
    await prisma.raw.planLimit.upsert({
      where: { planKey_metric: { planKey: limit.planKey, metric: limit.metric } },
      create: limit,
      update: { value: limit.value },
    });
  }
}

/** Aperta um limite do plano-base para exercitar o estouro sem criar 2000 linhas. */
export async function setPlanLimit(
  prisma: PrismaService,
  metric: string,
  value: number,
  planKey = 'base',
): Promise<void> {
  await prisma.raw.planLimit.upsert({
    where: { planKey_metric: { planKey, metric } },
    create: {
      planKey,
      metric,
      kind: metric.startsWith('ai_') || metric === 'messages_sent' ? 'counter' : 'gauge',
      value: BigInt(value),
    },
    update: { value: BigInt(value) },
  });
}

/**
 * Torna um evento do outbox reivindicável, com o backoff JÁ VENCIDO pelo
 * relógio do BANCO.
 *
 * Vencido há um minuto, não "exatamente agora": agendar para o instante presente
 * deixa a elegibilidade na dependência de microssegundos entre a escrita e o
 * claim — e um lock ainda não liberado é pulado em silêncio pelo `SKIP LOCKED`.
 * O diagnóstico capturou o caso: `elegivel: true` com "vencido há 0,6 ms",
 * medido depois da drenagem que não reivindicou nada. A margem exprime o que o
 * teste quer dizer ("o backoff já passou") sem trazer de volta o relógio do
 * processo, que era o defeito original.
 *
 * Escrever `nextRetryAt: new Date()` do Node misturava relógios: o claim compara
 * com `now()` do Postgres, e qualquer desvio entre processo e banco deixava a
 * linha inelegível — foi a causa da "flake de 1 em 6" (o desvio era de 2 ms) e,
 * com o relógio da VM 47 s atrás, de dezenas de falhas simultâneas. O horário
 * tem de nascer de quem o compara.
 */
export async function makeRetriableNowById(prisma: PrismaService, id: string): Promise<void> {
  await prisma.raw.$executeRawUnsafe(
    `UPDATE "OutboxEvent"
        SET "nextRetryAt" = now() - interval '1 minute', "status" = 'pending',
            "claimToken" = NULL, "leaseExpiresAt" = NULL
      WHERE "id" = $1::uuid`,
    id,
  );
}

export async function makeRetriableNow(prisma: PrismaService, eventType: string): Promise<void> {
  /**
   * Só ADIANTA o relógio de quem já está `pending`. A primeira versão também
   * zerava `status` e `claimToken`, o que RESSUSCITAVA eventos entregues ou
   * mortos do mesmo tipo — e o `drain` seguinte reivindicava o revivido em vez
   * do alvo, quebrando testes que não tinham nada a ver com o horário. Para
   * reabrir um evento específico existe `makeRetriableNowById`.
   */
  await prisma.raw.$executeRawUnsafe(
    `UPDATE "OutboxEvent"
        SET "nextRetryAt" = now() - interval '1 minute'
      WHERE "eventType" = $1 AND "status" = 'pending'`,
    eventType,
  );
}

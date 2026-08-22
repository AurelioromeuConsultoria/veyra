/**
 * CLI administrativa de plano (ADR-034): não existe endpoint para trocar de
 * plano — assinatura é decisão comercial, pelo mesmo caminho justificado do
 * provisionamento de workspace.
 *
 *   pnpm --filter @veyra/api plan --slug acme --plan pro
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const planKey = arg('plan');
  if (!slug || !planKey) {
    console.error('uso: plan --slug <workspace> --plan <base|pro>');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });
  try {
    const workspace = await prisma.workspace.findUnique({ where: { slug } });
    if (!workspace) throw new Error(`Workspace não encontrado: ${slug}`);
    const plan = await prisma.plan.findUnique({ where: { key: planKey } });
    if (!plan) throw new Error(`Plano não encontrado: ${planKey}`);

    const periodStart = new Date();
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    await prisma.subscription.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        planKey: plan.key,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
      update: { planKey: plan.key, status: 'active' },
    });

    const limits = await prisma.planLimit.findMany({ where: { planKey: plan.key } });
    console.log(`Workspace "${slug}" agora no plano "${plan.name}". Limites:`);
    for (const limit of limits) {
      console.log(`  ${limit.metric.padEnd(16)} ${limit.kind.padEnd(8)} ${limit.value}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();

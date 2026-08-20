import { Controller, Get } from '@nestjs/common';
import type { UsageOverviewDto } from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(
    private readonly usage: UsageService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Consumo e plano vigente. `workspace:read` e não `billing:manage`: saber
   * quanto falta para o teto é informação de trabalho — quem vai esbarrar no
   * limite precisa ver antes de esbarrar. Alterar plano é que é de billing.
   */
  @RequirePermissions('workspace:read')
  @Get()
  async overview(@CurrentAuth() auth: AuthContext): Promise<UsageOverviewDto> {
    const workspaceId = auth.workspaceId as string;
    // raw justificado: Plan é catálogo GLOBAL (ADR-034), fora do client filtrado
    const subscription = await this.prisma.raw.subscription.findFirst({
      where: { workspaceId },
      include: { plan: true },
    });
    return {
      subscription: subscription
        ? {
            plan: {
              key: subscription.plan.key,
              name: subscription.plan.name,
              priceCents: subscription.plan.priceCents,
            },
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
          }
        : null,
      metrics: await this.usage.snapshot(workspaceId),
    };
  }
}

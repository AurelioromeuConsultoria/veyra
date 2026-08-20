import { ConflictException, Injectable } from '@nestjs/common';
import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES } from '@veyra/contracts';
import { generateOpaqueToken, sha256 } from '../auth/tokens';
import { DEFAULT_STAGES } from '../pipelines/pipelines.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ProvisionInput {
  name: string;
  slug: string;
  ownerEmail: string;
}

export type ProvisionResult =
  | { workspaceId: string; owner: 'membership'; membershipId: string }
  | {
      workspaceId: string;
      owner: 'invite';
      inviteId: string;
      /** Exibido UMA única vez pelo operador (ajuste #3) — só o hash persiste. */
      inviteToken: string;
      expiresAt: Date;
    };

const OWNER_INVITE_TTL_DAYS = 7;

/**
 * Provisionamento controlado de workspace (ADR-014): rotina ADMINISTRATIVA,
 * sem endpoint público — invocada pelo CLI (scripts/provision-workspace.ts).
 * prisma.raw justificado: provisionamento cria o próprio tenant (não existe
 * contexto de workspace antes dele existir).
 *
 * Owner (ajuste #3): e-mail existente → Membership Owner; inexistente → Invite
 * Owner (NUNCA um User incompleto). O token do convite é retornado ao operador
 * para entrega por canal seguro e não é registrado em log nem em claro no banco.
 */
@Injectable()
export class ProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const existingSlug = await this.prisma.raw.workspace.findUnique({
      where: { slug: input.slug },
    });
    if (existingSlug) throw new ConflictException(`Slug já em uso: ${input.slug}`);

    // catálogo global primeiro (idempotente) — roles referenciam as chaves
    for (const [key, description] of Object.entries(PERMISSION_CATALOG)) {
      await this.prisma.raw.permission.upsert({
        where: { key },
        create: { key, description },
        update: { description },
      });
    }

    const ownerUser = await this.prisma.raw.user.findUnique({
      where: { email: input.ownerEmail },
    });

    return this.prisma.raw.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: input.name, slug: input.slug },
      });

      // pipeline padrão (ajuste #2): workspace novo nasce com fluxo utilizável —
      // os antigos receberam pelo backfill idempotente da migration
      const pipeline = await tx.pipeline.create({
        data: { workspaceId: workspace.id, name: 'Vendas', defaultMark: true },
      });
      await tx.stage.createMany({
        data: DEFAULT_STAGES.map((stage) => ({
          ...stage,
          workspaceId: workspace.id,
          pipelineId: pipeline.id,
        })),
      });

      // assinatura no plano-base (ADR-034): sem ela não haveria limite
      // aplicável, e o workspace ficaria sem o equivalente ao default-deny
      const basePlan = await tx.plan.findFirst({ where: { isDefault: true } });
      if (basePlan) {
        const periodStart = new Date();
        const periodEnd = new Date(periodStart);
        periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
        await tx.subscription.create({
          data: {
            workspaceId: workspace.id,
            planKey: basePlan.key,
            currentPeriodStart: periodStart,
            currentPeriodEnd: periodEnd,
          },
        });
      }

      // canal interno de sistema (ADR-023): exatamente um por workspace, com a
      // unicidade garantida pelo unique parcial — os antigos vieram do backfill
      await tx.channel.create({
        data: { workspaceId: workspace.id, type: 'internal', name: 'Interno', systemMark: true },
      });

      let ownerRoleId = '';
      for (const [name, keys] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
        const systemKey = name.toLowerCase();
        const role = await tx.role.create({
          data: { workspaceId: workspace.id, name, isSystem: true, systemKey },
        });
        await tx.rolePermission.createMany({
          data: keys.map((key) => ({
            workspaceId: workspace.id,
            roleId: role.id,
            permissionKey: key,
          })),
        });
        if (systemKey === 'owner') ownerRoleId = role.id;
      }

      if (ownerUser) {
        const membership = await tx.membership.create({
          data: { workspaceId: workspace.id, userId: ownerUser.id, roleId: ownerRoleId },
        });
        return {
          workspaceId: workspace.id,
          owner: 'membership' as const,
          membershipId: membership.id,
        };
      }

      const token = generateOpaqueToken();
      const expiresAt = new Date(Date.now() + OWNER_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
      const invite = await tx.invite.create({
        data: {
          workspaceId: workspace.id,
          email: input.ownerEmail,
          roleId: ownerRoleId,
          tokenHash: sha256(token),
          expiresAt,
        },
      });
      return {
        workspaceId: workspace.id,
        owner: 'invite' as const,
        inviteId: invite.id,
        inviteToken: token,
        expiresAt,
      };
    });
  }
}

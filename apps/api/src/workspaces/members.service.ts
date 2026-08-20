import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MemberDto, RoleDto } from '@veyra/contracts';
import { AuthContext } from '../common/decorators';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Cliente de transação raw (sem filtro de workspace — escopo manual explícito). */
type Tx = Prisma.TransactionClient;

@Injectable()
export class MembersService {
  constructor(private readonly prisma: PrismaService) {}

  async listRoles(): Promise<RoleDto[]> {
    const roles = await this.prisma.db.role.findMany({ orderBy: { createdAt: 'asc' } });
    const rolePermissions = await this.prisma.db.rolePermission.findMany();
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      isSystem: role.isSystem,
      permissions: rolePermissions
        .filter((rp) => rp.roleId === role.id)
        .map((rp) => rp.permissionKey),
    }));
  }

  async listMembers(): Promise<MemberDto[]> {
    const memberships = await this.prisma.db.membership.findMany({
      where: { status: { not: 'removed' } },
      include: { role: true }, // protegido→protegido: permitido (FK composta)
      orderBy: { createdAt: 'asc' },
    });
    // raw justificado: identidade global (nome/e-mail) para exibição, restrita
    // aos userIds das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return memberships.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      name: byId.get(m.userId)?.name ?? '',
      email: byId.get(m.userId)?.email ?? '',
      roleId: m.roleId,
      roleName: (m as unknown as { role: { name: string } }).role.name,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  async changeRole(auth: AuthContext, membershipId: string, roleId: string): Promise<void> {
    // anti-autoelevação (ajuste #6): ninguém altera a própria membership
    if (membershipId === auth.membershipId) {
      throw new ForbiddenException(
        'Você não pode alterar a própria função — peça a outro administrador',
      );
    }
    const workspaceId = this.requireWorkspace(auth);
    await this.runWorkspaceLocked(workspaceId, async (tx) => {
      const actorPerms = await this.actorPermissions(tx, workspaceId, auth.membershipId);
      const target = await tx.membership.findFirst({
        where: { id: membershipId, workspaceId, status: { not: 'removed' } },
        include: { role: true },
      });
      if (!target) throw new NotFoundException('Membro não encontrado');
      const newRole = await tx.role.findFirst({ where: { id: roleId, workspaceId } });
      if (!newRole) throw new NotFoundException('Função não encontrada');

      // não se toca em quem é mais poderoso, nem se concede o que não se tem
      await this.assertRoleWithinActor(tx, workspaceId, actorPerms, target.roleId);
      await this.assertRoleWithinActor(tx, workspaceId, actorPerms, roleId);

      const targetRole = (target as unknown as { role: { systemKey: string | null } }).role;
      if (targetRole.systemKey === 'owner' && newRole.systemKey !== 'owner') {
        await this.assertNotLastActiveOwner(tx, workspaceId);
      }
      // tokenVersion++: permissões mudaram → sessões existentes caem (ADR-009)
      await tx.membership.updateMany({
        where: { id: membershipId, workspaceId },
        data: { roleId, tokenVersion: { increment: 1 } },
      });
    });
  }

  async removeMember(auth: AuthContext, membershipId: string): Promise<void> {
    if (membershipId === auth.membershipId) {
      throw new ForbiddenException('Você não pode remover a si mesmo — peça a outro administrador');
    }
    const workspaceId = this.requireWorkspace(auth);
    await this.runWorkspaceLocked(workspaceId, async (tx) => {
      const actorPerms = await this.actorPermissions(tx, workspaceId, auth.membershipId);
      const target = await tx.membership.findFirst({
        where: { id: membershipId, workspaceId, status: { not: 'removed' } },
        include: { role: true },
      });
      if (!target) throw new NotFoundException('Membro não encontrado');
      // não se remove quem é mais poderoso que o ator (P1-5)
      await this.assertRoleWithinActor(tx, workspaceId, actorPerms, target.roleId);
      const targetRole = (target as unknown as { role: { systemKey: string | null } }).role;
      if (targetRole.systemKey === 'owner') {
        await this.assertNotLastActiveOwner(tx, workspaceId);
      }
      await tx.membership.updateMany({
        where: { id: membershipId, workspaceId },
        data: { status: 'removed', tokenVersion: { increment: 1 } },
      });
    });
  }

  /**
   * Anti-autoelevação (ajuste #6, público — reusado por InvitesService): as
   * permissões do papel `roleId` devem ser SUBCONJUNTO das do ator. Roda fora
   * de transação (leitura), fail-closed se o ator não resolver.
   */
  async assertNoPrivilegeEscalation(auth: AuthContext, roleId: string): Promise<void> {
    const workspaceId = this.requireWorkspace(auth);
    const actorPerms = await this.actorPermissions(this.prisma.raw, workspaceId, auth.membershipId);
    await this.assertRoleWithinActor(this.prisma.raw, workspaceId, actorPerms, roleId);
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private requireWorkspace(auth: AuthContext): string {
    if (!auth.workspaceId || !auth.membershipId) {
      throw new ForbiddenException('Nenhum workspace ativo nesta sessão');
    }
    return auth.workspaceId;
  }

  /**
   * Seção crítica serializada por workspace (advisory lock transacional):
   * fecha o TOCTOU do último Owner e de trocas concorrentes (P1-4). raw
   * justificado: invariante de acesso concorrente, escopo manual por workspaceId.
   */
  private runWorkspaceLocked<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        'veyra_members',
        workspaceId,
      );
      return fn(tx);
    });
  }

  private async actorPermissions(
    client: Tx | PrismaService['raw'],
    workspaceId: string,
    actorMembershipId: string | null,
  ): Promise<Set<string>> {
    const actor = actorMembershipId
      ? await client.membership.findFirst({
          where: { id: actorMembershipId, workspaceId, status: 'active' },
          select: { roleId: true },
        })
      : null;
    // fail-closed: ator sem membership/role válido não pode conceder nada
    if (!actor?.roleId) {
      throw new ForbiddenException('Ação indisponível para esta sessão');
    }
    const rows = await client.rolePermission.findMany({
      where: { workspaceId, roleId: actor.roleId },
      select: { permissionKey: true },
    });
    return new Set(rows.map((r) => r.permissionKey));
  }

  private async assertRoleWithinActor(
    client: Tx | PrismaService['raw'],
    workspaceId: string,
    actorPerms: Set<string>,
    roleId: string,
  ): Promise<void> {
    const rolePerms = await client.rolePermission.findMany({
      where: { workspaceId, roleId },
      select: { permissionKey: true },
    });
    if (rolePerms.some((p) => !actorPerms.has(p.permissionKey))) {
      throw new ForbiddenException('Ação exige permissões que você não possui');
    }
  }

  private async assertNotLastActiveOwner(client: Tx, workspaceId: string): Promise<void> {
    const activeOwners = await client.membership.count({
      where: { workspaceId, status: 'active', role: { systemKey: 'owner' } },
    });
    if (activeOwners <= 1) {
      throw new ForbiddenException('O workspace precisa de ao menos um Owner ativo');
    }
  }
}

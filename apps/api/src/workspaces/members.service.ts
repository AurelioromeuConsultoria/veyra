import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { MemberDto, RoleDto } from '@veyra/contracts';
import { AuthContext } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

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
    const target = await this.prisma.db.membership.findFirst({
      where: { id: membershipId, status: { not: 'removed' } },
      include: { role: true },
    });
    if (!target) throw new NotFoundException('Membro não encontrado');
    const newRole = await this.prisma.db.role.findFirst({ where: { id: roleId } });
    if (!newRole) throw new NotFoundException('Função não encontrada');

    await this.assertNoPrivilegeEscalation(auth, roleId);
    const targetRole = (target as unknown as { role: { systemKey: string | null } }).role;
    if (targetRole.systemKey === 'owner' && newRole.systemKey !== 'owner') {
      await this.assertNotLastActiveOwner();
    }

    // tokenVersion++: permissões mudaram → sessões existentes caem (ADR-009)
    await this.prisma.db.membership.updateMany({
      where: { id: membershipId },
      data: { roleId, tokenVersion: { increment: 1 } },
    });
  }

  async removeMember(auth: AuthContext, membershipId: string): Promise<void> {
    if (membershipId === auth.membershipId) {
      throw new ForbiddenException('Você não pode remover a si mesmo — peça a outro administrador');
    }
    const target = await this.prisma.db.membership.findFirst({
      where: { id: membershipId, status: { not: 'removed' } },
      include: { role: true },
    });
    if (!target) throw new NotFoundException('Membro não encontrado');
    const targetRole = (target as unknown as { role: { systemKey: string | null } }).role;
    if (targetRole.systemKey === 'owner') {
      await this.assertNotLastActiveOwner();
    }
    await this.prisma.db.membership.updateMany({
      where: { id: membershipId },
      data: { status: 'removed', tokenVersion: { increment: 1 } },
    });
  }

  /**
   * Anti-autoelevação (ajuste #6): só se atribui a terceiros um papel cujas
   * permissões sejam SUBCONJUNTO das do ator — ninguém concede o que não tem.
   * Público: convites (InvitesService) aplicam a MESMA regra.
   */
  async assertNoPrivilegeEscalation(auth: AuthContext, newRoleId: string): Promise<void> {
    const actorMembership = await this.prisma.db.membership.findFirst({
      where: { id: auth.membershipId ?? '' },
      select: { roleId: true },
    });
    const [actorPerms, newRolePerms] = await Promise.all([
      this.prisma.db.rolePermission.findMany({ where: { roleId: actorMembership?.roleId } }),
      this.prisma.db.rolePermission.findMany({ where: { roleId: newRoleId } }),
    ]);
    const actorSet = new Set(actorPerms.map((p) => p.permissionKey));
    const escalation = newRolePerms.some((p) => !actorSet.has(p.permissionKey));
    if (escalation) {
      throw new ForbiddenException('Você não pode atribuir um papel com permissões que não possui');
    }
  }

  /** Invariante (ajuste #6): o workspace nunca fica sem Owner ativo. */
  private async assertNotLastActiveOwner(): Promise<void> {
    const activeOwners = await this.prisma.db.membership.count({
      where: { status: 'active', role: { systemKey: 'owner' } },
    });
    if (activeOwners <= 1) {
      throw new ForbiddenException('O workspace precisa de ao menos um Owner ativo');
    }
  }
}

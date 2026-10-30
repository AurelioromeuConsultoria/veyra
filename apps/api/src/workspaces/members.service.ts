import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { MemberDto, RoleDto } from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/decorators';
import { CORE_REGISTRY, EXTENSION_REGISTRY, type ComposedRegistry } from '../extensions/registry';
import { mesmoEmail, preFiltroDoEmail } from './mesmo-email';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Cliente de transação raw (sem filtro de workspace — escopo manual explícito). */
type Tx = Prisma.TransactionClient;

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    /** o catálogo composto (Core ∪ extensões): a descrição de cada chave, sem `raw` */
    @Optional()
    @Inject(EXTENSION_REGISTRY)
    private readonly registry: ComposedRegistry = CORE_REGISTRY,
  ) {}

  async listRoles(): Promise<RoleDto[]> {
    const roles = await this.prisma.db.role.findMany({ orderBy: { createdAt: 'asc' } });
    const rolePermissions = await this.prisma.db.rolePermission.findMany();
    return roles.map((role) => {
      const permissions = rolePermissions
        .filter((rp) => rp.roleId === role.id)
        .map((rp) => rp.permissionKey);
      return {
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissions,
        // chave fora do catálogo composto (não deveria existir: a checagem de
        // boot recusa) aparece pela própria chave, nunca some da lista
        permissionDescriptions: Object.fromEntries(
          permissions.map((key) => [key, this.registry.permissionCatalog[key] ?? key]),
        ),
      };
    });
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
      const actorPerms = await this.managerPermissions(tx, workspaceId, auth.membershipId);
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
      await this.audit.record(tx, workspaceId, 'member.role_changed', {
        entityType: 'membership',
        entityId: membershipId,
        actor: this.audit.actorFrom(auth),
        before: { roleId: target.roleId },
        after: { roleId },
      });
      // os convites que o rebaixado emitiu e que o papel novo não autoriza caem
      // AGORA, de vez: voltar a ter o papel não os ressuscita (ADR-054 item 12)
      await this.revokeInvitesWithoutAuthority(tx, workspaceId, membershipId, auth);
    });
  }

  async removeMember(auth: AuthContext, membershipId: string): Promise<void> {
    if (membershipId === auth.membershipId) {
      throw new ForbiddenException('Você não pode remover a si mesmo — peça a outro administrador');
    }
    const workspaceId = this.requireWorkspace(auth);
    await this.runWorkspaceLocked(workspaceId, async (tx) => {
      const actorPerms = await this.managerPermissions(tx, workspaceId, auth.membershipId);
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
      await this.audit.record(tx, workspaceId, 'member.removed', {
        entityType: 'membership',
        entityId: membershipId,
        actor: this.audit.actorFrom(auth),
        before: { roleId: target.roleId, status: 'active' },
        after: { status: 'removed' },
      });
      // quem sai não volta por convite em aberto para o e-mail dele (item 10), e
      // os convites que ele emitiu perdem a autoridade de quem os emitiu (item 12)
      await this.revokePendingInvitesFor(tx, workspaceId, target.userId, auth);
      await this.revokeInvitesWithoutAuthority(tx, workspaceId, membershipId, auth);
    });
  }

  /**
   * Seção crítica de acesso para os convites (ADR-054 item 6): a MESMA trava
   * das trocas e remoções, com a regra de não-elevação conferida DENTRO dela.
   * Conferida fora, um ator rebaixado em paralelo ainda concederia (ou
   * revogaria) com as permissões de antes. `fn` recebe o cliente da transação
   * SEM filtro de workspace — o escopo é manual, por `workspaceId`, como aqui.
   */
  async withinActorAuthority<T>(
    auth: AuthContext,
    roleId: string,
    fn: (tx: Tx, workspaceId: string) => Promise<T>,
  ): Promise<T> {
    const workspaceId = this.requireWorkspace(auth);
    return this.runWorkspaceLocked(workspaceId, async (tx) => {
      const actorPerms = await this.managerPermissions(tx, workspaceId, auth.membershipId);
      await this.assertRoleWithinActor(tx, workspaceId, actorPerms, roleId);
      return fn(tx, workspaceId);
    });
  }

  /**
   * A trava dos membros, para quem já está numa transação `raw` própria — o
   * aceite do convite (ADR-054 item 12). É a MESMA da troca de papel, da
   * remoção, da criação e da revogação: o que se lê depois dela já vê o que
   * essas operações confirmaram.
   */
  async lockMembers(tx: Tx, workspaceId: string): Promise<void> {
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      'veyra_members',
      workspaceId,
    );
  }

  /**
   * Quem emitiu o convite ainda pode concedê-lo? A membership ativa, a conta
   * ativa, `members:manage` e as permissões do papel do convite contidas nas
   * dela — a mesma regra da criação, lida AGORA. Chamada sob a trava.
   */
  async authorityToInvite(
    tx: Tx,
    workspaceId: string,
    membershipId: string,
    roleId: string,
  ): Promise<boolean> {
    const quem = await tx.membership.findFirst({
      where: { id: membershipId, workspaceId, status: 'active', user: { status: 'active' } },
      select: { roleId: true },
    });
    if (!quem) return false;
    const dele = await this.permissionsOf(tx, workspaceId, quem.roleId);
    if (!dele.has('members:manage')) return false;
    const doPapel = await this.permissionsOf(tx, workspaceId, roleId);
    return [...doPapel].every((p) => dele.has(p));
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
      await this.lockMembers(tx, workspaceId);
      return fn(tx);
    });
  }

  private async permissionsOf(tx: Tx, workspaceId: string, roleId: string): Promise<Set<string>> {
    const rows = await tx.rolePermission.findMany({
      where: { workspaceId, roleId },
      select: { permissionKey: true },
    });
    return new Set(rows.map((r) => r.permissionKey));
  }

  /**
   * As permissões de quem age, conferidas SOB a trava: sem `members:manage`
   * agora (rebaixado em paralelo depois do guard), nada é gerido.
   */
  private async managerPermissions(
    tx: Tx,
    workspaceId: string,
    actorMembershipId: string | null,
  ): Promise<Set<string>> {
    const perms = await this.actorPermissions(tx, workspaceId, actorMembershipId);
    if (!perms.has('members:manage')) {
      throw new ForbiddenException('Ação exige permissões que você não possui');
    }
    return perms;
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

  /**
   * Quem perde o acesso não volta por um convite que já estava em aberto para o
   * e-mail dele (ADR-054 item 10): na MESMA transação da remoção, os convites
   * pendentes desse e-mail são revogados, cada um com a sua trilha, pelo
   * critério único de e-mail (`mesmoEmail`, item 13). raw justificado: o
   * e-mail é identidade global (User), lido pelo `userId` da membership deste
   * workspace.
   */
  private async revokePendingInvitesFor(
    tx: Tx,
    workspaceId: string,
    userId: string,
    auth: AuthContext,
  ): Promise<void> {
    const user = await tx.user.findFirst({ where: { id: userId }, select: { email: true } });
    if (!user) return;
    const candidatos = await tx.invite.findMany({
      where: { workspaceId, acceptedAt: null, email: preFiltroDoEmail(user.email) },
      select: { id: true, roleId: true, email: true },
    });
    await this.revokeInvites(
      tx,
      workspaceId,
      candidatos.filter((c) => mesmoEmail(c.email, user.email)),
      auth,
    );
  }

  /**
   * Os convites pendentes que `creatorMembershipId` emitiu e que ele, AGORA, já
   * não pode conceder — removido, sem `members:manage` ou com o papel do
   * convite acima das permissões dele — são revogados de vez (ADR-054 item 12).
   * Chamada sob a trava, depois da mudança: lê o estado novo.
   */
  private async revokeInvitesWithoutAuthority(
    tx: Tx,
    workspaceId: string,
    creatorMembershipId: string,
    auth: AuthContext,
  ): Promise<void> {
    const emitidos = await tx.invite.findMany({
      where: { workspaceId, acceptedAt: null, createdByMembershipId: creatorMembershipId },
      select: { id: true, roleId: true },
    });
    const semAutoridade: { id: string; roleId: string }[] = [];
    for (const convite of emitidos) {
      if (!(await this.authorityToInvite(tx, workspaceId, creatorMembershipId, convite.roleId))) {
        semAutoridade.push(convite);
      }
    }
    await this.revokeInvites(tx, workspaceId, semAutoridade, auth);
  }

  private async revokeInvites(
    tx: Tx,
    workspaceId: string,
    convites: { id: string; roleId: string }[],
    auth: AuthContext,
  ): Promise<void> {
    for (const convite of convites) {
      const { count } = await tx.invite.deleteMany({
        where: { id: convite.id, workspaceId, acceptedAt: null },
      });
      if (count === 0) continue; // já saiu pelo outro critério nesta mesma remoção
      await this.audit.record(tx, workspaceId, 'invite.revoked', {
        entityType: 'invite',
        entityId: convite.id,
        actor: this.audit.actorFrom(auth),
        before: { roleId: convite.roleId },
        after: null,
      });
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

import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthUserDto, MembershipSummaryDto, PermissionKey } from '@veyra/contracts';
import { compare } from 'bcryptjs';
import { AuthContext } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  SessionCookies,
  generateCsrfToken,
  generateOpaqueToken,
  sha256,
} from './tokens';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  membershipId: string | null;
  workspaceId: string | null;
  tokenVersion: number | null;
  sessionId: string;
}

interface SessionResult {
  user: AuthUserDto;
  cookies: SessionCookies;
}

/**
 * Todo acesso a dados aqui usa prisma.raw — exceção documentada "autenticação/
 * identidade global" (SECURITY.md §2): login/refresh/sessão rodam ANTES de
 * existir workspace no CLS, e User/RefreshToken são modelos globais.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  private accessTtlSeconds(): number {
    return this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
  }
  private refreshTtlDays(): number {
    return this.config.getOrThrow<number>('REFRESH_TTL_DAYS');
  }

  async login(email: string, password: string): Promise<SessionResult> {
    // raw: autenticação — lookup global por e-mail
    const user = await this.prisma.raw.user.findUnique({ where: { email } });
    // mensagem única para qualquer falha: não revelar se o e-mail existe
    if (!user || user.status !== 'active' || !(await compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const membership = await this.pickActiveMembership(user.id);
    return this.createSession(user.id, membership?.id ?? null);
  }

  async refresh(presentedToken: string | undefined): Promise<SessionResult> {
    if (!presentedToken) throw new UnauthorizedException('Sessão inválida');
    // raw: autenticação — RefreshToken é global
    const row = await this.prisma.raw.refreshToken.findUnique({
      where: { tokenHash: sha256(presentedToken) },
    });
    if (!row || row.expiresAt < new Date()) {
      throw new UnauthorizedException('Sessão inválida');
    }
    if (row.revokedAt) {
      // REUSO de token rotacionado = sessão comprometida: derruba TUDO do
      // usuário — refresh tokens E tokenVersion de todas as memberships ativas,
      // para que access tokens já emitidos caiam na próxima request (ajuste #2).
      await this.revokeAllUserSessions(row.userId);
      throw new UnauthorizedException('Sessão inválida');
    }
    // suspensão global vale imediatamente também no refresh
    const user = await this.prisma.raw.user.findFirst({
      where: { id: row.userId, status: 'active' },
      select: { id: true },
    });
    if (!user) throw new UnauthorizedException('Sessão inválida');

    // rotação ATÔMICA e condicional: o update só casa se o token ainda estiver
    // vivo. Dois refreshes concorrentes do mesmo token → só um faz count=1; o
    // outro trata como reuso (derruba tudo). Sem isso, dois vencedores.
    const membershipId = await this.validateActiveMembership(row.userId, row.activeMembershipId);
    const opaque = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlDays() * 24 * 60 * 60 * 1000);
    const created = await this.prisma.raw.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count !== 1) {
        throw new UnauthorizedException('Sessão inválida');
      }
      return tx.refreshToken.create({
        data: {
          userId: row.userId,
          tokenHash: sha256(opaque),
          activeMembershipId: membershipId,
          expiresAt,
        },
      });
    });
    return this.buildSessionResult(row.userId, membershipId, created.id, opaque);
  }

  async logout(auth: AuthContext, presentedToken: string | undefined): Promise<void> {
    // revoga apenas sessão do próprio usuário (updateMany com userId no where)
    if (presentedToken) {
      await this.prisma.raw.refreshToken.updateMany({
        where: { tokenHash: sha256(presentedToken), userId: auth.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  async switchWorkspace(auth: AuthContext, membershipId: string): Promise<SessionResult> {
    // pertence ao PRÓPRIO usuário e está ativa (ajuste #5); mensagem genérica
    // para não revelar existência de membership alheia
    const membership = await this.prisma.raw.membership.findFirst({
      where: { id: membershipId, userId: auth.userId, status: 'active' },
    });
    if (!membership) throw new ForbiddenException('Workspace indisponível');
    // atualiza a sessão atual (updateMany com userId: nunca sessão de terceiro;
    // a FK composta (userId, activeMembershipId) garante o mesmo no banco). Se a
    // sessão não estiver mais viva (logout/reuso), count=0 → não emite token.
    const updated = await this.prisma.raw.refreshToken.updateMany({
      where: {
        id: auth.sessionId,
        userId: auth.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { activeMembershipId: membership.id },
    });
    if (updated.count !== 1) throw new UnauthorizedException('Sessão inválida');
    const opaque = null; // refresh não rotaciona na troca — só o access muda
    return this.buildSessionResult(auth.userId, membership.id, auth.sessionId, opaque);
  }

  async me(auth: AuthContext): Promise<AuthUserDto> {
    return this.buildAuthUserDto(auth.userId, auth.membershipId);
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.prisma.raw.$transaction([
      this.prisma.raw.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.raw.membership.updateMany({
        where: { userId, status: 'active' },
        data: { tokenVersion: { increment: 1 } },
      }),
    ]);
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private async pickActiveMembership(userId: string): Promise<{ id: string } | null> {
    // preferência: workspace ativo da última sessão viva; senão a mais antiga
    const lastSession = await this.prisma.raw.refreshToken.findFirst({
      where: { userId, revokedAt: null, activeMembershipId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (lastSession?.activeMembershipId) {
      const valid = await this.validateActiveMembership(userId, lastSession.activeMembershipId);
      if (valid) return { id: valid };
    }
    return this.prisma.raw.membership.findFirst({
      where: { userId, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  }

  private async validateActiveMembership(
    userId: string,
    membershipId: string | null,
  ): Promise<string | null> {
    if (!membershipId) return null;
    const m = await this.prisma.raw.membership.findFirst({
      where: { id: membershipId, userId, status: 'active' },
      select: { id: true },
    });
    return m?.id ?? null;
  }

  /** Público: o aceite de convite (InvitesController) emite sessão pós-aceite. */
  async createSession(userId: string, membershipId: string | null): Promise<SessionResult> {
    const opaque = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlDays() * 24 * 60 * 60 * 1000);
    const row = await this.prisma.raw.refreshToken.create({
      data: { userId, tokenHash: sha256(opaque), activeMembershipId: membershipId, expiresAt },
    });
    return this.buildSessionResult(userId, membershipId, row.id, opaque);
  }

  private async buildSessionResult(
    userId: string,
    membershipId: string | null,
    sessionId: string,
    refreshOpaque: string | null,
  ): Promise<SessionResult> {
    const user = await this.buildAuthUserDto(userId, membershipId);
    const membership = membershipId
      ? await this.prisma.raw.membership.findFirst({ where: { id: membershipId, userId } })
      : null;
    const payload: AccessTokenPayload = {
      sub: userId,
      email: user.email,
      membershipId: membership?.id ?? null,
      workspaceId: membership?.workspaceId ?? null,
      tokenVersion: membership?.tokenVersion ?? null,
      sessionId,
    };
    const access = await this.jwt.signAsync(payload, {
      expiresIn: this.accessTtlSeconds(),
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return {
      user,
      cookies: {
        access,
        refresh: refreshOpaque ?? '',
        csrf: generateCsrfToken(),
        accessTtlSeconds: this.accessTtlSeconds(),
        refreshTtlDays: this.refreshTtlDays(),
      },
    };
  }

  private async buildAuthUserDto(
    userId: string,
    activeMembershipId: string | null,
  ): Promise<AuthUserDto> {
    // raw: identidade global (User) + resumo de memberships para o seletor de
    // workspace — dados do PRÓPRIO usuário, filtrados por userId
    const user = await this.prisma.raw.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Sessão inválida');
    const memberships = await this.prisma.raw.membership.findMany({
      where: { userId, status: { not: 'removed' } },
      include: { role: true, workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    const summaries: MembershipSummaryDto[] = memberships.map((m) => ({
      membershipId: m.id,
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      workspaceSlug: m.workspace.slug,
      roleName: m.role.name,
      status: m.status,
    }));
    const active = summaries.find((m) => m.membershipId === activeMembershipId) ?? null;
    let permissions: PermissionKey[] = [];
    if (active) {
      const activeRow = memberships.find((m) => m.id === active.membershipId);
      const rps = await this.prisma.raw.rolePermission.findMany({
        // raw: montagem da própria sessão (pré-CLS); escopo pelo roleId da
        // membership validada acima
        where: { roleId: activeRow?.roleId, workspaceId: activeRow?.workspaceId },
      });
      permissions = rps.map((rp) => rp.permissionKey as PermissionKey);
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      activeMembership: active,
      permissions,
      memberships: summaries,
    };
  }
}

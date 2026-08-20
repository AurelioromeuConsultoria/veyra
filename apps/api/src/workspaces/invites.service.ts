import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AcceptInviteInput, InviteCreatedDto, InviteDto } from '@veyra/contracts';
import { hash } from 'bcryptjs';
import { generateOpaqueToken, sha256 } from '../auth/tokens';
import { AuthContext } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

const INVITE_TTL_DAYS = 7;
/** Mensagem ÚNICA para toda falha de aceite: não revela se token/e-mail existe (ajuste #4). */
const INVALID_INVITE = 'Convite inválido ou expirado';

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
  ) {}

  async create(auth: AuthContext, email: string, roleId: string): Promise<InviteCreatedDto> {
    const role = await this.prisma.db.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Função não encontrada');
    // convite obedece à MESMA regra de não-elevação da troca de role (ajuste #6)
    await this.members.assertNoPrivilegeEscalation(auth, roleId);

    const token = generateOpaqueToken();
    const invite = await this.prisma.db.invite.create({
      data: {
        email,
        roleId,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    } as never);
    return { ...this.toDto(invite as never, role.name), token };
  }

  async list(): Promise<InviteDto[]> {
    const invites = await this.prisma.db.invite.findMany({
      where: { acceptedAt: null },
      include: { role: true }, // protegido→protegido: permitido
      orderBy: { createdAt: 'desc' },
    });
    return invites.map((invite) =>
      this.toDto(invite as never, (invite as unknown as { role: { name: string } }).role.name),
    );
  }

  async revoke(inviteId: string): Promise<void> {
    const { count } = await this.prisma.db.invite.deleteMany({
      where: { id: inviteId, acceptedAt: null },
    });
    if (count === 0) throw new NotFoundException('Convite não encontrado');
  }

  /**
   * Aceite (@Public + token): transacional e à prova de corrida (ajuste #4) —
   * validação de expiresAt/acceptedAt, marcação condicional de aceito e criação
   * de conta/membership acontecem na MESMA transação; o updateMany condicional
   * (acceptedAt: null) garante que só UM aceite concorrente vence.
   * prisma.raw justificado: resolução de tokenHash → workspace acontece antes
   * de existir workspace no contexto (exceção documentada, SECURITY.md §2).
   */
  async accept(input: AcceptInviteInput): Promise<{ userId: string; membershipId: string }> {
    // hash de senha FORA da transação (caro); só usado se a conta for nova
    const passwordHash = input.password ? await hash(input.password, 10) : null;

    return this.prisma.raw.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { tokenHash: sha256(input.token) } });
      if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
        throw new BadRequestException(INVALID_INVITE);
      }

      let user = await tx.user.findUnique({ where: { email: invite.email } });
      if (!user) {
        // portador de token VÁLIDO pode saber que precisa criar a conta — o
        // convite permanece intacto (ainda não foi marcado como aceito)
        if (!input.name || !passwordHash) {
          throw new BadRequestException('Informe nome e senha para criar sua conta');
        }
      }

      // marcação condicional: corrida entre dois aceites → só um vence
      const marked = await tx.invite.updateMany({
        where: { id: invite.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });
      if (marked.count !== 1) throw new BadRequestException(INVALID_INVITE);

      if (!user) {
        user = await tx.user.create({
          data: {
            email: invite.email,
            name: input.name as string,
            passwordHash: passwordHash as string,
          },
        });
      }

      const existing = await tx.membership.findFirst({
        where: { workspaceId: invite.workspaceId, userId: user.id },
      });
      if (existing) {
        if (existing.status !== 'removed') throw new BadRequestException(INVALID_INVITE);
        // ex-membro reconvidado: reativa com o papel do convite e derruba sessões antigas
        await tx.membership.update({
          where: { id: existing.id },
          data: { status: 'active', roleId: invite.roleId, tokenVersion: { increment: 1 } },
        });
        return { userId: user.id, membershipId: existing.id };
      }

      const membership = await tx.membership.create({
        data: { workspaceId: invite.workspaceId, userId: user.id, roleId: invite.roleId },
      });
      return { userId: user.id, membershipId: membership.id };
    });
  }

  private toDto(
    invite: {
      id: string;
      email: string;
      roleId: string;
      expiresAt: Date;
      acceptedAt: Date | null;
      createdAt: Date;
    },
    roleName: string,
  ): InviteDto {
    return {
      id: invite.id,
      email: invite.email,
      roleId: invite.roleId,
      roleName,
      expiresAt: invite.expiresAt.toISOString(),
      acceptedAt: invite.acceptedAt?.toISOString() ?? null,
      createdAt: invite.createdAt.toISOString(),
    };
  }
}

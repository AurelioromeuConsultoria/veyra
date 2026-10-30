import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AcceptInviteInput, InviteCreatedDto, InviteDto } from '@veyra/contracts';
import { compare, hash, hashSync } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import { generateOpaqueToken, sha256 } from '../auth/tokens';
import { AuthContext } from '../common/decorators';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import { mesmoEmail, preFiltroDoEmail } from './mesmo-email';

/** Erro do Prisma para violação de unique — tratado como convite inválido. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

const INVITE_TTL_DAYS = 7;
/**
 * Mensagem ÚNICA para toda falha de aceite: não revela se o token vale, se o
 * e-mail tem conta, nem se ela está ativa (ajuste #4; ADR-054 item 4). Inclui
 * o e-mail sem conta e sem nome, que antes tinha mensagem própria.
 */
const INVALID_INVITE = 'Convite inválido ou expirado';

/**
 * Hash para comparar quando NÃO há conta: o aceite sem conta e sem nome gasta
 * o mesmo bcrypt que o de conta existente, e o tempo não separa os dois casos.
 */
const HASH_SEM_CONTA = hashSync('veyra-aceite-sem-conta', 10);

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
    private readonly audit: AuditService,
  ) {}

  private readonly logger = new Logger(InvitesService.name);

  async create(auth: AuthContext, email: string, roleId: string): Promise<InviteCreatedDto> {
    const role = await this.prisma.db.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Função não encontrada');

    const token = generateOpaqueToken();
    // convite obedece à MESMA regra de não-elevação da troca de role (ajuste #6),
    // conferida dentro da trava dos membros (ADR-054 item 6)
    const invite = await this.members.withinActorAuthority(
      auth,
      roleId,
      async (tx, workspaceId) => {
        // quem já é membro não recebe convite: ele nunca poderia ser aceito
        // (ADR-054 item 10), pelo critério único de e-mail (item 13). Só ESTE
        // workspace — nada revela conta em outro. raw (a transação da trava): o
        // e-mail é identidade global
        const candidatos = await tx.membership.findMany({
          where: {
            workspaceId,
            status: { not: 'removed' },
            user: { email: preFiltroDoEmail(email) },
          },
          select: { user: { select: { email: true } } },
        });
        if (candidatos.some((m) => mesmoEmail(m.user.email, email))) {
          throw new ConflictException('Esta pessoa já é membro deste workspace');
        }
        const criado = await tx.invite.create({
          data: {
            workspaceId,
            email,
            roleId,
            tokenHash: sha256(token),
            expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
            // quem emite é a membership AUTENTICADA desta sessão — nunca um id do
            // cliente. A autoridade dela é conferida de novo no aceite (item 12)
            createdByMembershipId: auth.membershipId,
          },
        });
        // a trilha leva quem foi convidado e com que papel; o token e o hash, nunca
        // (ADR-054 item 5)
        await this.audit.record(tx, workspaceId, 'invite.created', {
          entityType: 'invite',
          entityId: criado.id,
          actor: this.audit.actorFrom(auth),
          after: { email, roleId },
        });
        return criado;
      },
    );
    return { ...this.toDto(invite, role.name), token };
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

  /**
   * Revogar obedece à regra da remoção: não se toca no que é de quem é mais
   * poderoso que o ator (ADR-054 item 6). O papel do convite não muda depois de
   * criado; as permissões do ATOR, sim — por isso a conferência é dentro da
   * trava dos membros, junto da remoção.
   */
  async revoke(auth: AuthContext, inviteId: string): Promise<void> {
    const invite = await this.prisma.db.invite.findFirst({
      where: { id: inviteId, acceptedAt: null },
      select: { id: true, roleId: true },
    });
    if (!invite) throw new NotFoundException('Convite não encontrado');

    await this.members.withinActorAuthority(auth, invite.roleId, async (tx, workspaceId) => {
      // condicional: aceito ou revogado no meio do caminho → 404, sem trilha
      const { count } = await tx.invite.deleteMany({
        where: { id: inviteId, workspaceId, acceptedAt: null },
      });
      if (count === 0) throw new NotFoundException('Convite não encontrado');
      await this.audit.record(tx, workspaceId, 'invite.revoked', {
        entityType: 'invite',
        entityId: inviteId,
        actor: this.audit.actorFrom(auth),
        // o e-mail já está no `invite.created` deste convite: não se repete (ADR-054 item 5)
        before: { roleId: invite.roleId },
        after: null,
      });
    });
  }

  /**
   * Aceite (@Public + token): transacional e à prova de corrida (ajuste #4).
   *
   * PROVA DE IDENTIDADE (correção do P0 — takeover): o token NÃO autentica
   * sozinho. Conta existente → exige a SENHA da conta (o token, que o criador
   * do convite conhece, não basta para assumir uma conta e pivotar entre
   * workspaces). Conta nova → exige nome + senha (única porta de entrada,
   * ADR-014). Falha de senha = mensagem única de convite inválido.
   *
   * prisma.raw justificado: resolução de tokenHash → workspace acontece antes
   * de existir workspace no contexto (exceção documentada, SECURITY.md §2).
   */
  async accept(input: AcceptInviteInput): Promise<{ userId: string; membershipId: string }> {
    // 1. FORA da transação e da trava: o convite pelo token e a prova de
    // identidade. Todo caminho com token válido gasta EXATAMENTE um bcrypt —
    // conta existente, sem conta ou ambígua —, e o tempo não revela a conta. Sob
    // a trava, o bcrypt seguraria a gestão de equipe do workspace (ADR-054 item 4).
    // raw justificado: resolução de tokenHash → workspace (SECURITY §2)
    const previo = await this.prisma.raw.invite.findUnique({
      where: { tokenHash: sha256(input.token) },
    });
    if (!previo || previo.acceptedAt || previo.expiresAt < new Date()) {
      throw new BadRequestException(INVALID_INVITE);
    }
    const contasAntes = await this.contasDoEmail(this.prisma.raw, previo.email);
    const provada = contasAntes.length === 1 ? contasAntes[0] : null;
    const senhaConfere = await compare(input.password, provada?.passwordHash ?? HASH_SEM_CONTA);
    // o hash da conta nova depende só do que o cliente mandou (o nome), nunca de
    // haver conta
    const newAccountHash = input.name ? await hash(input.password, 10) : null;

    let desfecho:
      { invalidado: true } | { invalidado: false; userId: string; membershipId: string };
    try {
      desfecho = await this.prisma.raw.$transaction(async (tx) => {
        // 2. a MESMA trava da troca de papel, da remoção, da criação e da
        // revogação (item 12): o que se lê daqui em diante já vê o que elas
        // confirmaram. Uma leitura antes dela não fecharia a corrida
        await this.members.lockMembers(tx, previo.workspaceId);
        const invite = await tx.invite.findFirst({ where: { id: previo.id, acceptedAt: null } });
        // revogado (pela remoção de quem convidou, por exemplo) enquanto esperava
        if (!invite || invite.expiresAt < new Date()) throw new BadRequestException(INVALID_INVITE);

        // workspace desativado não recebe ninguém
        const workspace = await tx.workspace.findFirst({
          where: { id: invite.workspaceId, status: 'active' },
          select: { id: true },
        });
        if (!workspace) throw new BadRequestException(INVALID_INVITE);

        // a autoridade de quem emitiu, AGORA: o convite da operação vale pela
        // operação; o de um membro, só se ele ainda pode conceder ESTE papel. Sem
        // ela, o convite é invalidado de vez — quem convidou voltar a ter o papel
        // não o ressuscita
        const autorizado = invite.issuedByProvisioning
          ? invite.createdByMembershipId === null
          : invite.createdByMembershipId !== null &&
            (await this.members.authorityToInvite(
              tx,
              invite.workspaceId,
              invite.createdByMembershipId,
              invite.roleId,
            ));
        if (!autorizado) {
          await this.invalidar(tx, invite);
          return { invalidado: true as const };
        }

        // a conta do e-mail, relida sob a trava pelo critério único (item 13). Ela
        // precisa ser a MESMA da prova de identidade. Duas contas que só diferem
        // na caixa: ambíguo — recusa, sem escolher uma, e registra a necessidade
        // de resolução (só ids no log, nunca o e-mail)
        const contas = await this.contasDoEmail(tx, invite.email);
        if (contas.length > 1) {
          this.logger.warn(
            `aceite recusado: o e-mail do convite ${invite.id} (workspace ${invite.workspaceId}) corresponde a ${contas.length} contas que só diferem na caixa; resolver na normalização dos e-mails`,
          );
          throw new BadRequestException(INVALID_INVITE);
        }
        const user = contas[0] ?? null;
        if (user) {
          // conta existente: a senha DELA (o token não basta) e a conta ativa,
          // como no login
          if (user.id !== provada?.id || !senhaConfere || user.status !== 'active') {
            throw new BadRequestException(INVALID_INVITE);
          }
        } else if (provada || !newAccountHash) {
          // a conta sumiu entre a prova e a trava, ou falta o nome para criar.
          // O convite permanece intacto para o portador completar o cadastro
          throw new BadRequestException(INVALID_INVITE);
        }

        // marcação condicional: corrida entre dois aceites do MESMO convite → um só vence
        const marked = await tx.invite.updateMany({
          where: { id: invite.id, acceptedAt: null },
          data: { acceptedAt: new Date() },
        });
        if (marked.count !== 1) throw new BadRequestException(INVALID_INVITE);

        const account =
          user ??
          (await tx.user.create({
            data: {
              email: invite.email,
              name: input.name as string,
              passwordHash: newAccountHash as string,
            },
          }));

        const existing = await tx.membership.findFirst({
          where: { workspaceId: invite.workspaceId, userId: account.id },
        });
        if (existing) {
          if (existing.status !== 'removed') throw new BadRequestException(INVALID_INVITE);
          // ex-membro reconvidado: reativa com EXATAMENTE o papel do convite e
          // derruba sessões antigas. Condicional e com o workspace: nada de
          // operação por chave única em modelo protegido (CLAUDE.md §3.2)
          const reativada = await tx.membership.updateMany({
            where: { id: existing.id, workspaceId: invite.workspaceId, status: 'removed' },
            data: { status: 'active', roleId: invite.roleId, tokenVersion: { increment: 1 } },
          });
          if (reativada.count !== 1) throw new BadRequestException(INVALID_INVITE);
          await this.registrarEntrada(tx, invite, existing.id, {
            roleId: existing.roleId,
            status: 'removed',
          });
          return { invalidado: false as const, userId: account.id, membershipId: existing.id };
        }

        const membership = await tx.membership.create({
          data: { workspaceId: invite.workspaceId, userId: account.id, roleId: invite.roleId },
        });
        await this.registrarEntrada(tx, invite, membership.id, null);
        return { invalidado: false as const, userId: account.id, membershipId: membership.id };
      });
    } catch (error) {
      // dois convites DIFERENTES para o mesmo user+workspace em paralelo →
      // @@unique([workspaceId, userId]) → P2002; converte em 400, nunca 500
      if (isUniqueViolation(error)) throw new BadRequestException(INVALID_INVITE);
      throw error;
    }
    // a invalidação já foi confirmada: a recusa vem depois, com a MESMA mensagem
    if (desfecho.invalidado) throw new BadRequestException(INVALID_INVITE);
    return { userId: desfecho.userId, membershipId: desfecho.membershipId };
  }

  /** As contas do e-mail pelo critério único (item 13): o pré-filtro, depois a igualdade. */
  private async contasDoEmail(
    client: PrismaService['raw'] | Prisma.TransactionClient,
    email: string,
  ) {
    const candidatas = await client.user.findMany({ where: { email: preFiltroDoEmail(email) } });
    return candidatas.filter((u) => mesmoEmail(u.email, email));
  }

  /**
   * O convite cuja origem perdeu a autoridade sai DE VEZ (ADR-054 item 12): a
   * linha é apagada, como na revogação, e a trilha diz por quê. Confirmado com
   * a transação, antes da recusa — uma exceção aqui desfaria a invalidação.
   */
  private async invalidar(
    tx: Prisma.TransactionClient,
    invite: { id: string; workspaceId: string; roleId: string },
  ): Promise<void> {
    const { count } = await tx.invite.deleteMany({
      where: { id: invite.id, workspaceId: invite.workspaceId, acceptedAt: null },
    });
    if (count === 0) return; // já não estava lá: nenhuma trilha espúria
    await this.audit.record(tx, invite.workspaceId, 'invite.invalidated', {
      entityType: 'invite',
      entityId: invite.id,
      actor: { type: 'system', id: 'invite-accept' },
      before: { roleId: invite.roleId },
      after: null,
    });
  }

  /**
   * A entrada pelo convite, na trilha do workspace do convite e na transação do
   * aceite. O ator é a própria membership que entrou: ainda não há sessão.
   */
  private registrarEntrada(
    tx: Prisma.TransactionClient,
    invite: { id: string; workspaceId: string; roleId: string },
    membershipId: string,
    before: { roleId: string; status: 'removed' } | null,
  ): Promise<void> {
    // `inviteId` liga a entrada ao `invite.created`, que traz quem convidou
    return this.audit.record(tx, invite.workspaceId, 'member.joined', {
      entityType: 'membership',
      entityId: membershipId,
      actor: { type: 'user', membershipId },
      before,
      after: { roleId: invite.roleId, status: 'active', inviteId: invite.id },
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
      createdByMembershipId: string | null;
      issuedByProvisioning: boolean;
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
      createdByMembershipId: invite.createdByMembershipId,
      issuedByProvisioning: invite.issuedByProvisioning,
    };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateNoteInput, ListNotesInput, NoteDto } from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { AuthContext } from '../common/decorators';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type NoteRow = {
  id: string;
  body: string;
  authorMembershipId: string;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  createdAt: Date;
};

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
  ) {}

  async list(input: ListNotesInput): Promise<NoteDto[]> {
    const where = input.contactId
      ? { contactId: input.contactId }
      : input.companyId
        ? { companyId: input.companyId }
        : { dealId: input.dealId };
    const rows = (await this.prisma.db.note.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    } as never)) as unknown as NoteRow[];
    return this.toDtos(rows);
  }

  async create(auth: AuthContext, input: CreateNoteInput): Promise<NoteDto> {
    if (!auth.membershipId) throw new BadRequestException('Sessão sem workspace ativo');
    await this.validateTargets(input);
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          body: input.body,
          authorMembershipId: auth.membershipId as string,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          dealId: input.dealId ?? null,
        },
      } as never);
      // payload VAZIO por design: o corpo da nota nunca vai para a timeline
      await this.activities.record(tx, auth.workspaceId as string, 'note_added', {
        actorMembershipId: auth.membershipId,
        payload: {},
        targets: {
          contactId: input.contactId,
          companyId: input.companyId,
          dealId: input.dealId,
        },
      });
      return note.id;
    });
    return this.get(id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.note.findFirst({
      where: { id },
    })) as unknown as NoteRow | null;
    if (!existing) throw new NotFoundException('Nota não encontrada');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.note.deleteMany({ where: { id } });
      // ajuste #6: se o delete emite evento, o tipo existe no catálogo
      await this.activities.record(tx, auth.workspaceId as string, 'note_deleted', {
        actorMembershipId: auth.membershipId,
        payload: {},
        targets: {
          contactId: existing.contactId,
          companyId: existing.companyId,
          dealId: existing.dealId,
        },
      });
    });
  }

  private async get(id: string): Promise<NoteDto> {
    const row = (await this.prisma.db.note.findFirst({
      where: { id },
    })) as unknown as NoteRow | null;
    if (!row) throw new NotFoundException('Nota não encontrada');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  private async validateTargets(input: CreateNoteInput): Promise<void> {
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId } });
      if (!contact) throw new BadRequestException('Contato inválido');
    }
    if (input.companyId) {
      const company = await this.prisma.db.company.findFirst({ where: { id: input.companyId } });
      if (!company) throw new BadRequestException('Empresa inválida');
    }
    if (input.dealId) {
      const deal = await this.prisma.db.deal.findFirst({ where: { id: input.dealId } });
      if (!deal) throw new BadRequestException('Oportunidade inválida');
    }
  }

  private async toDtos(rows: NoteRow[]): Promise<NoteDto[]> {
    const ids = [...new Set(rows.map((r) => r.authorMembershipId))];
    const memberships = ids.length
      ? await this.prisma.db.membership.findMany({
          where: { id: { in: ids } },
          select: { id: true, userId: true },
        })
      : [];
    // raw justificado: nome (User global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = memberships.length
      ? await this.prisma.raw.user.findMany({
          where: { id: { in: memberships.map((m) => m.userId) } },
          select: { id: true, name: true },
        })
      : [];
    const byUser = new Map(users.map((u) => [u.id, u.name]));
    const names = new Map(memberships.map((m) => [m.id, byUser.get(m.userId) ?? '']));
    return rows.map((row) => ({
      id: row.id,
      body: row.body,
      authorMembershipId: row.authorMembershipId,
      authorName: names.get(row.authorMembershipId) ?? null,
      contactId: row.contactId,
      companyId: row.companyId,
      dealId: row.dealId,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

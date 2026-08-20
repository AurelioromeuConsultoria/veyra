import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CalendarEventDto,
  CreateCalendarEventInput,
  ListCalendarEventsInput,
  UpdateCalendarEventInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { AuthContext } from '../common/decorators';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

type EventRow = {
  id: string;
  title: string;
  description: string | null;
  startAt: Date;
  endAt: Date;
  location: string | null;
  status: 'scheduled' | 'done' | 'canceled';
  organizerMembershipId: string;
  contactId: string | null;
  dealId: string | null;
  createdAt: Date;
};

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activities: ActivitiesService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Agenda é sempre por JANELA: eventos que INTERSECTAM [from, to). */
  async list(input: ListCalendarEventsInput): Promise<CalendarEventDto[]> {
    const rows = (await this.prisma.db.calendarEvent.findMany({
      where: {
        startAt: { lt: new Date(input.to) },
        endAt: { gt: new Date(input.from) },
        ...(input.status === 'all' ? {} : { status: input.status }),
        ...(input.organizerMembershipId
          ? { organizerMembershipId: input.organizerMembershipId }
          : {}),
        ...(input.contactId ? { contactId: input.contactId } : {}),
        ...(input.dealId ? { dealId: input.dealId } : {}),
      },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      take: 500,
    } as never)) as unknown as EventRow[];
    return this.toDtos(rows);
  }

  async get(id: string): Promise<CalendarEventDto> {
    const row = (await this.prisma.db.calendarEvent.findFirst({
      where: { id },
    })) as unknown as EventRow | null;
    if (!row) throw new NotFoundException('Evento não encontrado');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async create(auth: AuthContext, input: CreateCalendarEventInput): Promise<CalendarEventDto> {
    const organizerId = input.organizerMembershipId ?? (auth.membershipId as string);
    await this.validateReferences({ ...input, organizerMembershipId: organizerId });

    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const event = await tx.calendarEvent.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          location: input.location ?? null,
          organizerMembershipId: organizerId,
          contactId: input.contactId ?? null,
          dealId: input.dealId ?? null,
        },
      } as never);
      const eventId = (event as unknown as { id: string }).id;

      await this.activities.record(tx, auth.workspaceId as string, 'event_scheduled', {
        actorMembershipId: auth.membershipId,
        payload: { title: input.title, startAt: input.startAt },
        targets: {
          calendarEventId: eventId,
          contactId: input.contactId,
          dealId: input.dealId,
        },
      });

      // ADR-026: notifica o organizador SÓ quando for outra pessoa — avisar
      // quem acabou de criar o próprio evento é ruído. Quando há notificação,
      // ela é única inclusive em retry: dedupeKey pelo par (evento, destinatário).
      if (organizerId !== auth.membershipId) {
        await this.notifications.emit(
          tx,
          auth.workspaceId as string,
          organizerId,
          'calendar_event_scheduled',
          { title: input.title, startAt: input.startAt },
          `calendar_event_scheduled:${eventId}:${organizerId}`,
        );
      }
      return eventId;
    });
    return this.get(id);
  }

  async update(id: string, input: UpdateCalendarEventInput): Promise<CalendarEventDto> {
    const existing = (await this.prisma.db.calendarEvent.findFirst({
      where: { id },
    })) as unknown as EventRow | null;
    if (!existing) throw new NotFoundException('Evento não encontrado');
    await this.validateReferences(input);

    // janela final = o que veio + o que já existia. Sem isto, mandar só um dos
    // lados poderia inverter o evento — e aí só o CHECK do banco pegaria, com
    // erro feio em vez de mensagem clara.
    const startAt = input.startAt ? new Date(input.startAt) : existing.startAt;
    const endAt = input.endAt ? new Date(input.endAt) : existing.endAt;
    if (endAt <= startAt) {
      throw new BadRequestException('O término precisa ser depois do início');
    }

    await this.prisma.db.calendarEvent.updateMany({
      where: { id },
      data: {
        title: input.title,
        description: input.description,
        startAt,
        endAt,
        location: input.location,
        status: input.status,
        organizerMembershipId: input.organizerMembershipId,
        contactId: input.contactId,
        dealId: input.dealId,
      },
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.db.calendarEvent.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Evento não encontrado');
  }

  private async validateReferences(input: {
    organizerMembershipId?: string | null;
    contactId?: string | null;
    dealId?: string | null;
  }): Promise<void> {
    if (input.organizerMembershipId) {
      const organizer = await this.prisma.db.membership.findFirst({
        where: { id: input.organizerMembershipId, status: 'active' },
      });
      if (!organizer) throw new BadRequestException('Organizador inválido');
    }
    if (input.contactId) {
      const contact = await this.prisma.db.contact.findFirst({ where: { id: input.contactId } });
      if (!contact) throw new BadRequestException('Contato inválido');
    }
    if (input.dealId) {
      const deal = await this.prisma.db.deal.findFirst({ where: { id: input.dealId } });
      if (!deal) throw new BadRequestException('Oportunidade inválida');
    }
  }

  private async toDtos(rows: EventRow[]): Promise<CalendarEventDto[]> {
    const [organizers, contacts] = await Promise.all([
      this.resolveMemberNames(rows.map((r) => r.organizerMembershipId)),
      this.resolveContactNames(rows.map((r) => r.contactId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
      location: row.location,
      status: row.status,
      organizerMembershipId: row.organizerMembershipId,
      organizerName: organizers.get(row.organizerMembershipId) ?? null,
      contactId: row.contactId,
      contactName: row.contactId ? (contacts.get(row.contactId) ?? null) : null,
      dealId: row.dealId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async resolveContactNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    if (unique.length === 0) return new Map();
    const contacts = await this.prisma.db.contact.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(contacts.map((c) => [c.id, c.name]));
  }

  private async resolveMemberNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: unique } },
      select: { id: true, userId: true },
    });
    // raw justificado: nome (User global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true },
    });
    const byUser = new Map(users.map((u) => [u.id, u.name]));
    return new Map(memberships.map((m) => [m.id, byUser.get(m.userId) ?? '']));
  }
}

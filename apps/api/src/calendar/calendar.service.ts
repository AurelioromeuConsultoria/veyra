import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CalendarEventDto,
  CreateCalendarEventInput,
  ListCalendarEventsInput,
  UpdateCalendarEventInput,
} from '@veyra/contracts';
import { ActivitiesService } from '../activities/activities.service';
import { AuthContext } from '../common/decorators';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * O evento cujo texto é conteúdo protegido para quem pede (ADR-061, adendo 8):
 * o título, a descrição e o local saem como "Conteúdo restrito" — os três
 * sempre, para que nem a presença de uma descrição diferencie um evento do
 * outro. Datas, estado, ids e vínculos ficam.
 */
export function comTextoRestrito(dto: CalendarEventDto): CalendarEventDto {
  return {
    ...dto,
    title: CONTEUDO_RESTRITO,
    description: CONTEUDO_RESTRITO,
    location: CONTEUDO_RESTRITO,
    textRestricted: true,
  };
}

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
    private readonly protegido: ProtectedContentService,
  ) {}

  /** Agenda é sempre por JANELA: eventos que INTERSECTAM [from, to). */
  async list(auth: AuthContext, input: ListCalendarEventsInput): Promise<CalendarEventDto[]> {
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
    return this.toDtos(auth, rows);
  }

  async get(auth: AuthContext, id: string): Promise<CalendarEventDto> {
    const row = (await this.prisma.db.calendarEvent.findFirst({
      where: { id },
    })) as unknown as EventRow | null;
    if (!row) throw new NotFoundException('Evento não encontrado');
    const [dto] = await this.toDtos(auth, [row]);
    return dto;
  }

  async create(auth: AuthContext, input: CreateCalendarEventInput): Promise<CalendarEventDto> {
    const organizerId = input.organizerMembershipId ?? (auth.membershipId as string);
    await this.validateReferences({ ...input, organizerMembershipId: organizerId });
    await this.exigirSemPessoaNoUniforme(auth, [input]);

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
      // o contato da oportunidade NESTE momento, no histórico dos vínculos
      // (ADR-061, adendo 8): a criação já grava o contato e a oportunidade
      await this.registrarVinculos(
        tx,
        auth,
        eventId,
        { contactId: input.contactId ?? null, dealId: input.dealId ?? null },
        { comOProprio: false },
      );

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
    return this.get(auth, id);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateCalendarEventInput,
  ): Promise<CalendarEventDto> {
    const existing = (await this.prisma.db.calendarEvent.findFirst({
      where: { id },
    })) as unknown as EventRow | null;
    if (!existing) throw new NotFoundException('Evento não encontrado');
    await this.validateReferences(input);
    // no `uniforme`: o evento cujo texto é oculto (pela pessoa de agora OU do
    // histórico) não se edita, e levá-lo até uma pessoa também é recusado
    await this.exigirTextoVisivelNoUniforme(auth, existing);
    await this.exigirSemPessoaNoUniforme(auth, [input]);

    // janela final = o que veio + o que já existia. Sem isto, mandar só um dos
    // lados poderia inverter o evento — e aí só o CHECK do banco pegaria, com
    // erro feio em vez de mensagem clara.
    const startAt = input.startAt ? new Date(input.startAt) : existing.startAt;
    const endAt = input.endAt ? new Date(input.endAt) : existing.endAt;
    if (endAt <= startAt) {
      throw new BadRequestException('O término precisa ser depois do início');
    }

    const trocaVinculo =
      (input.contactId !== undefined && input.contactId !== existing.contactId) ||
      (input.dealId !== undefined && input.dealId !== existing.dealId);
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.calendarEvent.updateMany({
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
      if (!trocaVinculo) return;
      // o vínculo EM VIGOR, relido da linha que a escrita travou, entra no
      // histórico (ADR-061, adendo 8): o texto escrito enquanto o evento era
      // da pessoa continua dela depois de desligado, por qualquer papel
      const vigente = (await tx.calendarEvent.findFirst({
        where: { id },
        select: { contactId: true, dealId: true },
      } as never)) as unknown as Pick<EventRow, 'contactId' | 'dealId'> | null;
      if (vigente) await this.registrarVinculos(tx, auth, id, vigente, { comOProprio: true });
    });
    return this.get(auth, id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.calendarEvent.findFirst({
      where: { id },
      select: { contactId: true, dealId: true },
    } as never)) as unknown as Pick<EventRow, 'contactId' | 'dealId'> | null;
    if (!existing) throw new NotFoundException('Evento não encontrado');
    await this.exigirTextoVisivelNoUniforme(auth, { id, ...existing });
    const { count } = await this.prisma.db.calendarEvent.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Evento não encontrado');
  }

  /**
   * O HISTÓRICO dos vínculos de um evento (ADR-061, adendo 8): uma atividade
   * `event_linked` (interna, fora da timeline, sem texto) por vínculo que o
   * evento passa a ter — o contato e a oportunidade dele (`comOProprio`; a
   * criação já os grava na `event_scheduled`) e, se há oportunidade, o
   * contato DELA neste momento, lido na transação. `vinculosDosEventos` lê
   * esse histórico; desligar não grava nada (o vínculo anterior já está lá).
   */
  private async registrarVinculos(
    tx: Db,
    auth: AuthContext,
    eventoId: string,
    vinculo: { contactId: string | null; dealId: string | null },
    opcoes: { comOProprio: boolean },
  ): Promise<void> {
    const vinculos: { contactId: string | null; dealId: string | null }[] = [];
    if (opcoes.comOProprio && (vinculo.contactId || vinculo.dealId)) vinculos.push(vinculo);
    if (vinculo.dealId) {
      const deal = (await tx.deal.findFirst({
        where: { id: vinculo.dealId },
        select: { contactId: true },
      } as never)) as unknown as { contactId: string | null } | null;
      if (deal?.contactId && deal.contactId !== vinculo.contactId) {
        vinculos.push({ contactId: deal.contactId, dealId: vinculo.dealId });
      }
    }
    for (const v of vinculos) {
      await this.activities.record(tx, auth.workspaceId as string, 'event_linked', {
        actorMembershipId: auth.membershipId,
        payload: {},
        targets: { calendarEventId: eventoId, contactId: v.contactId, dealId: v.dealId },
      });
    }
  }

  /**
   * Quem não lê não escreve (ADR-061, adendo 8): no `uniforme`, editar ou
   * apagar um evento de texto oculto — pela pessoa de agora OU por uma do
   * histórico dos vínculos — é recusado com 403 "Conteúdo restrito", igual
   * para paciente e interessado. Fora do `uniforme`, nada muda (a recepção
   * edita e apaga como antes, e a resposta segue a regra de leitura).
   */
  private async exigirTextoVisivelNoUniforme(
    auth: AuthContext,
    evento: Pick<EventRow, 'id' | 'contactId' | 'dealId'>,
  ): Promise<void> {
    if (!(await this.protegido.semClassificacao(auth))) return;
    if ((await this.textosOcultos(auth, [evento])).size > 0) {
      throw new ForbiddenException(CONTEUDO_RESTRITO);
    }
  }

  /**
   * As escritas na agenda do Core seguem a regra das notas e tarefas no
   * `uniforme` (ADR-061, adendos 3 e 8): quem NÃO pode saber quem é protegido
   * não cria um evento para uma pessoa nem leva um evento até uma (pelo
   * contato, ou pela oportunidade com contato) — 403 "Conteúdo restrito",
   * igual para todo contato. O evento que já é (ou foi) de uma pessoa é
   * conferido por `exigirTextoVisivelNoUniforme`. O que não tem pessoa segue
   * normal.
   * Fora do `uniforme`, nada muda: a recepção (`restrito`) escreve como antes
   * e a resposta segue a regra de leitura.
   */
  private async exigirSemPessoaNoUniforme(
    auth: AuthContext,
    alvos: readonly { contactId?: string | null; dealId?: string | null }[],
  ): Promise<void> {
    if (!(await this.protegido.semClassificacao(auth))) return;
    for (const alvo of alvos) {
      await this.protegido.exigirAlvoVisivel(auth, {
        contactId: alvo.contactId,
        dealId: alvo.dealId,
      });
    }
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

  /**
   * O DTO com a regra de leitura do conteúdo protegido (E8; ADR-061, adendo
   * 8): o evento ligado a um contato oculto para quem pede, ou a uma
   * oportunidade de contato oculto, sai com o texto restrito.
   */
  private async toDtos(auth: AuthContext, rows: EventRow[]): Promise<CalendarEventDto[]> {
    const [organizers, contacts, ocultos] = await Promise.all([
      this.resolveMemberNames(rows.map((r) => r.organizerMembershipId)),
      this.resolveContactNames(rows.map((r) => r.contactId)),
      this.textosOcultos(auth, rows),
    ]);
    return rows.map((row) => this.projetar(row, organizers, contacts, ocultos.has(row.id)));
  }

  /**
   * Os eventos, dentre `rows`, de texto oculto para quem pede: pelos vínculos
   * de agora e pelo histórico deles (`vinculosDosEventos`: a criação, cada
   * vínculo posterior e os contatos que cada oportunidade já teve). O evento
   * desligado da pessoa protegida continua oculto; o que não existe mais vai
   * na dúvida. Sem consulta no modo `livre`.
   */
  async textosOcultos(
    auth: AuthContext,
    rows: readonly Pick<EventRow, 'id' | 'contactId' | 'dealId'>[],
  ): Promise<Set<string>> {
    return this.protegido.eventosComTextoOculto(
      auth,
      rows.map((r) => ({
        chave: r.id,
        eventoId: r.id,
        vinculos: [{ contactId: r.contactId, dealId: r.dealId }],
      })),
    );
  }

  private projetar(
    row: EventRow,
    organizers: Map<string, string>,
    contacts: Map<string, string>,
    oculto: boolean,
  ): CalendarEventDto {
    const dto: CalendarEventDto = {
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
    };
    return oculto ? comTextoRestrito(dto) : dto;
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

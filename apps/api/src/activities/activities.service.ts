import { BadRequestException, Injectable } from '@nestjs/common';
import type { ActivityDto, ActivityPageDto, ActivityType } from '@veyra/contracts';
import { z } from 'zod';
import { CONTEUDO_RESTRITO } from '../extensions/protected-content';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService, type Db } from '../prisma/prisma.service';

/** aceita o db protegido OU uma transação raw (que exige workspaceId explícito) */
type AnyClient = Db | Prisma.TransactionClient;

/**
 * Mapa FECHADO ActivityType → schema de payload (ajuste #4): validado
 * exclusivamente aqui, com .strict() — chave extra é rejeitada. Cada timeline
 * recebe só o mínimo para exibição; NUNCA corpo de nota, e-mail ou dado
 * sensível. Tipo novo = entrada nova aqui + revisão de security.
 */
const ACTIVITY_PAYLOADS: Record<ActivityType, z.ZodType> = {
  contact_created: z.object({ name: z.string().max(160) }).strict(),
  deal_created: z.object({ title: z.string().max(160), amountCents: z.number().int() }).strict(),
  deal_stage_changed: z
    .object({ fromStage: z.string().max(60), toStage: z.string().max(60) })
    .strict(),
  deal_updated: z.object({ title: z.string().max(160) }).strict(),
  deal_won: z.object({ amountCents: z.number().int() }).strict(),
  deal_lost: z.object({ amountCents: z.number().int() }).strict(),
  task_created: z.object({ title: z.string().max(200) }).strict(),
  task_completed: z.object({ title: z.string().max(200) }).strict(),
  note_added: z.object({}).strict(), // sem corpo, por design
  note_deleted: z.object({}).strict(),
  // NUNCA o corpo da mensagem na timeline (LGPD/§5): a direção já está no tipo
  message_sent: z.object({}).strict(),
  message_received: z.object({}).strict(),
  event_scheduled: z.object({ title: z.string().max(200), startAt: z.string().max(40) }).strict(),
};

export interface ActivityTargets {
  contactId?: string | null;
  companyId?: string | null;
  dealId?: string | null;
  taskId?: string | null;
  conversationId?: string | null;
  calendarEventId?: string | null;
}

interface Cursor {
  occurredAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const occurredAt = new Date(iso);
  if (Number.isNaN(occurredAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id ?? '')) {
    throw new BadRequestException('Cursor inválido');
  }
  return { occurredAt, id };
}

/** Os eventos de oportunidade que levam o título dela no payload (ADR-061, adendo 5). */
const TIPOS_COM_TITULO_DO_DEAL: ReadonlySet<string> = new Set(['deal_created', 'deal_updated']);

/** Decide, pelos vínculos, quais atividades `event_scheduled` têm o texto oculto (adendo 8). */
type TextosDeEventoOcultos = (
  itens: {
    chave: string;
    vinculos: { contactId: string | null; dealId: string | null }[] | null;
  }[],
) => Promise<Set<string>>;

function semCampo(payload: ActivityDto['payload'], campo: string): ActivityDto['payload'] {
  const copia = { ...(payload as Record<string, unknown>) };
  delete copia[campo];
  return copia as ActivityDto['payload'];
}

@Injectable()
export class ActivitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * ÚNICO ponto de escrita na timeline (append-only, ADR-011). Chamado pelos
   * services de domínio DENTRO da transação da mutação (tx do db.$transaction).
   */
  async record(
    db: AnyClient,
    workspaceId: string,
    type: ActivityType,
    options: {
      actorMembershipId: string | null;
      payload: Record<string, unknown>;
      targets: ActivityTargets;
      /**
       * `ai` quando a mutação foi EXECUTADA pela IA a partir de proposta
       * aprovada: o ator é a IA e `actorMembershipId` guarda quem aprovou,
       * como contexto. Sem isso, a timeline creditaria o humano por uma ação
       * que ele apenas autorizou.
       */
      actorType?: 'user' | 'system' | 'ai';
    },
  ): Promise<void> {
    const schema = ACTIVITY_PAYLOADS[type];
    const parsed = schema.safeParse(options.payload);
    if (!parsed.success) {
      // bug de programação, não input de usuário: falhar alto e cedo
      throw new Error(`Payload inválido para Activity ${type}: ${parsed.error.message}`);
    }
    await db.activity.create({
      data: {
        // explícito: no db protegido é validado contra o CLS (igual = ok);
        // na tx raw (moves sob lock) é o próprio carimbo
        workspaceId,
        type,
        actorType: options.actorType ?? (options.actorMembershipId ? 'user' : 'system'),
        actorMembershipId: options.actorMembershipId,
        payload: parsed.data as object,
        contactId: options.targets.contactId ?? null,
        companyId: options.targets.companyId ?? null,
        dealId: options.targets.dealId ?? null,
        taskId: options.targets.taskId ?? null,
        conversationId: options.targets.conversationId ?? null,
        calendarEventId: options.targets.calendarEventId ?? null,
      },
    } as never);
  }

  /** Timeline por alvo único, cursor keyset (occurredAt, id) desc (ajuste #5). */
  async list(
    target: { contactId?: string; dealId?: string },
    limit: number,
    rawCursor?: string,
    options: {
      includeDealEvents?: boolean;
      /** exclui as atividades de nota e tarefa de contato protegido (ADR-061) */
      conteudoVisivel?: Record<string, unknown>;
      /** o alvo tem conteúdo protegido para quem pede: a resposta diz isso */
      conteudoRestrito?: boolean;
      /**
       * as oportunidades, dentre as dos eventos, de título oculto para quem
       * pede (ADR-061, adendo 5): o `title` sai do payload, e a resposta diz
       * que há conteúdo restrito
       */
      titulosOcultos?: (
        itens: { id: string; dealId: string; contactId: string | null; title: unknown }[],
      ) => Promise<Set<string>>;
      /**
       * as atividades `event_scheduled`, dentre as dadas com os vínculos
       * gravados nelas e os do evento de agora (`null`: o evento não existe
       * mais), cujo texto é oculto para quem pede (ADR-061, adendo 8): o
       * `title` sai como "Conteúdo restrito", e a resposta diz que há
       * conteúdo restrito
       */
      textosDeEventoOcultos?: TextosDeEventoOcultos;
    } = {},
  ): Promise<ActivityPageDto> {
    /**
     * A timeline do contato (ADR-052, C12): o que tem `contactId` gravado (o
     * legado, anterior à F4.1a, e o que não é de conversa) MAIS as atividades
     * sem contato de conversas cujo contato ATUAL é ele. Religar a conversa
     * muda a timeline junto; a conversa RAI não aparece na de ninguém.
     */
    const targetWhere = target.contactId
      ? {
          OR: [
            { contactId: target.contactId },
            { contactId: null, conversation: { contactId: target.contactId } },
          ],
        }
      : { dealId: target.dealId };
    // sem pipelines:read, eventos de oportunidade (que carregam valores) não
    // entram nem na timeline do contato
    const visibilityWhere =
      options.includeDealEvents === false
        ? {
            type: {
              notIn: [
                'deal_created',
                'deal_stage_changed',
                'deal_updated',
                'deal_won',
                'deal_lost',
              ],
            },
          }
        : {};
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    // AND: o alvo e o cursor usam `OR` cada um, e um não pode apagar o outro
    const where = {
      AND: [
        targetWhere,
        visibilityWhere,
        options.conteudoVisivel ?? {},
        cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {},
      ],
    };
    const rows = await this.prisma.db.activity.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    } as never);

    const page = rows.slice(0, limit);
    const actorNames = await this.resolveActorNames(page.map((row) => row.actorMembershipId));
    const comTitulo = page.filter(
      (row) => TIPOS_COM_TITULO_DO_DEAL.has(row.type) && row.dealId !== null,
    );
    // o título oculto pela oportunidade de AGORA ou por ter sido dado enquanto
    // ela era de um contato oculto (ADR-061, adendo 7, item 4a): o conjunto
    // de ids de ATIVIDADE
    const ocultasPorId =
      options.titulosOcultos && comTitulo.length > 0
        ? await options.titulosOcultos(
            comTitulo.map((row) => ({
              id: row.id,
              dealId: row.dealId as string,
              contactId: row.contactId,
              title: (row.payload as Record<string, unknown> | null)?.title,
            })),
          )
        : new Set<string>();
    const eventosOcultos = await this.eventosOcultos(page, options.textosDeEventoOcultos);
    const items: ActivityDto[] = page.map((row) => {
      const payload = row.payload as ActivityDto['payload'];
      const semTitulo = TIPOS_COM_TITULO_DO_DEAL.has(row.type) && ocultasPorId.has(row.id);
      return {
        id: row.id,
        type: row.type as ActivityType,
        actorType: row.actorType,
        actorName: row.actorMembershipId ? (actorNames.get(row.actorMembershipId) ?? null) : null,
        payload: semTitulo
          ? semCampo(payload, 'title')
          : eventosOcultos.has(row.id)
            ? { ...payload, title: CONTEUDO_RESTRITO }
            : payload,
        occurredAt: row.occurredAt.toISOString(),
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      ...(options.conteudoRestrito || ocultasPorId.size > 0 || eventosOcultos.size > 0
        ? { restrictedContent: true as const }
        : {}),
    };
  }

  /**
   * As atividades `event_scheduled` da página cujo texto (o título do evento)
   * é oculto para quem pede (ADR-061, adendo 8). Os vínculos de cada uma: os
   * gravados nela (a pessoa do momento) E os do evento de agora, que pode ter
   * sido religado; o evento que não existe mais vai na dúvida (`null`).
   */
  private async eventosOcultos(
    page: {
      id: string;
      type: string;
      contactId: string | null;
      dealId: string | null;
      calendarEventId: string | null;
    }[],
    textosOcultos?: TextosDeEventoOcultos,
  ): Promise<Set<string>> {
    const eventos = page.filter((row) => row.type === 'event_scheduled');
    if (!textosOcultos || eventos.length === 0) return new Set();
    const ids = eventos.map((row) => row.calendarEventId).filter((id): id is string => Boolean(id));
    const atuais = (await this.prisma.db.calendarEvent.findMany({
      where: { id: { in: ids } },
      select: { id: true, contactId: true, dealId: true },
    } as never)) as unknown as { id: string; contactId: string | null; dealId: string | null }[];
    const porId = new Map(atuais.map((e) => [e.id, e]));
    return textosOcultos(
      eventos.map((row) => {
        const atual = row.calendarEventId ? porId.get(row.calendarEventId) : undefined;
        return {
          chave: row.id,
          vinculos: atual
            ? [
                { contactId: row.contactId, dealId: row.dealId },
                { contactId: atual.contactId, dealId: atual.dealId },
              ]
            : null,
        };
      }),
    );
  }

  private async resolveActorNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: ids } },
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

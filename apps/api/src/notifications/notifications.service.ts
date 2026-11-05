import { Injectable } from '@nestjs/common';
import type { NotificationDto, NotificationPageDto, NotificationType } from '@veyra/contracts';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';
import type { AuthContext } from '../common/decorators';
import { CONTEUDO_RESTRITO, ProtectedContentService } from '../extensions/protected-content';
import { PrismaService, type Db } from '../prisma/prisma.service';

type AnyClient = Db | Prisma.TransactionClient;

/**
 * ALLOWLIST de payload por tipo (mesmo padrão do outbox e da timeline): o que
 * chega na caixa do usuário é declarado aqui, com .strict(). Nunca corpo de
 * mensagem, nunca entidade inteira. Tipo novo = entrada nova + revisão.
 */
const NOTIFICATION_PAYLOADS: Record<NotificationType, z.ZodType> = {
  calendar_event_scheduled: z
    .object({ title: z.string().max(200), startAt: z.string().max(40) })
    .strict(),
  conversation_assigned: z.object({ subject: z.string().max(200) }).strict(),
};

/**
 * O evento da agenda de uma `calendar_event_scheduled`, lido da `dedupeKey`
 * (`calendar_event_scheduled:<evento>:<destinatário>`, gravada pelo
 * CalendarService): a notificação não guarda o id em outra coluna, e o texto
 * dela foi gravado PRONTO no envio.
 */
const EVENTO_DA_NOTIFICACAO = /^calendar_event_scheduled:([0-9a-f-]{36}):/i;

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly protegido: ProtectedContentService,
  ) {}

  /**
   * ÚNICO ponto de emissão. Chamado DENTRO da transação do fato que a origina —
   * notificação de evento que não existe é impossível. `dedupeKey` torna a
   * emissão idempotente: retry do mesmo fato não gera segunda notificação.
   */
  async emit(
    db: AnyClient,
    workspaceId: string,
    recipientMembershipId: string,
    type: NotificationType,
    payload: Record<string, unknown>,
    dedupeKey: string,
  ): Promise<void> {
    const parsed = NOTIFICATION_PAYLOADS[type].safeParse(payload);
    if (!parsed.success) {
      // bug de programação, não input: falhar alto e cedo
      throw new Error(`Payload inválido para notificação ${type}: ${parsed.error.message}`);
    }
    try {
      await db.notification.create({
        data: {
          workspaceId,
          recipientMembershipId,
          type,
          payload: parsed.data as object,
          dedupeKey,
        },
      } as never);
    } catch (error) {
      // dedupeKey repetido = mesmo fato já notificado (idempotência barata)
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  /** Caixa PESSOAL: o destinatário é sempre a membership da sessão. */
  async list(
    auth: AuthContext,
    input: { unreadOnly: boolean; limit: number },
  ): Promise<NotificationPageDto> {
    const membershipId = auth.membershipId as string;
    const where = {
      recipientMembershipId: membershipId,
      ...(input.unreadOnly ? { readAt: null } : {}),
    };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.db.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: input.limit,
      } as never),
      this.prisma.db.notification.count({
        where: { recipientMembershipId: membershipId, readAt: null },
      } as never),
    ]);
    const linhas = rows as unknown as {
      id: string;
      type: string;
      payload: unknown;
      dedupeKey: string;
      readAt: Date | null;
      createdAt: Date;
    }[];
    const ocultas = await this.eventosOcultos(auth, linhas);
    const items: NotificationDto[] = linhas.map((row) => {
      const payload = row.payload as Record<string, string>;
      return {
        id: row.id,
        type: row.type as NotificationType,
        payload: ocultas.has(row.id) ? { ...payload, title: CONTEUDO_RESTRITO } : payload,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    });
    return { items, unreadCount };
  }

  /**
   * As notificações de evento da agenda cujo texto é oculto para quem lê
   * (ADR-061, adendo 8). O título foi gravado no envio, então a regra é
   * aplicada na LEITURA, pelos vínculos de AGORA do evento e pelo histórico
   * deles (`vinculosDosEventos`): o interessado que vira paciente deixa de ter
   * o título servido no pedido seguinte, e desligar o evento não devolve o
   * título. O evento
   * que não existe mais (ou a chave fora do formato) vai na dúvida: oculto
   * fora do `livre`.
   */
  private async eventosOcultos(
    auth: AuthContext,
    linhas: readonly { id: string; type: string; dedupeKey: string }[],
  ): Promise<Set<string>> {
    const deEvento = linhas
      .filter((l) => l.type === 'calendar_event_scheduled')
      .map((l) => ({ id: l.id, eventoId: EVENTO_DA_NOTIFICACAO.exec(l.dedupeKey)?.[1] ?? null }));
    return this.protegido.eventosComTextoOculto(
      auth,
      deEvento.map((n) => ({ chave: n.id, eventoId: n.eventoId })),
    );
  }

  /**
   * Marcar como lida SÓ funciona na própria caixa: o membershipId da sessão
   * entra no where, então o id de outra pessoa simplesmente não casa.
   */
  async markRead(membershipId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.db.notification.updateMany({
      where: { id, recipientMembershipId: membershipId, readAt: null },
      data: { readAt: new Date() },
    });
    return count > 0;
  }

  async markAllRead(membershipId: string): Promise<number> {
    const { count } = await this.prisma.db.notification.updateMany({
      where: { recipientMembershipId: membershipId, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}

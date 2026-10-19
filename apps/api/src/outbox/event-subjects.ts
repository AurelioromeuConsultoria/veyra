import type { WebhookEvent } from '@veyra/contracts';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';

/** `null` = conteúdo que não se atribui a contato nenhum (ou que não dá para saber). */
export type EventSubject = string | null;

type SubjectClient = Db | Prisma.TransactionClient | PrismaClient;

/**
 * De QUAL entidade é cada evento do catálogo de webhooks (ADR-047 E6, adendo 2).
 * EXAUSTIVO sobre `WebhookEvent`: evento novo no catálogo sem entrada aqui não
 * compila — ninguém esquece de dizer de quem é o dado que sai.
 */
export const EVENT_SUBJECT: Record<WebhookEvent, 'contact' | 'deal' | 'task'> = {
  'contact.created': 'contact',
  'contact.updated': 'contact',
  'contact.deleted': 'contact',
  'deal.created': 'deal',
  'deal.stage_changed': 'deal',
  'deal.won': 'deal',
  'deal.lost': 'deal',
  'task.created': 'task',
  'task.completed': 'task',
};

/**
 * Contatos de quem é o evento AGORA, resolvidos pela entidade dele. Fonte única
 * da regra, usada na entrega de webhook e na herança de evento antigo.
 *
 * `[]` = a entidade existe e não tem contato nenhum. `[null]` = não dá para
 * saber (tipo fora do mapa, payload sem id, entidade apagada) — e a porta trata
 * o desconhecido como restrito quando há dado sensível. Tarefa responde pelo
 * contato DELA e pelo do deal a que pertence.
 *
 * `workspaceId` EXPLÍCITO em toda leitura: o chamador pode estar fora do CLS
 * (worker cross-workspace, `raw`) ou dentro de uma transação protegida.
 */
export async function resolveEventSubjects(
  client: SubjectClient,
  workspaceId: string,
  eventType: string,
  payload: unknown,
): Promise<EventSubject[]> {
  const source = EVENT_SUBJECT[eventType as WebhookEvent] as
    (typeof EVENT_SUBJECT)[WebhookEvent] | undefined;
  const id = (payload as { id?: unknown } | null)?.id;
  if (!source || typeof id !== 'string') return [null];
  if (source === 'contact') return [id];
  const db = client as unknown as PrismaClient;
  const dealContact = async (dealId: string): Promise<EventSubject[] | null> => {
    const deal = await db.deal.findFirst({
      where: { workspaceId, id: dealId },
      select: { contactId: true },
    });
    if (!deal) return null;
    return deal.contactId ? [deal.contactId] : [];
  };
  if (source === 'deal') return (await dealContact(id)) ?? [null];
  const task = await db.task.findFirst({
    where: { workspaceId, id },
    select: { contactId: true, dealId: true },
  });
  if (!task) return [null];
  const subjects: EventSubject[] = task.contactId ? [task.contactId] : [];
  if (task.dealId) subjects.push(...((await dealContact(task.dealId)) ?? [null]));
  return subjects;
}

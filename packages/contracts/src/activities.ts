import { z } from 'zod';

export const activityTypeSchema = z.enum([
  'contact_created',
  'deal_created',
  'deal_stage_changed',
  'deal_updated',
  'deal_won',
  'deal_lost',
  'task_created',
  'task_completed',
  'note_added',
  'note_deleted',
  'message_sent',
  'message_received',
  'event_scheduled',
]);
export type ActivityType = z.infer<typeof activityTypeSchema>;

/**
 * Timeline exige EXATAMENTE um alvo (ajuste #5): nunca feed global acidental.
 * Paginação por cursor keyset (occurredAt, id) — estável sob inserções.
 */
export const listActivitiesSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .superRefine((value, ctx) => {
    const targets = [value.contactId, value.dealId].filter(Boolean);
    if (targets.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'Informe exatamente um alvo: contactId OU dealId',
      });
    }
  });
export type ListActivitiesInput = z.infer<typeof listActivitiesSchema>;

export interface ActivityDto {
  id: string;
  type: ActivityType;
  /** `ai` = mutação executada pela IA a partir de proposta aprovada; o nome,
   *  quando presente, é de quem aprovou (contexto, não autoria) */
  actorType: 'user' | 'system' | 'ai';
  actorName: string | null;
  /** payload mínimo validado por mapa fechado no servidor — nunca corpo de nota */
  payload: Record<string, string | number>;
  occurredAt: string;
}

export interface ActivityPageDto {
  items: ActivityDto[];
  /** cursor da próxima página; null = fim */
  nextCursor: string | null;
}

import { z } from 'zod';

export const calendarEventStatusSchema = z.enum(['scheduled', 'done', 'canceled']);
export type CalendarEventStatus = z.infer<typeof calendarEventStatusSchema>;

/**
 * `endAt > startAt` é validado aqui E no banco (CHECK): o Zod dá mensagem boa
 * ao usuário, o CHECK garante a invariante mesmo por caminho não-HTTP.
 */
const timeWindow = {
  startAt: z.iso.datetime(),
  endAt: z.iso.datetime(),
};
const endAfterStart = (value: { startAt: string; endAt: string }, ctx: z.RefinementCtx) => {
  if (new Date(value.endAt) <= new Date(value.startAt)) {
    ctx.addIssue({ code: 'custom', message: 'O término precisa ser depois do início' });
  }
};

export const createCalendarEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(4000).optional(),
    ...timeWindow,
    location: z.string().trim().max(200).optional(),
    /** ausente = a própria membership da sessão organiza */
    organizerMembershipId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .superRefine(endAfterStart);
export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;

export const updateCalendarEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    startAt: z.iso.datetime().optional(),
    endAt: z.iso.datetime().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    status: calendarEventStatusSchema.optional(),
    organizerMembershipId: z.string().uuid().optional(),
    contactId: z.string().uuid().nullable().optional(),
    dealId: z.string().uuid().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // só dá para comparar quando as DUAS pontas vieram; o service completa a
    // janela com o valor atual e revalida antes de gravar
    if (value.startAt && value.endAt)
      endAfterStart({ startAt: value.startAt, endAt: value.endAt }, ctx);
  });
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;

/** Agenda é sempre consultada por JANELA — nunca "tudo". */
export const listCalendarEventsSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    organizerMembershipId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    status: z.enum(['scheduled', 'done', 'canceled', 'all']).default('scheduled'),
  })
  .superRefine((value, ctx) => {
    if (new Date(value.to) <= new Date(value.from)) {
      ctx.addIssue({ code: 'custom', message: 'A janela precisa terminar depois de começar' });
    }
  });
export type ListCalendarEventsInput = z.infer<typeof listCalendarEventsSchema>;

export interface CalendarEventDto {
  id: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  location: string | null;
  status: CalendarEventStatus;
  organizerMembershipId: string;
  organizerName: string | null;
  contactId: string | null;
  contactName: string | null;
  dealId: string | null;
  createdAt: string;
}

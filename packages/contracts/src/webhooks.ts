import { z } from 'zod';

/** Eventos publicáveis — espelham a allowlist do OutboxService (v1). */
export const webhookEventSchema = z.enum([
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'deal.created',
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'task.created',
  'task.completed',
]);
export type WebhookEvent = z.infer<typeof webhookEventSchema>;

export const createWebhookSchema = z.object({
  url: z.string().url().max(2000),
  events: z.array(webhookEventSchema).min(1).max(20),
});
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const updateWebhookSchema = z.object({
  url: z.string().url().max(2000).optional(),
  events: z.array(webhookEventSchema).min(1).max(20).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;

export interface WebhookDto {
  id: string;
  url: string;
  events: string[];
  status: 'active' | 'paused' | 'disabled';
  /** entregas MORTAS consecutivas (3 pausam o webhook) */
  failureCount: number;
  createdAt: string;
}

export interface WebhookDeliveryDto {
  id: string;
  outboxEventId: string;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}

import { z } from 'zod';

/** Tipos emitidos hoje; a allowlist de payload vive no servidor. */
export const notificationTypeSchema = z.enum(['calendar_event_scheduled', 'conversation_assigned']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const listNotificationsSchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;

export interface NotificationDto {
  id: string;
  type: NotificationType;
  /** payload mínimo validado por mapa fechado no servidor */
  payload: Record<string, string>;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPageDto {
  items: NotificationDto[];
  unreadCount: number;
}

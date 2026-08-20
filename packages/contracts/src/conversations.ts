import { z } from 'zod';

export const conversationStatusSchema = z.enum(['open', 'pending', 'closed']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const messageDirectionSchema = z.enum(['inbound', 'outbound']);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

export const messageAuthorSchema = z.enum(['contact', 'user', 'ai', 'system']);
export type MessageAuthorType = z.infer<typeof messageAuthorSchema>;

/**
 * O canal NÃO é entrada do cliente (ADR-023): o service usa o canal interno de
 * sistema do workspace. Quando houver canal externo, a escolha vira explícita.
 */
export const createConversationSchema = z.object({
  contactId: z.string().uuid().optional(),
  subject: z.string().trim().max(200).optional(),
  assigneeMembershipId: z.string().uuid().optional(),
});
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({
  subject: z.string().trim().max(200).nullable().optional(),
  status: conversationStatusSchema.optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
});
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

/** Inbox: cursor keyset (lastMessageAt, id) desc — estável sob mensagem nova. */
export const listConversationsSchema = z.object({
  status: z.enum(['open', 'pending', 'closed', 'all']).default('open'),
  assigneeMembershipId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;

/**
 * Registro manual nos dois sentidos: `outbound` é o que o time enviou,
 * `inbound` o que o contato disse. O autor é derivado no servidor a partir da
 * direção — nunca informado pelo cliente.
 */
export const createMessageSchema = z.object({
  direction: messageDirectionSchema,
  body: z.string().trim().min(1).max(10000),
  /** ids de FileObject já enviados; anexar é parte da criação (append-only) */
  attachmentIds: z.array(z.string().uuid()).max(5).optional(),
});
export type CreateMessageInput = z.infer<typeof createMessageSchema>;

export const listMessagesSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;

export interface ConversationDto {
  id: string;
  channelType: 'internal' | 'email' | 'whatsapp';
  contactId: string | null;
  contactName: string | null;
  subject: string | null;
  status: ConversationStatus;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface MessageAttachmentDto {
  fileObjectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'quarantined';
}

export interface MessageDto {
  id: string;
  direction: MessageDirection;
  authorType: MessageAuthorType;
  authorName: string | null;
  body: string;
  attachments: MessageAttachmentDto[];
  deliveredAt: string | null;
  createdAt: string;
}

export interface ConversationPageDto {
  items: ConversationDto[];
  nextCursor: string | null;
}

export interface MessagePageDto {
  /** mais recentes primeiro; o cursor caminha para o passado */
  items: MessageDto[];
  nextCursor: string | null;
}

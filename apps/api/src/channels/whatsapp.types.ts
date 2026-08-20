import { z } from 'zod';

/**
 * Forma MÍNIMA do payload da Meta que nos interessa, com `.passthrough()` nos
 * envelopes: a Meta adiciona campos sem aviso, e recusar o payload inteiro por
 * isso faria o webhook devolver erro e a Meta reentregar para sempre.
 *
 * O que NÃO fazemos aqui: confiar em qualquer campo antes da assinatura conferir
 * (ADR-037). Este schema roda depois.
 */
const messageSchema = z
  .object({
    id: z.string().min(1).max(200),
    from: z.string().min(1).max(40),
    timestamp: z.string().min(1).max(20),
    type: z.string().min(1).max(40),
    text: z
      .object({ body: z.string().max(10000) })
      .partial()
      .optional(),
    image: z
      .object({ id: z.string().max(200), mime_type: z.string().max(100) })
      .partial()
      .optional(),
    document: z
      .object({
        id: z.string().max(200),
        mime_type: z.string().max(100),
        filename: z.string().max(200),
      })
      .partial()
      .optional(),
    audio: z
      .object({ id: z.string().max(200), mime_type: z.string().max(100) })
      .partial()
      .optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    id: z.string().min(1).max(200),
    status: z.string().min(1).max(40),
    timestamp: z.string().min(1).max(20),
    errors: z
      .array(
        z
          .object({ code: z.number().optional(), title: z.string().max(200).optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const whatsappWebhookSchema = z
  .object({
    object: z.string().max(60),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    field: z.string().max(60).optional(),
                    value: z
                      .object({
                        metadata: z
                          .object({ phone_number_id: z.string().min(1).max(60) })
                          .passthrough(),
                        contacts: z
                          .array(
                            z
                              .object({
                                wa_id: z.string().max(40),
                                profile: z
                                  .object({ name: z.string().max(160) })
                                  .partial()
                                  .optional(),
                              })
                              .passthrough(),
                          )
                          .optional(),
                        messages: z.array(messageSchema).optional(),
                        statuses: z.array(statusSchema).optional(),
                      })
                      .passthrough(),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type WhatsappWebhook = z.infer<typeof whatsappWebhookSchema>;

/** Tipos de mensagem que sabemos ingerir; o resto é registrado e ignorado. */
export const SUPPORTED_MESSAGE_TYPES = new Set(['text', 'image', 'document', 'audio']);

/** Mapa status do provedor → nosso enum. Desconhecido é ignorado. */
export const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'read' | 'failed'> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

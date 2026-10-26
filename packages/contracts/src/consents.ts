import { z } from 'zod';

/**
 * Finalidades, consentimentos e o pedido de parar (ADR-052 item 5, F4.1b).
 *
 * - A ORIGEM é uma lista fechada, sem texto livre (C9): o registro guarda como
 *   a pessoa se manifestou, não o que alguém achou que ela quis dizer.
 * - O NÚMERO nunca é digitado: vem de um número exato do contato, ou do
 *   endereço de uma conversa (decisão de 2026-10-26).
 * - O RECIBO (`CON-`, `PAR-`, `DES-`) é emitido pelo servidor. Ele identifica o
 *   registro no sistema; não prova sozinho que a pessoa consentiu.
 */

export const consentOriginSchema = z.enum(['in_person', 'phone', 'paper_form']);
export type ConsentOrigin = z.infer<typeof consentOriginSchema>;

export const consentPurposeCategorySchema = z.enum(['utility', 'marketing']);
export type ConsentPurposeCategory = z.infer<typeof consentPurposeCategorySchema>;

export const consentRevocationReasonSchema = z.enum(['manual', 'number_removed', 'stop_requested']);
export type ConsentRevocationReason = z.infer<typeof consentRevocationReasonSchema>;

/**
 * A versão nova de uma finalidade, só pela CLI administrativa: imutável, com a
 * descrição mostrada à pessoa, a categoria e a lista FECHADA de campos que um
 * envio dela pode usar. O Core não cria finalidade nenhuma.
 */
export const createConsentPurposeSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/, 'Chave em minúsculas, dígitos e _'),
    description: z.string().trim().min(1).max(2000),
    category: consentPurposeCategorySchema,
    fields: z
      .array(z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,60}$/, 'Campo inválido'))
      .max(50)
      .refine((fields) => new Set(fields).size === fields.length, 'Campo repetido'),
  })
  .strict();
export type CreateConsentPurposeInput = z.infer<typeof createConsentPurposeSchema>;

/** "+dígitos", a forma exata; o servidor confere que é um número exato do contato. */
const exactNumberSchema = z.string().regex(/^\+\d{8,20}$/, 'Número no formato +dígitos');

/**
 * Conceder, na rota do contato: um número exato dele, num canal do negócio,
 * numa versão da finalidade.
 */
export const grantConsentSchema = z
  .object({
    channelId: z.string().uuid(),
    number: exactNumberSchema,
    purposeId: z.string().uuid(),
    origin: consentOriginSchema,
  })
  .strict();
export type GrantConsentInput = z.infer<typeof grantConsentSchema>;

/** Revogar: a origem da manifestação da pessoa. */
export const revokeConsentSchema = z.object({ origin: consentOriginSchema }).strict();
export type RevokeConsentInput = z.infer<typeof revokeConsentSchema>;

/**
 * O pedido de parar e o desbloqueio, na rota do CONTATO: um número exato dele.
 * No desbloqueio, a origem é a da NOVA solicitação da pessoa, e nenhum
 * consentimento anterior volta.
 */
export const contactStopSchema = z
  .object({ number: exactNumberSchema, origin: consentOriginSchema })
  .strict();
export type ContactStopInput = z.infer<typeof contactStopSchema>;

/**
 * O mesmo, na rota da CONVERSA: o número é o endereço dela, inclusive na
 * "remetente a identificar", sem precisar atribuí-la a um contato.
 */
export const conversationStopSchema = z.object({ origin: consentOriginSchema }).strict();
export type ConversationStopInput = z.infer<typeof conversationStopSchema>;

export interface ConsentPurposeDto {
  id: string;
  key: string;
  version: number;
  description: string;
  category: ConsentPurposeCategory;
  fields: string[];
}

export interface ConsentDto {
  id: string;
  contactId: string;
  channelId: string;
  number: string;
  purposeId: string;
  purposeKey: string;
  purposeVersion: number;
  /** a fotografia da descrição aceita */
  purposeDescription: string;
  origin: ConsentOrigin;
  receipt: string;
  grantedAt: string;
  revokedAt: string | null;
  revocationReason: ConsentRevocationReason | null;
}

export interface StopBlockDto {
  id: string;
  number: string;
  origin: ConsentOrigin;
  receipt: string;
  createdAt: string;
  liftedAt: string | null;
  liftReceipt: string | null;
}

export interface ContactConsentsDto {
  /** todos, inclusive os revogados: o histórico não se apaga */
  consents: ConsentDto[];
  /** os pedidos de parar ATIVOS para os números exatos do contato */
  stopBlocks: StopBlockDto[];
}

export interface ConversationConsentsDto {
  /** completo só com `contacts:read`; para os outros, os 4 últimos */
  number: string | null;
  /** o pedido de parar ATIVO para o número da conversa (o número mascarado como acima) */
  stopBlock: StopBlockDto | null;
  /** os do contato da conversa para este número; vazio na RAI */
  consents: ConsentDto[];
}

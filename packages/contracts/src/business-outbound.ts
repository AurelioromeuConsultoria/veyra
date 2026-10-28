import { z } from 'zod';

/**
 * O envio iniciado pelo negócio (`business_outbound`, ADR-052 itens 6 a 8,
 * F4.1c-3): um template revisado, para um (contato, número exato) com
 * consentimento vigente da finalidade, aprovado por uma pessoa sobre a prévia.
 * O `approvalHash` é um HMAC do servidor sobre o alvo, a versão, a revisão, a
 * finalidade, o consentimento, os VALORES exatos, a origem e o prazo: a
 * aprovação e o despacho o recalculam com os dados de agora, e o que divergir
 * não sai. Nada é escolhido nem atualizado em silêncio.
 */

/** A origem do pedido: `conversation:<uuid>` (o Inbox) ou o prefixo de um vertical (E7). */
const originRefSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_.-]{0,40}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'Origem no formato prefixo:uuid',
  );

/** O número exato, como o endereço da conversa: "+dígitos". */
const numeroSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Número no formato +dígitos');

/** O alvo de um item: quem recebe, o quê, por qual finalidade e de onde vem. */
export const businessOutboundTargetSchema = z
  .object({
    originRef: originRefSchema,
    channelId: z.string().uuid(),
    contactId: z.string().uuid(),
    number: numeroSchema,
    templateVersionId: z.string().uuid(),
    purposeId: z.string().uuid(),
  })
  .strict();
export type BusinessOutboundTarget = z.infer<typeof businessOutboundTargetSchema>;

export const previewBusinessOutboundSchema = z
  .object({ items: z.array(businessOutboundTargetSchema).min(1).max(50) })
  .strict();
export type PreviewBusinessOutboundInput = z.infer<typeof previewBusinessOutboundSchema>;

/** O item aprovado: o alvo, mais o prazo e o hash da prévia que a pessoa viu. */
export const approveBusinessOutboundItemSchema = businessOutboundTargetSchema
  .extend({
    expiresAt: z.string().datetime({ offset: false }),
    approvalHash: z.string().regex(/^[0-9a-f]{64}$/, 'HMAC-SHA256 em hexadecimal'),
  })
  .strict();
export type ApproveBusinessOutboundItem = z.infer<typeof approveBusinessOutboundItemSchema>;

export const approveBusinessOutboundSchema = z
  .object({ items: z.array(approveBusinessOutboundItemSchema).min(1).max(50) })
  .strict();
export type ApproveBusinessOutboundInput = z.infer<typeof approveBusinessOutboundSchema>;

/**
 * Por que um item não foi aprovado — ou por que o despacho não saiu. Lista
 * fechada: o web traduz cada um, e nenhum traz dado do contato.
 */
export const BUSINESS_OUTBOUND_REASONS = [
  // o destinatário (item 6 do ADR-052)
  'address_changed',
  'address_ambiguous',
  'consent_revoked',
  'opted_out',
  'conversation_relinked',
  // o conteúdo (item 4)
  'template_changed',
  'template_unavailable',
  'template_unverified',
  'template_not_reviewed',
  // a aprovação (item 8)
  'approval_stale',
  'approval_expired',
  // o valor de um campo não serve como parâmetro (vazio, longo, com quebra de linha)
  'field_value_invalid',
  // a pré-condição do vertical (E7, item 9)
  'precondition_failed',
  'precondition_unavailable',
  'precondition_unknown',
  // o canal e a operação
  'no_credential',
  'quota_exceeded',
  'busy',
  // uma falha inesperada naquele item: nada dele foi gravado, e os outros seguem
  'not_processed',
  // a origem de vertical já tem uma aprovação (uma por origem, F4.2)
  'origin_already_approved',
] as const;
export type BusinessOutboundReason = (typeof BUSINESS_OUTBOUND_REASONS)[number];

export type BusinessOutboundPreviewItemDto =
  | {
      index: number;
      ok: true;
      /** o texto como sai, com os valores no lugar dos parâmetros */
      text: string;
      /** parâmetro (`body.1`) → valor exato */
      values: Record<string, string>;
      expiresAt: string;
      approvalHash: string;
    }
  | { index: number; ok: false; reason: BusinessOutboundReason };

export interface BusinessOutboundPreviewDto {
  items: BusinessOutboundPreviewItemDto[];
}

/** A resposta do lote: só ids, estados e motivos — nunca a prévia (é a guardada no replay). */
export interface BusinessOutboundResultItemDto {
  index: number;
  state: 'approved' | 'refused';
  messageId: string | null;
  reason: BusinessOutboundReason | null;
}

export interface BusinessOutboundResultDto {
  items: BusinessOutboundResultItemDto[];
}

export const templateOptionsQuerySchema = z.object({ conversationId: z.string().uuid() }).strict();
export type TemplateOptionsQuery = z.infer<typeof templateOptionsQuerySchema>;

/**
 * Uma opção do compositor do Inbox com a janela fechada (item 6 do plano da
 * F4.1c): uma versão ativa e revisada para uma finalidade com consentimento
 * vigente do número da conversa. O ALVO vem pronto do servidor — a origem, o
 * canal, o contato e o número —, e o web só o devolve à prévia: ele não monta
 * o destinatário.
 */
export interface TemplateOptionDto {
  target: BusinessOutboundTarget;
  templateVersionId: string;
  name: string;
  language: string;
  version: number;
  category: 'utility' | 'marketing';
  purposeId: string;
  purposeKey: string;
  purposeVersion: number;
  purposeDescription: string;
}

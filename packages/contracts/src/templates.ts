import { z } from 'zod';

/**
 * Templates do WhatsApp versionados, revisados e relidos (ADR-052 item 4,
 * F4.1c-2). A versão é imutável e guarda a forma canônica do conteúdo lido da
 * Meta, o vínculo de cada parâmetro com um campo e o `contentHash`; a revisão
 * é por (versão, finalidade), por quem tem `templates:review`. Nada aqui abre
 * envio: ligar as versões ao envio é da F4.1c-3.
 */

export const templateCategorySchema = z.enum(['utility', 'marketing']);
export type TemplateCategory = z.infer<typeof templateCategorySchema>;

export const templateParameterFormatSchema = z.enum(['positional', 'named']);
export type TemplateParameterFormat = z.infer<typeof templateParameterFormatSchema>;

/** `divergent`: a Meta mostrou outro conteúdo; a versão nunca mais é usada. */
export const templateVersionStatusSchema = z.enum(['active', 'divergent']);
export type TemplateVersionStatus = z.infer<typeof templateVersionStatusSchema>;

/**
 * O catálogo de campos do CORE que um parâmetro pode usar (decisão 4 do
 * usuário, 2026-10-26): o nome do contato e, desde a F4.2, o primeiro nome
 * (minimização, ADR-048 adendo 9), vindos do servidor. Os campos do vertical
 * entram pelo E7. O valor nunca é guardado na versão — só o nome do campo.
 */
export const CAMPOS_DO_CORE = ['contato.nome', 'contato.primeiro_nome'] as const;
export type CampoDoCore = (typeof CAMPOS_DO_CORE)[number];

/** O hash que a pessoa viu: a revisão só vale para ele. */
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Hash SHA-256 em hexadecimal');

/** Revisar uma versão para uma versão de finalidade. */
export const createTemplateReviewSchema = z
  .object({ purposeId: z.string().uuid(), contentHash: contentHashSchema })
  .strict();
export type CreateTemplateReviewInput = z.infer<typeof createTemplateReviewSchema>;

export const listTemplateVersionsSchema = z
  .object({ channelId: z.string().uuid().optional() })
  .strict();
export type ListTemplateVersionsInput = z.infer<typeof listTemplateVersionsSchema>;

/** Os componentes aceitos, na forma canônica (sem `example` nem mídia). */
export type TemplateButtonDto =
  | { type: 'quick_reply'; text: string }
  | { type: 'url'; text: string; url: string }
  | { type: 'phone_number'; text: string; phoneNumber: string };

export type TemplateComponentDto =
  | { type: 'header'; format: 'text'; text: string }
  | { type: 'body'; text: string }
  | { type: 'footer'; text: string }
  | { type: 'buttons'; buttons: TemplateButtonDto[] };

export interface TemplateReviewDto {
  id: string;
  templateVersionId: string;
  purposeId: string;
  contentHash: string;
  reviewedByMembershipId: string;
  createdAt: string;
}

export interface TemplateVersionDto {
  id: string;
  channelId: string;
  /** a WABA de onde a versão saiu (não é segredo) */
  businessAccountId: string;
  metaTemplateId: string;
  name: string;
  language: string;
  version: number;
  category: TemplateCategory;
  parameterFormat: TemplateParameterFormat;
  components: TemplateComponentDto[];
  /** parâmetro (`header.1`, `body.nome`) → campo do catálogo */
  bindings: Record<string, string>;
  contentHash: string;
  status: TemplateVersionStatus;
  createdAt: string;
  reviews: TemplateReviewDto[];
}

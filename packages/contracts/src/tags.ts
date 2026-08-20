import { z } from 'zod';

/** Cor semântica da tag — paleta fechada (DESIGN_DIRECTION: sem cor solta). */
export const tagColorSchema = z.enum([
  'slate',
  'stone',
  'accent',
  'positive',
  'negative',
  'warning',
  'info',
]);
export type TagColor = z.infer<typeof tagColorSchema>;

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: tagColorSchema.default('slate'),
});
export type CreateTagInput = z.infer<typeof createTagSchema>;

export const updateTagSchema = createTagSchema.partial();
export type UpdateTagInput = z.infer<typeof updateTagSchema>;

export interface TagDto {
  id: string;
  name: string;
  color: TagColor;
  /** quantos contatos/empresas usam a tag (para a coluna de uso) */
  usageCount: number;
}

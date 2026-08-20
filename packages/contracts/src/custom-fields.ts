import { z } from 'zod';

/** Entidades do Core que aceitam campos personalizados. */
export const customFieldEntitySchema = z.enum(['contact', 'company']);
export type CustomFieldEntity = z.infer<typeof customFieldEntitySchema>;

export const customFieldTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'boolean',
  'select',
  'multiselect',
]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const createCustomFieldSchema = z
  .object({
    entityType: customFieldEntitySchema,
    /** chave estável usada nas APIs (snake_case) — imutável após criada */
    key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case: comece com letra e use apenas a-z, 0-9 e _'),
    label: z.string().trim().min(1).max(80),
    type: customFieldTypeSchema,
    options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    required: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    const needsOptions = value.type === 'select' || value.type === 'multiselect';
    if (needsOptions && (!value.options || value.options.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Campos de seleção exigem ao menos uma opção',
      });
    }
    if (!needsOptions && value.options?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Apenas campos de seleção aceitam opções',
      });
    }
  });
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

/** `key` e `entityType` não mudam depois de criados (dados já gravados). */
export const updateCustomFieldSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  required: z.boolean().optional(),
});
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

export interface CustomFieldDto {
  id: string;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[];
  required: boolean;
}

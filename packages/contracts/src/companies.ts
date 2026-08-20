import { z } from 'zod';
import { paginationSchema, sortDirectionSchema, type CustomFieldValues } from './common';

export const companySizeSchema = z.enum(['solo', 'small', 'medium', 'large', 'enterprise']);
export type CompanySize = z.infer<typeof companySizeSchema>;

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(160),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Domínio inválido (ex.: empresa.com.br)')
    .max(253)
    .optional(),
  size: companySizeSchema.optional(),
  ownerMembershipId: z.string().uuid().optional(),
  tagIds: z
    .array(z.string().uuid())
    .max(20)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

/** nullable nos vínculos: `null` desvincula/limpa (undefined = não mexer). */
export const updateCompanySchema = createCompanySchema.partial().extend({
  domain: createCompanySchema.shape.domain.unwrap().nullable().optional(),
  size: companySizeSchema.nullable().optional(),
  ownerMembershipId: z.string().uuid().nullable().optional(),
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const listCompaniesSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  tagId: z.string().uuid().optional(),
  sortBy: z.enum(['name', 'createdAt']).default('createdAt'),
  sortDir: sortDirectionSchema,
});
export type ListCompaniesInput = z.infer<typeof listCompaniesSchema>;

export interface CompanyDto {
  id: string;
  name: string;
  domain: string | null;
  size: CompanySize | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  tags: { id: string; name: string; color: string }[];
  customFields: CustomFieldValues;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

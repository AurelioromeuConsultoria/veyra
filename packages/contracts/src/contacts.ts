import { z } from 'zod';
import { paginationSchema, sortDirectionSchema, type CustomFieldValues } from './common';

export const contactStatusSchema = z.enum(['active', 'archived']);
export type ContactStatus = z.infer<typeof contactStatusSchema>;

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9()\-. ]{6,25}$/, 'Telefone inválido');

export const createContactSchema = z.object({
  name: z.string().trim().min(1).max(160),
  emails: z.array(emailSchema).max(5).default([]),
  phones: z.array(phoneSchema).max(5).default([]),
  companyId: z.string().uuid().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  source: z.string().trim().max(60).optional(),
  tagIds: z
    .array(z.string().uuid())
    .max(20)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  customFields: z.record(z.string(), z.unknown()).default({}),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

/** nullable nos vínculos: `null` desvincula (undefined = não mexer). */
export const updateContactSchema = createContactSchema.partial().extend({
  status: contactStatusSchema.optional(),
  companyId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  source: z.string().trim().max(60).nullable().optional(),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const listContactsSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: contactStatusSchema.default('active'),
  companyId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('createdAt'),
  sortDir: sortDirectionSchema,
});
export type ListContactsInput = z.infer<typeof listContactsSchema>;

/** Importação CSV simples (Entrega 3): nome obrigatório, e-mail/telefone opcionais. */
export const importContactsSchema = z.object({
  rows: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(160),
        email: emailSchema.optional(),
        phone: phoneSchema.optional(),
      }),
    )
    .min(1)
    .max(1000),
});
export type ImportContactsInput = z.infer<typeof importContactsSchema>;

export interface ContactDto {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  status: ContactStatus;
  companyId: string | null;
  companyName: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  source: string | null;
  tags: { id: string; name: string; color: string }[];
  customFields: CustomFieldValues;
  createdAt: string;
  updatedAt: string;
}

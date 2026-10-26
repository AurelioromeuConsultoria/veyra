import { z } from 'zod';
import { paginationSchema, sortDirectionSchema, type CustomFieldValues } from './common';

export const contactStatusSchema = z.enum(['active', 'archived']);
export type ContactStatus = z.infer<typeof contactStatusSchema>;

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9()\-. ]{6,25}$/, 'Telefone inválido');

/**
 * Os campos de contato UMA vez, sem default: a criação põe os defaults, a
 * atualização os deixa opcionais. Duas listas de campos deixariam os limites
 * divergirem em silêncio.
 */
const tagIdsSchema = z
  .array(z.string().uuid())
  .max(20)
  .transform((ids) => [...new Set(ids)]);
const camposDoContato = {
  name: z.string().trim().min(1).max(160),
  emails: z.array(emailSchema).max(5),
  phones: z.array(phoneSchema).max(5),
  source: z.string().trim().max(60),
  tagIds: tagIdsSchema,
  customFields: z.record(z.string(), z.unknown()),
};

export const createContactSchema = z.object({
  name: camposDoContato.name,
  emails: camposDoContato.emails.default([]),
  phones: camposDoContato.phones.default([]),
  companyId: z.string().uuid().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  source: camposDoContato.source.optional(),
  tagIds: camposDoContato.tagIds.default([]),
  customFields: camposDoContato.customFields.default({}),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

/**
 * nullable nos vínculos: `null` desvincula (undefined = não mexer).
 *
 * Os campos vêm de `camposDoContato`, SEM default, de propósito: o `.partial()`
 * do Zod 4 mantém os defaults do schema de criação, e um PATCH sem `phones` (ou
 * sem `emails`, `tagIds`, `customFields`) os apagava. Com a identidade de
 * telefone (ADR-052, F4.1a), isso ainda tirava os números do contato e
 * travava os endereços dele numa edição que só mudava o status.
 */
export const updateContactSchema = z.object({
  name: camposDoContato.name.optional(),
  emails: camposDoContato.emails.optional(),
  phones: camposDoContato.phones.optional(),
  status: contactStatusSchema.optional(),
  companyId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  source: camposDoContato.source.nullable().optional(),
  tagIds: camposDoContato.tagIds.optional(),
  customFields: camposDoContato.customFields.optional(),
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

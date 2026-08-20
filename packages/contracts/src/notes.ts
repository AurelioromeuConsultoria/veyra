import { z } from 'zod';

export const createNoteSchema = z
  .object({
    body: z.string().trim().min(1).max(8000),
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const targets = [value.contactId, value.companyId, value.dealId].filter(Boolean);
    if (targets.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'A nota precisa de um alvo (contato, empresa ou oportunidade)',
      });
    }
  });
export type CreateNoteInput = z.infer<typeof createNoteSchema>;

export const listNotesSchema = z
  .object({
    contactId: z.string().uuid().optional(),
    companyId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const targets = [value.contactId, value.companyId, value.dealId].filter(Boolean);
    if (targets.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'Informe exatamente um alvo' });
    }
  });
export type ListNotesInput = z.infer<typeof listNotesSchema>;

export interface NoteDto {
  id: string;
  body: string;
  authorMembershipId: string;
  authorName: string | null;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  createdAt: string;
}

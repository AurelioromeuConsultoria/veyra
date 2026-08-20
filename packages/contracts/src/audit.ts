import { z } from 'zod';

export const auditActorSchema = z.enum(['user', 'api', 'system', 'ai']);
export type AuditActorType = z.infer<typeof auditActorSchema>;

export const listAuditSchema = z.object({
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().uuid().optional(),
  action: z.string().trim().max(60).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAuditInput = z.infer<typeof listAuditSchema>;

export interface AuditEntryDto {
  id: string;
  actorType: AuditActorType;
  /** nome do membro quando ator é usuário; identificação da origem nos demais */
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /** só campos da allowlist; fora dela vira "[changed]" — nunca segredo */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}

export interface AuditPageDto {
  items: AuditEntryDto[];
  nextCursor: string | null;
}

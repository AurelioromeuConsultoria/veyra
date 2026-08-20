import { z } from 'zod';
import type { StageType } from './pipelines';

export const createDealSchema = z.object({
  title: z.string().trim().min(1).max(160),
  pipelineId: z.string().uuid().optional(), // ausente = pipeline default
  stageId: z.string().uuid().optional(), // ausente = primeiro stage open
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  ownerMembershipId: z.string().uuid().optional(),
  amountCents: z.number().int().min(0).max(9_999_999_999).default(0),
  currency: z.string().length(3).toUpperCase().default('BRL'),
  expectedCloseDate: z.iso.date().optional(),
});
export type CreateDealInput = z.infer<typeof createDealSchema>;

export const updateDealSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  contactId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid().nullable().optional(),
  ownerMembershipId: z.string().uuid().nullable().optional(),
  amountCents: z.number().int().min(0).max(9_999_999_999).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  expectedCloseDate: z.iso.date().nullable().optional(),
});
export type UpdateDealInput = z.infer<typeof updateDealSchema>;

export const moveDealSchema = z.object({
  stageId: z.string().uuid(),
  /** posição-alvo na coluna (índice 0-based); ausente = fim da coluna */
  index: z.number().int().min(0).max(10_000).optional(),
});
export type MoveDealInput = z.infer<typeof moveDealSchema>;

export const listDealsSchema = z.object({
  pipelineId: z.string().uuid().optional(), // ausente = pipeline default
});
export type ListDealsInput = z.infer<typeof listDealsSchema>;

export interface DealDto {
  id: string;
  title: string;
  pipelineId: string;
  stageId: string;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  ownerMembershipId: string | null;
  ownerName: string | null;
  amountCents: number;
  currency: string;
  expectedCloseDate: string | null;
  status: 'open' | 'won' | 'lost';
  position: number;
  /** dias desde a entrada no stage atual (sinal de "parado") */
  daysInStage: number;
  createdAt: string;
}

export interface BoardColumnDto {
  stageId: string;
  stageName: string;
  stageType: StageType;
  totalCents: number;
  deals: DealDto[];
}

export interface BoardDto {
  pipelineId: string;
  pipelineName: string;
  columns: BoardColumnDto[];
}

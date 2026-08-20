import { z } from 'zod';

export const stageTypeSchema = z.enum(['open', 'won', 'lost']);
export type StageType = z.infer<typeof stageTypeSchema>;

export const createPipelineSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;

export const updatePipelineSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** true assume o posto de default (o anterior perde a marca) */
  isDefault: z.literal(true).optional(),
});
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;

export const createStageSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: stageTypeSchema.default('open'),
  probability: z.number().int().min(0).max(100).optional(),
});
export type CreateStageInput = z.infer<typeof createStageSchema>;

export const updateStageSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
});
export type UpdateStageInput = z.infer<typeof updateStageSchema>;

export const reorderStagesSchema = z.object({
  /** ordem completa dos stages do pipeline (ids na nova sequência) */
  stageIds: z.array(z.string().uuid()).min(1).max(50),
});
export type ReorderStagesInput = z.infer<typeof reorderStagesSchema>;

export interface StageDto {
  id: string;
  name: string;
  order: number;
  probability: number | null;
  type: StageType;
}

export interface PipelineDto {
  id: string;
  name: string;
  isDefault: boolean;
  stages: StageDto[];
}

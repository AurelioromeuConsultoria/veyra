import { z } from 'zod';

/**
 * CATÁLOGO FECHADO (ADR-035). Gatilhos são eventos de domínio que já existem no
 * outbox; ações são uma lista pequena; condições são predicados DECLARADOS —
 * não existe expressão arbitrária avaliada no servidor.
 */
export const automationTriggerSchema = z.enum([
  'contact.created',
  'deal.created',
  'deal.won',
  'deal.lost',
  'task.created',
  'task.completed',
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const automationActionSchema = z.enum(['create_task']);
export type AutomationActionType = z.infer<typeof automationActionSchema>;

export const automationConditionSchema = z
  .object({
    /** campo do payload do evento (allowlist do próprio evento) */
    field: z.string().min(1).max(40),
    op: z.enum(['equals', 'contains', 'gt', 'lt']),
    value: z.union([z.string().max(200), z.number()]),
  })
  .strict();
export type AutomationCondition = z.infer<typeof automationConditionSchema>;

/** Config da ação `create_task`: título com um marcador simples, sem template engine. */
export const createTaskConfigSchema = z
  .object({
    /** `{{name}}`/`{{title}}` são substituídos pelo campo homônimo do payload */
    title: z.string().min(1).max(120),
    dueInDays: z.number().int().min(0).max(30).default(1),
  })
  .strict();
export type CreateTaskConfig = z.infer<typeof createTaskConfigSchema>;

export const createAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    trigger: automationTriggerSchema,
    conditions: z.array(automationConditionSchema).max(5).default([]),
    action: automationActionSchema,
    actionConfig: createTaskConfigSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

export const updateAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    conditions: z.array(automationConditionSchema).max(5).optional(),
    actionConfig: createTaskConfigSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;

export interface AutomationDto {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  action: AutomationActionType;
  actionConfig: CreateTaskConfig;
  enabled: boolean;
  createdAt: string;
}

export interface AutomationExecutionDto {
  id: string;
  automationId: string;
  automationName: string;
  outboxEventId: string;
  status: 'executed' | 'skipped' | 'failed';
  reason: string | null;
  createdAt: string;
}

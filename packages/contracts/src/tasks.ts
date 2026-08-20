import { z } from 'zod';
import { paginationSchema } from './common';

export const taskPrioritySchema = z.enum(['low', 'normal', 'high']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional(),
  dueAt: z.iso.datetime().optional(),
  assigneeMembershipId: z.string().uuid().optional(),
  priority: taskPrioritySchema.default('normal'),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  dueAt: z.iso.datetime().nullable().optional(),
  assigneeMembershipId: z.string().uuid().nullable().optional(),
  priority: taskPrioritySchema.optional(),
  status: z.enum(['open', 'done']).optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const listTasksSchema = paginationSchema.extend({
  status: z.enum(['open', 'done', 'all']).default('open'),
  assigneeMembershipId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
});
export type ListTasksInput = z.infer<typeof listTasksSchema>;

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  status: 'open' | 'done';
  priority: TaskPriority;
  contactId: string | null;
  dealId: string | null;
  completedAt: string | null;
  createdAt: string;
}

import { z } from 'zod';

/** Paginação padrão das listagens (tabelas densas do modo operacional). */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationInput = z.infer<typeof paginationSchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']).default('asc');

/** Envelope de listagem paginada — mesma forma em todo o Core. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Valor de campo personalizado, resolvido pela definição (key → valor). */
export type CustomFieldValues = Record<string, string | number | boolean | string[] | null>;

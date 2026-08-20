import { z } from 'zod';

/**
 * Validação de ambiente no boot (fail-fast): se a env é inválida, a aplicação
 * não sobe — nunca "meio funcionando". Ver docs/SECURITY.md §8.
 *
 * Segredos de auth (JWT_SECRET etc.) entram na Entrega 2 — sempre com
 * validação de formato.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().url().startsWith('postgresql://'),
  // Auth (Entrega 2). JWT_SECRET nunca com default: fail-fast se ausente.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Origem do front (CORS estrito + validação de Origin em mutações com cookie)
  WEB_ORIGIN: z.string().url().default('http://localhost:5175'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Variáveis de ambiente inválidas — a aplicação não vai subir:\n${issues}`);
  }
  return parsed.data;
}

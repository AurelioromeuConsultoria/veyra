import { z } from 'zod';

/**
 * Validação de ambiente no boot (fail-fast): se a env é inválida, a aplicação
 * não sobe — nunca "meio funcionando". Ver docs/SECURITY.md §8.
 *
 * Segredos de auth (JWT_SECRET etc.) entram na Entrega 2 — sempre com
 * validação de formato.
 */
/**
 * Opcional que aceita STRING VAZIA como ausência.
 *
 * `FOO=` num arquivo de ambiente é a forma natural de escrever "não tenho
 * este segredo", e é o que um `.env` de staging gerado a partir do modelo
 * contém. Sem este tratamento, `z.string().min(1).optional()` recebe `''`
 * (a variável EXISTE, vazia), falha a validação e derruba o boot em laço —
 * exatamente no caso que o produto foi desenhado para tolerar, que é rodar
 * sem chave de IA.
 */
function opcional(schema: z.ZodString) {
  return z.preprocess((valor) => (valor === '' ? undefined : valor), schema.optional());
}

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
  // Retenção da trilha de auditoria (SECURITY.md §5) — configurável por plano
  // Cifra de segredos em repouso (SECURITY.md §8) — independente do JWT
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(32, 'TOKEN_ENCRYPTION_KEY precisa de ao menos 32 caracteres'),
  // Kill switch dos jobs (worker do outbox)
  // z.coerce.boolean() faria DISABLE_JOBS='false' virar TRUE (Boolean('false')),
  // desligando o worker em silêncio — comparação explícita
  DISABLE_JOBS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
  /**
   * Prazo do CONTEÚDO derivado de conversa em `AiRun.result` (ADR-042). Menor
   * que o da auditoria de propósito: a trilha de quem fez o quê vale por mais
   * tempo que o texto que um modelo escreveu sobre a conversa de um paciente.
   */
  AI_RESULT_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  /**
   * ClamAV (ADR-043). AUSENTE = sem scanner: o arquivo fica `pending` e não sai
   * para canal externo. A falta de scanner degrada para o seguro, não para o
   * liberado — por isso é opcional em vez de obrigatório.
   */
  CLAMAV_HOST: opcional(z.string().min(1)),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  // raiz do storage local (ADR-024); com S3 vira bucket + credencial cifrada
  STORAGE_ROOT: z.string().min(1).default('.storage'),
  // IA (Entrega 7): SEM chave o produto segue funcionando — cada capacidade
  // degrada com clareza (score continua, explicação some)
  ANTHROPIC_API_KEY: opcional(z.string().min(1)),
  AI_MODEL: z.string().min(1).default('claude-sonnet-5'),
  /**
   * Canal WhatsApp (Entrega 9.1). O APP SECRET vive aqui, no ambiente, e não
   * por canal (ADR-037): hoje há um único Meta App. Ausentes, o canal
   * simplesmente não pode ser configurado — o resto do produto segue.
   */
  META_APP_SECRET: opcional(z.string().min(16)),
  META_WEBHOOK_VERIFY_TOKEN: opcional(z.string().min(16)),
  META_GRAPH_VERSION: z.string().min(2).default('v21.0'),
  /**
   * Ambiente lógico. Existe para uma única finalidade: autorizar o que NÃO
   * pode existir em produção. Hoje, o transporte falso do WhatsApp.
   */
  VEYRA_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /**
   * Transporte do WhatsApp (ADR-046). `graph` é o padrão — a AUSÊNCIA da
   * variável nunca produz o transporte falso, e é essa assimetria que impede
   * que um esquecimento vire perda silenciosa de mensagem.
   */
  META_TRANSPORT_MODE: z.enum(['graph', 'fake']).default('graph'),
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

  /**
   * TRAVA DO TRANSPORTE FALSO (ADR-046). Um ambiente que finge envio em
   * silêncio é pior que um que falha: quem opera acredita ter falado com o
   * paciente. A recusa é no BOOT, no mesmo espírito do harness de teste que
   * recusa banco cujo nome não contenha "test" — erro de configuração vira
   * container que não sobe, nunca mensagem que não sai.
   */
  if (parsed.data.META_TRANSPORT_MODE === 'fake' && parsed.data.VEYRA_ENV !== 'staging') {
    throw new Error(
      'META_TRANSPORT_MODE=fake exige VEYRA_ENV=staging — ' +
        `recebido VEYRA_ENV=${parsed.data.VEYRA_ENV}. O transporte falso NÃO envia nada ` +
        'para a Meta; fora de staging isso seria perda silenciosa de mensagem (ADR-046).',
    );
  }

  return parsed.data;
}

import { validateEnv } from './env';

/**
 * A validação de ambiente é o portão de boot: o que ela recusa vira container
 * em laço de reinício. Este spec nasceu de um defeito real — `ANTHROPIC_API_KEY=`
 * vazio num `.env` de staging derrubava a API, justamente no caso que o produto
 * foi desenhado para tolerar (rodar sem chave, degradando cada capacidade).
 */
const minimo = {
  DATABASE_URL: 'postgresql://veyra:x@db:5432/veyra',
  JWT_SECRET: 'a'.repeat(32),
  TOKEN_ENCRYPTION_KEY: 'b'.repeat(32),
};

describe('validateEnv', () => {
  it('aceita o conjunto mínimo e aplica os defaults', () => {
    const env = validateEnv({ ...minimo });
    expect(env.PORT).toBe(3001);
    expect(env.AI_MODEL).toBe('claude-sonnet-5');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('trata VARIÁVEL VAZIA como ausente nos opcionais', () => {
    const env = validateEnv({
      ...minimo,
      ANTHROPIC_API_KEY: '',
      CLAMAV_HOST: '',
      META_APP_SECRET: '',
      META_WEBHOOK_VERIFY_TOKEN: '',
    });
    // ausente, não "presente e inválida": é o que mantém o produto de pé sem
    // chave de IA e sem scanner (ADR-043)
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAMAV_HOST).toBeUndefined();
    expect(env.META_APP_SECRET).toBeUndefined();
  });

  it('continua recusando valor PRESENTE e inválido', () => {
    // segredo curto demais é erro de configuração, não ausência: falha alto
    expect(() => validateEnv({ ...minimo, META_APP_SECRET: 'curto' })).toThrow(/META_APP_SECRET/);
    expect(() => validateEnv({ ...minimo, JWT_SECRET: 'curto' })).toThrow(/JWT_SECRET/);
  });

  it('recusa banco que não seja postgres', () => {
    expect(() => validateEnv({ ...minimo, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });
});

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

  /**
   * A trava do ADR-046. O modo falso não envia nada para a Meta: fora de
   * staging isso é perda SILENCIOSA de mensagem, e o produto prefere não subir
   * a fingir que enviou.
   */
  describe('transporte falso do WhatsApp', () => {
    it('o padrão é o transporte REAL — ausência da variável nunca produz o falso', () => {
      expect(validateEnv({ ...minimo }).META_TRANSPORT_MODE).toBe('graph');
      expect(validateEnv({ ...minimo, VEYRA_ENV: 'staging' }).META_TRANSPORT_MODE).toBe('graph');
    });

    it('aceita o modo falso APENAS em staging', () => {
      const env = validateEnv({ ...minimo, VEYRA_ENV: 'staging', META_TRANSPORT_MODE: 'fake' });
      expect(env.META_TRANSPORT_MODE).toBe('fake');
    });

    it('RECUSA O BOOT com modo falso em produção ou desenvolvimento', () => {
      for (const ambiente of ['production', 'development']) {
        expect(() =>
          validateEnv({ ...minimo, VEYRA_ENV: ambiente, META_TRANSPORT_MODE: 'fake' }),
        ).toThrow(/META_TRANSPORT_MODE=fake exige VEYRA_ENV=staging/);
      }
    });

    it('recusa o boot com modo falso quando VEYRA_ENV nem foi informado', () => {
      // o default é `development`: esquecer a variável não vira staging
      expect(() => validateEnv({ ...minimo, META_TRANSPORT_MODE: 'fake' })).toThrow(
        /exige VEYRA_ENV=staging/,
      );
    });

    it('recusa modo desconhecido em vez de cair no padrão', () => {
      expect(() => validateEnv({ ...minimo, META_TRANSPORT_MODE: 'nenhum' })).toThrow(
        /META_TRANSPORT_MODE/,
      );
    });
  });

  it('recusa banco que não seja postgres', () => {
    expect(() => validateEnv({ ...minimo, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });
});

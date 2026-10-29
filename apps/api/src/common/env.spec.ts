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
  ADDRESS_LOCK_KEY: 'c'.repeat(32),
  OUTBOUND_APPROVAL_KEY: 'd'.repeat(32),
  MAINTENANCE_MODE: 'false',
};

describe('validateEnv', () => {
  it('MAINTENANCE_MODE é obrigatória e só aceita true ou false (ADR-053)', () => {
    const semAVariavel: Record<string, unknown> = { ...minimo };
    delete semAVariavel.MAINTENANCE_MODE;
    expect(() => validateEnv(semAVariavel)).toThrow(
      /MAINTENANCE_MODE é obrigatória: true ou false/,
    );
    for (const invalido of ['', 'sim', '1', 'TRUE', 'on']) {
      expect(() => validateEnv({ ...minimo, MAINTENANCE_MODE: invalido })).toThrow(
        /MAINTENANCE_MODE/,
      );
    }
    expect(validateEnv({ ...minimo, MAINTENANCE_MODE: 'true' }).MAINTENANCE_MODE).toBe(true);
    expect(validateEnv({ ...minimo, MAINTENANCE_MODE: 'false' }).MAINTENANCE_MODE).toBe(false);
  });

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

  it('ADDRESS_LOCK_KEY é obrigatória e sem default (ADR-052 item 3): sem ela, ou curta, não sobe', () => {
    const semChave: Record<string, string> = { ...minimo };
    delete semChave.ADDRESS_LOCK_KEY;
    expect(() => validateEnv(semChave)).toThrow(/ADDRESS_LOCK_KEY/);
    expect(() => validateEnv({ ...minimo, ADDRESS_LOCK_KEY: 'curta' })).toThrow(/ADDRESS_LOCK_KEY/);
    // independente das outras chaves, e nunca o valor de exemplo em produção
    expect(() => validateEnv({ ...minimo, ADDRESS_LOCK_KEY: minimo.JWT_SECRET })).toThrow(
      /ADDRESS_LOCK_KEY precisa ser diferente/,
    );
    expect(() => validateEnv({ ...minimo, ADDRESS_LOCK_KEY: minimo.TOKEN_ENCRYPTION_KEY })).toThrow(
      /ADDRESS_LOCK_KEY precisa ser diferente/,
    );
    const exemplo = 'troque-por-outra-chave-independente-e-estavel';
    expect(() =>
      validateEnv({ ...minimo, NODE_ENV: 'production', ADDRESS_LOCK_KEY: exemplo }),
    ).toThrow(/valor de exemplo/);
    expect(validateEnv({ ...minimo, ADDRESS_LOCK_KEY: exemplo }).ADDRESS_LOCK_KEY).toBe(exemplo);
  });

  it('OUTBOUND_APPROVAL_KEY é obrigatória, longa e independente (F4.1c-3): sem ela, não sobe', () => {
    const semChave: Record<string, string> = { ...minimo };
    delete semChave.OUTBOUND_APPROVAL_KEY;
    expect(() => validateEnv(semChave)).toThrow(/OUTBOUND_APPROVAL_KEY/);
    expect(() => validateEnv({ ...minimo, OUTBOUND_APPROVAL_KEY: 'curta' })).toThrow(
      /OUTBOUND_APPROVAL_KEY/,
    );
    for (const outra of [minimo.JWT_SECRET, minimo.TOKEN_ENCRYPTION_KEY, minimo.ADDRESS_LOCK_KEY]) {
      expect(() => validateEnv({ ...minimo, OUTBOUND_APPROVAL_KEY: outra })).toThrow(
        /OUTBOUND_APPROVAL_KEY precisa ser diferente/,
      );
    }
    const exemplo = 'troque-por-uma-chave-da-aprovacao-independente';
    expect(() =>
      validateEnv({ ...minimo, NODE_ENV: 'production', OUTBOUND_APPROVAL_KEY: exemplo }),
    ).toThrow(/valor de exemplo/);
    expect(validateEnv({ ...minimo, OUTBOUND_APPROVAL_KEY: exemplo }).OUTBOUND_APPROVAL_KEY).toBe(
      exemplo,
    );
  });

  it('AI_MODEL fora do formato de id de modelo NÃO sobe (ADR-047 adendo 7 §9)', () => {
    // a especificação do uso de IA recusaria cada geração na hora de usar
    for (const invalido of ['Claude-Sonnet', 'anthropic/claude', 'claude@2024', 'claude:latest']) {
      expect(() => validateEnv({ ...minimo, AI_MODEL: invalido })).toThrow(/AI_MODEL/);
    }
    expect(validateEnv({ ...minimo, AI_MODEL: 'claude-opus-5.5' }).AI_MODEL).toBe(
      'claude-opus-5.5',
    );
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

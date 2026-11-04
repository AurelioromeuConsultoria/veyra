import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aplicarMigrationsNaSubida } from './migrations-na-subida';

/** As migrations na subida do staging (ADR-058, adendo 2). */
describe('aplicarMigrationsNaSubida', () => {
  const staging = {
    NODE_ENV: 'production',
    VEYRA_ENV: 'staging',
    MAINTENANCE_MODE: 'false',
    PATH: '/usr/bin',
    HOME: '/app',
    DATABASE_URL: 'postgresql://ficticio',
    JWT_SECRET: 'nao-vai-para-o-filho',
  } as NodeJS.ProcessEnv;

  const espiao = (status: number | null, error?: Error) => {
    const chamadas: { comando: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const executar = (comando: string, args: string[], env: NodeJS.ProcessEnv) => {
      chamadas.push({ comando, args, env });
      return { status, error };
    };
    return { chamadas, executar };
  };

  it('no container do staging, roda o migrate deploy do Prisma da imagem, só com o ambiente dele', () => {
    const { chamadas, executar } = espiao(0);
    expect(aplicarMigrationsNaSubida(staging, false, executar)).toBe('aplicadas');
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].comando).toBe(join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma'));
    expect(chamadas[0].args).toEqual(['migrate', 'deploy']);
    // os outros segredos da API não vão para o processo filho
    expect(chamadas[0].env).toEqual({
      PATH: '/usr/bin',
      HOME: '/app',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://ficticio',
      CHECKPOINT_DISABLE: '1',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    });
  });

  it.each([
    ['a trava do banco ligada', true, 'false'],
    ['o MAINTENANCE_MODE=true', false, 'true'],
  ])('em manutenção (%s), nada migra', (_nome, trava, modo) => {
    const { chamadas, executar } = espiao(0);
    expect(aplicarMigrationsNaSubida({ ...staging, MAINTENANCE_MODE: modo }, trava, executar)).toBe(
      'em-manutencao',
    );
    expect(chamadas).toHaveLength(0);
  });

  it.each([
    ['o desenvolvimento', { NODE_ENV: 'development', VEYRA_ENV: 'development' }],
    ['o E2E (staging fora da imagem)', { NODE_ENV: 'development', VEYRA_ENV: 'staging' }],
    ['a produção', { NODE_ENV: 'production', VEYRA_ENV: 'production' }],
    ['sem VEYRA_ENV', { NODE_ENV: 'production' }],
  ])('fora do staging (%s), não roda nada', (_nome, env) => {
    const { chamadas, executar } = espiao(0);
    expect(aplicarMigrationsNaSubida(env as NodeJS.ProcessEnv, false, executar)).toBe(
      'fora-do-staging',
    );
    expect(chamadas).toHaveLength(0);
  });

  it.each([['TRUE'], ['1'], [''], [undefined]])(
    'MAINTENANCE_MODE=%s (não é o false exato): nada migra',
    (modo) => {
      const { chamadas, executar } = espiao(0);
      expect(
        aplicarMigrationsNaSubida({ ...staging, MAINTENANCE_MODE: modo }, false, executar),
      ).toBe('em-manutencao');
      expect(chamadas).toHaveLength(0);
    },
  );

  it.each([['FALSE'], ['0'], ['nao']])(
    'MIGRATIONS_NA_SUBIDA=%s (ambígua): a API não sobe',
    (valor) => {
      const { chamadas, executar } = espiao(0);
      expect(() =>
        aplicarMigrationsNaSubida({ ...staging, MIGRATIONS_NA_SUBIDA: valor }, false, executar),
      ).toThrow('MIGRATIONS_NA_SUBIDA inválida');
      expect(chamadas).toHaveLength(0);
    },
  );

  it('MIGRATIONS_NA_SUBIDA=true liga, como a ausência', () => {
    const { chamadas, executar } = espiao(0);
    expect(
      aplicarMigrationsNaSubida({ ...staging, MIGRATIONS_NA_SUBIDA: 'true' }, false, executar),
    ).toBe('aplicadas');
    expect(chamadas).toHaveLength(1);
  });

  it('MIGRATIONS_NA_SUBIDA=false desliga (a volta ao procedimento manual)', () => {
    const { chamadas, executar } = espiao(0);
    expect(
      aplicarMigrationsNaSubida({ ...staging, MIGRATIONS_NA_SUBIDA: 'false' }, false, executar),
    ).toBe('desligadas');
    expect(chamadas).toHaveLength(0);
  });

  it('a migration que falha PARA a subida, com o caminho da recuperação', () => {
    const { executar } = espiao(1);
    expect(() => aplicarMigrationsNaSubida(staging, false, executar)).toThrow(
      'as migrations na subida falharam (saída 1): a API não sobe. Siga o DEPLOY_STAGING §4.0, "As migrations na subida"',
    );
  });

  it('o Prisma que não executa também PARA a subida', () => {
    const { executar } = espiao(null, new Error('ENOENT'));
    expect(() => aplicarMigrationsNaSubida(staging, false, executar)).toThrow(
      'as migrations na subida não rodaram: ENOENT',
    );
  });

  it('no main.ts: depois da trava, com o estado dela, e antes do AppModule', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    const trava = main.indexOf('await aplicarTravaDeManutencao(process.env)');
    const migrations = main.indexOf("aplicarMigrationsNaSubida(process.env, trava === 'ligada')");
    const modulo = main.indexOf("await import('./app.module')");
    expect(trava).toBeGreaterThan(-1);
    expect(migrations).toBeGreaterThan(trava);
    expect(modulo).toBeGreaterThan(migrations);
  });
});

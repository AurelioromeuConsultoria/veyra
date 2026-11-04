import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * As migrations na SUBIDA da API no staging (ADR-058, adendo 2): o
 * `prisma migrate deploy` roda antes do Nest, a cada subida, com o schema e as
 * migrations que viajam na própria imagem — a versão do banco e a do código
 * são sempre a mesma. Substitui o `command` do compose do `00ef0ba`: aqui não
 * se toca em arquivo guardado (compose, Dockerfile, `env.ts`), e o próprio job
 * `Staging` publica a mudança.
 *
 * Quando roda: SÓ no container do staging (`NODE_ENV=production` da imagem e
 * `VEYRA_ENV=staging` do painel), e nunca em manutenção (a trava do banco ou
 * `MAINTENANCE_MODE=true`): numa janela, quem opera conduz. O desenvolvimento,
 * o CI e o E2E migram pelo caminho deles; a produção, quando existir, decide o
 * próprio (o `VEYRA_ENV` dela é `production`). `MIGRATIONS_NA_SUBIDA=false` no
 * painel desliga.
 *
 * Falhou, a subida PARA: cada migration é uma transação (ADR-051), então o
 * banco fica como estava, e o Prisma a marca como falhada (P3009) até alguém
 * liberar (DEPLOY_STAGING §4.0, "As migrations na subida"). Nunca segue com o
 * código novo sobre o schema velho.
 */
export type ResultadoDasMigrations =
  'aplicadas' | 'fora-do-staging' | 'em-manutencao' | 'desligadas';

type Executor = (
  comando: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => { status: number | null; error?: Error };

/** o diretório da API (de `dist/common` ou `src/common`): o `prisma.config.ts`, o schema e as migrations */
const DIRETORIO_DA_API = join(__dirname, '..', '..');

/** 10 min: os `lock_timeout` limitam cada espera, não a execução inteira */
const LIMITE_MS = 10 * 60_000;

const executarDeVerdade: Executor = (comando, args, env) =>
  spawnSync(comando, args, {
    cwd: DIRETORIO_DA_API,
    stdio: 'inherit',
    env,
    timeout: LIMITE_MS,
    killSignal: 'SIGKILL',
  });

export function aplicarMigrationsNaSubida(
  env: NodeJS.ProcessEnv,
  manutencao: boolean,
  executar: Executor = executarDeVerdade,
): ResultadoDasMigrations {
  if (env.NODE_ENV !== 'production' || env.VEYRA_ENV !== 'staging') return 'fora-do-staging';
  // fail-closed: só o `false` exato tira da manutenção (um `TRUE` ou `1`
  // digitado errado não migra; o `env.ts` só o recusaria depois, no AppModule)
  if (manutencao || env.MAINTENANCE_MODE !== 'false') return 'em-manutencao';
  const chave = env.MIGRATIONS_NA_SUBIDA;
  if (chave === 'false') return 'desligadas';
  if (chave !== undefined && chave !== 'true') {
    throw new Error(
      `MIGRATIONS_NA_SUBIDA inválida: use true, false ou deixe sem valor. A API não sobe com o valor ambíguo`,
    );
  }
  // o Prisma da imagem, direto (sem o npm no meio), e SÓ o ambiente de que ele
  // precisa: os outros segredos da API não vão para o processo filho
  const r = executar(
    join(DIRETORIO_DA_API, 'node_modules', '.bin', 'prisma'),
    ['migrate', 'deploy'],
    {
      PATH: env.PATH,
      HOME: env.HOME,
      NODE_ENV: env.NODE_ENV,
      DATABASE_URL: env.DATABASE_URL,
      // a subida não fala com a internet: nem a telemetria do Prisma, nem o aviso do npm
      CHECKPOINT_DISABLE: '1',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    },
  );
  if (r.error) throw new Error(`as migrations na subida não rodaram: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `as migrations na subida falharam (saída ${r.status}): a API não sobe. Siga o DEPLOY_STAGING §4.0, "As migrations na subida"`,
    );
  }
  return 'aplicadas';
}

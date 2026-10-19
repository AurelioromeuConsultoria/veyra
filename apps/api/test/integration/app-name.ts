/**
 * setupFilesAfterEnv: identifica as conexões do app DESTA suíte no Postgres
 * (`application_name` = processo + arquivo de teste). Com isso, o diagnóstico
 * do outbox mostra se outra execução — ou uma suíte anterior do mesmo
 * processo — ainda está conectada ao banco. O app de cada suíte é criado no
 * `beforeAll`, depois deste arquivo.
 */
const arquivo = (expect.getState().testPath ?? 'desconhecido')
  .split('/')
  .pop()!
  .replace(/\.integration-spec\.ts$/, '')
  .slice(0, 40);
const url = new URL(process.env.DATABASE_URL as string);
url.searchParams.set('application_name', `veyra-int-${process.pid}-${arquivo}`);
process.env.DATABASE_URL = url.toString();

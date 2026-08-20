/**
 * URL do banco de TESTE de integração, isolado do dev. Default: database
 * `veyra_test` no mesmo Postgres local (porta 5434 do docker-compose). Em CI,
 * defina TEST_DATABASE_URL para o Postgres efêmero.
 *
 * Trava de segurança: o nome do database PRECISA conter "test" — impede que
 * uma URL mal configurada aponte para dev/prod e o harness trunque dados reais.
 */
const DEFAULT_TEST_URL = 'postgresql://veyra:veyra_dev@localhost:5434/veyra_test';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;

export function assertIsTestDb(url = TEST_DATABASE_URL): string {
  const parsed = new URL(url);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!dbName.includes('test')) {
    throw new Error(
      `Recusando usar o banco "${dbName}" para testes: o nome precisa conter "test" ` +
        `(proteção contra apagar dado de dev/prod). Ajuste TEST_DATABASE_URL.`,
    );
  }
  // O harness inspeciona/trunca o schema `public`; uma URL com ?schema= diferente
  // faria o TRUNCATE mirar um schema não inspecionado via search_path.
  const schema = parsed.searchParams.get('schema');
  if (schema && schema !== 'public') {
    throw new Error(`TEST_DATABASE_URL com schema "${schema}" não suportado — use public.`);
  }
  return dbName;
}

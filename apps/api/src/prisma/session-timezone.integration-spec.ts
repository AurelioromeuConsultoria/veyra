import { Client } from 'pg';
import { PrismaClient } from '../generated/prisma/client';
import { TEST_DATABASE_URL, assertIsTestDb } from '../../test/integration/db-url';
import { prismaAdapter } from './prisma-adapter';
import { PrismaService } from './prisma.service';

/**
 * A sessão da aplicação fica em UTC qualquer que seja o padrão do servidor
 * (ADR-049). As colunas são `TIMESTAMP` sem fuso: com a sessão em outro fuso,
 * `now()` e o DEFAULT do banco seriam convertidos por ele, enquanto o adapter
 * lê tudo como UTC — o agendamento erraria por horas.
 *
 * O teste MUDA o fuso padrão do banco de teste e o devolve no fim (o
 * global-setup também o devolve a cada execução). Conexões NOVAS sem a
 * fixação recebem o fuso mudado (controle); as da aplicação, não.
 */
describe('fuso da sessão do banco (ADR-049)', () => {
  const banco = assertIsTestDb(TEST_DATABASE_URL);

  it('com o padrão do servidor em outro fuso, a sessão da aplicação continua em UTC e o DEFAULT lê certo', async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    const app = new PrismaClient({ adapter: prismaAdapter(TEST_DATABASE_URL) });
    const controle = new Client({ connectionString: TEST_DATABASE_URL });
    try {
      await admin.query(`ALTER DATABASE "${banco}" SET timezone TO 'America/Sao_Paulo'`);
      await controle.connect();
      // controle: sem a fixação, a sessão nova herda o fuso mudado
      expect((await controle.query('SHOW TimeZone')).rows[0].TimeZone).toBe('America/Sao_Paulo');

      const [{ TimeZone }] = await app.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
      expect(TimeZone).toBe('UTC');
      // o MESMO instante por dois caminhos, sem o relógio do Node: o valor sem
      // fuso (como o DEFAULT o grava), lido pelo adapter como UTC, e a época do
      // `timestamptz`, que não depende de fuso. Em São Paulo, diferiria em 3 h.
      const [{ semFuso, epoca }] = await app.$queryRawUnsafe<{ semFuso: Date; epoca: string }[]>(
        // trunca ANTES do cast: `::timestamp(3)` arredonda, `date_trunc` corta
        `SELECT date_trunc('milliseconds', transaction_timestamp())::timestamp(3) AS "semFuso",
                (extract(epoch from date_trunc('milliseconds', transaction_timestamp())) * 1000)::bigint::text AS epoca`,
      );
      expect(semFuso.getTime()).toBe(Number(epoca));
    } finally {
      // cada passo por si: uma falha não pode pular a devolução do fuso
      await admin
        .query(`ALTER DATABASE "${banco}" RESET timezone`)
        .catch((erro: unknown) => console.error('RESET timezone falhou', erro));
      await controle.end().catch(() => undefined);
      await app.$disconnect().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it('um `options` que a URL já traga é preservado e não desfaz a fixação (no `pg`, a URL vence o config)', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set('options', '-c TimeZone=America/Sao_Paulo -c statement_timeout=12345');
    const app = new PrismaClient({
      adapter: prismaAdapter(url.toString()),
    });
    try {
      const [{ TimeZone }] = await app.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
      const [{ statement_timeout }] =
        await app.$queryRawUnsafe<{ statement_timeout: string }[]>('SHOW statement_timeout');
      expect({ TimeZone, statement_timeout }).toEqual({
        TimeZone: 'UTC',
        statement_timeout: '12345ms',
      });
    } finally {
      await app.$disconnect();
    }
  });

  it('o boot NÃO depende do banco: com o banco inexistente, a aplicação sobe (o e2e cria o banco depois)', async () => {
    const original = process.env.DATABASE_URL;
    const inexistente = new URL(TEST_DATABASE_URL);
    inexistente.pathname = '/veyra_test_que_nao_existe';
    process.env.DATABASE_URL = inexistente.toString();
    const servico = new PrismaService({ get: () => undefined } as never);
    process.env.DATABASE_URL = original;
    try {
      await expect(servico.onModuleInit()).resolves.toBeUndefined();
    } finally {
      await servico.onModuleDestroy();
    }
  });
});

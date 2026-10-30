import { Client } from 'pg';
import { TEST_DATABASE_URL, assertIsTestDb } from '../../test/integration/db-url';
import { lerTrava } from './trava-de-manutencao';

/**
 * A leitura da trava de manutenção no Postgres de verdade (ADR-053, adendo 1).
 * O caminho do operador é `ALTER DATABASE … SET`, que vale para as sessões
 * NOVAS: o teste o faz no banco de teste e o devolve no fim (como o do fuso da
 * sessão). Nenhum código das suítes lê a trava; só o `main.ts`.
 */
describe('a trava de manutenção no banco (ADR-053, adendo 1)', () => {
  const banco = assertIsTestDb(TEST_DATABASE_URL);
  const comOpcao = (valor: string) => {
    const url = new URL(TEST_DATABASE_URL);
    url.searchParams.set('options', `-c veyra.manutencao=${valor}`);
    return url.toString();
  };

  it('sem a trava, desligada', async () => {
    await expect(lerTrava(TEST_DATABASE_URL)).resolves.toBe('desligada');
  });

  it.each([
    ['ligada', 'ligada'],
    ['ligado', 'ligada'],
    ['desligada', 'desligada'],
  ])('com veyra.manutencao=%s na sessão, %s', async (valor, esperado) => {
    await expect(lerTrava(comOpcao(valor))).resolves.toBe(esperado);
  });

  it('ligada pelo operador no BANCO (ALTER DATABASE), uma sessão nova a lê; desligada (RESET), não', async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`ALTER DATABASE "${banco}" SET veyra.manutencao = 'ligada'`);
      await expect(lerTrava(TEST_DATABASE_URL)).resolves.toBe('ligada');
      await admin.query(`ALTER DATABASE "${banco}" RESET veyra.manutencao`);
      await expect(lerTrava(TEST_DATABASE_URL)).resolves.toBe('desligada');
    } finally {
      // cada passo por si: uma falha não pode deixar a trava no banco de teste
      await admin.query(`ALTER DATABASE "${banco}" RESET veyra.manutencao`).catch(() => undefined);
      await admin.end();
    }
  });

  it('ligada no BANCO, nem a opção da sessão nem o papel a desligam (PGOPTIONS, ?options=, ALTER ROLE)', async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const papel = decodeURIComponent(new URL(TEST_DATABASE_URL).username);
    await admin.connect();
    try {
      await admin.query(`ALTER DATABASE "${banco}" SET veyra.manutencao = 'ligada'`);
      // a opção de partida da conexão vence o banco no valor da SESSÃO…
      await expect(lerTrava(comOpcao('desligada'))).resolves.toBe('ligada');
      // …e o papel também
      await admin.query(
        `ALTER ROLE "${papel}" IN DATABASE "${banco}" SET veyra.manutencao = 'desligada'`,
      );
      const sessao = new Client({ connectionString: TEST_DATABASE_URL });
      await sessao.connect();
      const efetivo = await sessao.query<{ v: string }>(
        `SELECT current_setting('veyra.manutencao', true) AS v`,
      );
      await sessao.end();
      expect(efetivo.rows[0].v).toBe('desligada'); // controle: na sessão, o papel venceu
      await expect(lerTrava(TEST_DATABASE_URL)).resolves.toBe('ligada');
    } finally {
      await admin
        .query(`ALTER ROLE "${papel}" IN DATABASE "${banco}" RESET veyra.manutencao`)
        .catch(() => undefined);
      await admin.query(`ALTER DATABASE "${banco}" RESET veyra.manutencao`).catch(() => undefined);
      await admin.end();
    }
  });

  it('com o banco inalcançável, a leitura FALHA dentro do prazo (a API não sobe)', async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.hostname = '127.0.0.1';
    url.port = '1';
    const inicio = Date.now();
    await expect(lerTrava(url.toString(), 2_000)).rejects.toThrow(/ECONNREFUSED|timeout/i);
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });
});

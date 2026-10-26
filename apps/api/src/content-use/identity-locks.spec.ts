import { CONFIG_PADRAO_DA_GUARDA } from './content-use.pools';
import { TravasDeIdentidade } from './identity-locks';
import { prazoDeTrava } from './restriction-locks';

/**
 * As fichas e os prazos das travas da identidade (ADR-052 item 3), sem banco:
 * o que vai ao SQL é conferido nos parâmetros que a coordenação recebe.
 */
describe('as travas da identidade de quem escreve (ADR-052 item 3)', () => {
  const config = { get: (k: string) => (k === 'ADDRESS_LOCK_KEY' ? 'k'.repeat(40) : undefined) };
  const travas = new TravasDeIdentidade(
    config as never,
    { porContato: async () => 0 } as never,
    CONFIG_PADRAO_DA_GUARDA,
  );
  const gravador = () => {
    const valores: unknown[] = [];
    const tx = {
      $executeRaw: jest.fn(async (sql: { values: unknown[] }) => {
        valores.push(...sql.values);
        return 0;
      }),
      $queryRaw: async () => [],
    };
    return { tx, valores };
  };

  it('nenhum parâmetro de trava leva os dígitos do telefone: o nível 0 e o endereço passam pelo HMAC', async () => {
    const { tx, valores } = gravador();
    await travas.paraIngestao(tx as never, 'ws-1', '87654321', Date.now() + 5_000);
    expect(JSON.stringify(valores)).not.toContain('87654321');
    // as duas fichas são HMACs diferentes: o nível 0 não coincide com o endereço
    expect(travas.nivelZero('ws-1', '87654321')).toMatch(/^[0-9a-f]{64}$/);
    expect(`address:${travas.nivelZero('ws-1', '87654321')}`).not.toBe(
      travas.endereco('ws-1', '87654321'),
    );
  });

  it('a ingestão pega os escritores em massa COMPARTILHADA, entre o workspace e o endereço (F4.1c-1)', async () => {
    const { tx, valores } = gravador();
    await travas.paraIngestao(tx as never, 'ws-1', '87654321', Date.now() + 5_000);
    const chaves = valores.filter(
      (v): v is string => typeof v === 'string' && v.startsWith('veyra.restriction.'),
    );
    expect(chaves.map((c) => c.split(':')[0])).toEqual([
      'veyra.restriction.ingest',
      'veyra.restriction.ws',
      'veyra.restriction.phones-bulk',
      'veyra.restriction.entity',
    ]);
  });

  it('a normalização: o prazo de ociosidade e o de trava ANTES do workspace e da trava de massa EXCLUSIVA (F4.1c-1)', async () => {
    const comandos: string[] = [];
    const tx = {
      $executeRaw: async (sql: { strings: readonly string[]; values: unknown[] }) => {
        const texto = sql.strings.join('?');
        const valor = String(sql.values[0]);
        if (texto.includes('idle_in_transaction_session_timeout')) comandos.push(`ocioso ${valor}`);
        else if (texto.includes('lock_timeout')) comandos.push(`prazo ${valor}`);
        else if (texto.includes('advisory_xact_lock_shared')) comandos.push(`C ${valor}`);
        else if (texto.includes('advisory_xact_lock')) comandos.push(`X ${valor}`);
        else comandos.push(texto);
        return 0;
      },
      $queryRaw: async () => [],
    };
    await travas.paraNormalizacao(tx as never, 'ws-1', 10_000, 60_000);
    expect(comandos).toEqual([
      'ocioso 60000ms',
      'prazo 10000ms',
      'C veyra.restriction.ws:ws-1',
      'X veyra.restriction.phones-bulk:ws-1',
    ]);
  });

  it('a importação: o prazo CURTO só para a trava de massa exclusiva; depois, o das mudanças (F4.1c-1)', async () => {
    const { tx, valores } = gravador();
    await travas.paraImportacao(tx as never, 'ws-1');
    expect(valores).toEqual([
      `${CONFIG_PADRAO_DA_GUARDA.importacaoTravaMs}ms`,
      'veyra.restriction.ws:ws-1',
      'veyra.restriction.phones-bulk:ws-1',
      `${CONFIG_PADRAO_DA_GUARDA.mudancaTravaMs}ms`,
    ]);
    expect(CONFIG_PADRAO_DA_GUARDA.importacaoTravaMs).toBeLessThan(
      CONFIG_PADRAO_DA_GUARDA.mudancaTravaMs,
    );
  });

  it('sem prazo no lote, nem a primeira trava é pedida: 503, e a Meta reentrega', async () => {
    const { tx } = gravador();
    await expect(
      travas.paraIngestao(tx as never, 'ws-1', '87654321', Date.now() - 1),
    ).rejects.toThrow(/sem prazo/);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('o prazo de cada trava é o que SOBRA da mensagem, e nunca passa do fim do lote', async () => {
    const { tx, valores } = gravador();
    await travas.paraIngestao(tx as never, 'ws-1', '87654321', Date.now() + 300);
    const prazos = valores
      .filter((v): v is string => typeof v === 'string' && /^\d+ms$/.test(v))
      .map((v) => Number(v.slice(0, -2)));
    // antes do nível 0, antes do workspace, dos escritores em massa e do
    // endereço (o resto DIVIDIDO entre as três), e o que sobra para as linhas:
    // o do lote (300 ms) manda
    expect(prazos).toHaveLength(3);
    for (const ms of prazos) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(300);
    }
    expect(prazos[1]).toBeLessThanOrEqual(100);
  });

  it('o prazo de trava nunca é 0: no Postgres, `lock_timeout = 0` espera para sempre', async () => {
    const { tx, valores } = gravador();
    await prazoDeTrava(tx as never, 0);
    await prazoDeTrava(tx as never, 0.4);
    expect(valores).toEqual(['1ms', '1ms']);
  });
});

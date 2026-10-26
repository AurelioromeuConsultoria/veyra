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
    // antes do nível 0, antes do workspace e do endereço (o resto DIVIDIDO entre
    // as duas), e o que sobra para as linhas: o do lote (300 ms) manda
    expect(prazos).toHaveLength(3);
    for (const ms of prazos) {
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(300);
    }
    expect(prazos[1]).toBeLessThanOrEqual(150);
  });

  it('o prazo de trava nunca é 0: no Postgres, `lock_timeout = 0` espera para sempre', async () => {
    const { tx, valores } = gravador();
    await prazoDeTrava(tx as never, 0);
    await prazoDeTrava(tx as never, 0.4);
    expect(valores).toEqual(['1ms', '1ms']);
  });
});

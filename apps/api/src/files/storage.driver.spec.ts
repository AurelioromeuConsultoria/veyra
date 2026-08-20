import { UnsafeKeyError, assertSafeKey } from './storage.driver';

const workspace = '11111111-1111-4111-8111-111111111111';
const file = '22222222-2222-4222-8222-222222222222';

describe('chave de storage (ADR-024)', () => {
  it('aceita o formato derivado no servidor', () => {
    expect(() => assertSafeKey(`${workspace}/${file}.png`)).not.toThrow();
    expect(() => assertSafeKey(`${workspace}/${file}`)).not.toThrow();
  });

  it('recusa travessia de caminho e chave fora do formato', () => {
    const chavesRuins = [
      `${workspace}/../${file}.png`,
      `../${workspace}/${file}.png`,
      '/etc/passwd',
      `${workspace}/${file}/../../../etc/passwd`,
      `${workspace}` + String.fromCharCode(92) + `${file}.png`,
      `outro-tenant/${file}.png`,
      `${workspace}/${file}.png .txt`,
      `${workspace}/${file}%2e%2e%2fescape.png`,
    ];
    for (const key of chavesRuins) {
      expect(() => assertSafeKey(key)).toThrow(UnsafeKeyError);
    }
  });
});

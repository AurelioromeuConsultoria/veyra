import { hostAllowed, providerAddress } from './meta.transport';

describe('allowlist de host do transporte da Meta', () => {
  it('aceita a Graph API e o CDN de mídia', () => {
    expect(hostAllowed('graph.facebook.com')).toBe(true);
    expect(hostAllowed('lookaside.fbsbx.com')).toBe(true);
    expect(hostAllowed('scontent.fbsbx.com')).toBe(true);
  });

  it('recusa qualquer outro host, inclusive parecidos', () => {
    for (const host of [
      'graph.facebook.com.atacante.test',
      'fbsbx.com.atacante.test',
      'evil.test',
      'localhost',
      '169.254.169.254',
      'graph-facebook.com',
    ]) {
      expect(hostAllowed(host)).toBe(false);
    }
  });
});

describe('destinatário no formato do provedor (ADR-039)', () => {
  it('remove o `+` e qualquer separador: é o `wa_id` que a Meta emitiu', () => {
    // guardamos `+E.164` para exibir; o provedor identifica por dígitos
    expect(providerAddress('+5511999998888')).toBe('5511999998888');
    expect(providerAddress('+55 (11) 99999-8888')).toBe('5511999998888');
  });

  it('número já em dígitos passa intacto', () => {
    expect(providerAddress('5511999998888')).toBe('5511999998888');
  });
});

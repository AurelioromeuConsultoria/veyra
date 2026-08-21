import { hostAllowed } from './meta.transport';

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

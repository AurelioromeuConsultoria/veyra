import { UnsafeUrlError, assertPublicIp, assertSafeWebhookUrl } from './safe-http';

/** Defesa SSRF (ajuste #6): classificação por ipaddr.js, nunca regex. */
describe('safe-http — defesa SSRF', () => {
  it('rejeita loopback, privado, link-local e metadados de nuvem', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.5',
      '192.168.1.1',
      '169.254.169.254', // metadata de cloud — o alvo clássico de SSRF
      '0.0.0.0',
      '::1',
      'fd00::1', // unique local IPv6
      'fe80::1', // link-local IPv6
      '100.64.0.1', // CGNAT
    ]) {
      expect(() => assertPublicIp(address)).toThrow(UnsafeUrlError);
    }
  });

  it('rejeita IPv4 MAPEADO em IPv6 (bypass clássico)', () => {
    expect(() => assertPublicIp('::ffff:127.0.0.1')).toThrow(UnsafeUrlError);
    expect(() => assertPublicIp('::ffff:169.254.169.254')).toThrow(UnsafeUrlError);
  });

  it('aceita endereços públicos', () => {
    expect(() => assertPublicIp('93.184.216.34')).not.toThrow();
    expect(() => assertPublicIp('2606:2800:220:1:248:1893:25c8:1946')).not.toThrow();
  });

  it('URL: exige https, sem credenciais, e barra host literal interno', () => {
    expect(() => assertSafeWebhookUrl('http://exemplo.com/hook')).toThrow(/https/);
    expect(() => assertSafeWebhookUrl('https://user:pass@exemplo.com/hook')).toThrow(/credenciais/);
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/hook')).toThrow(UnsafeUrlError);
    expect(() => assertSafeWebhookUrl('https://[::1]/hook')).toThrow(UnsafeUrlError);
    expect(() => assertSafeWebhookUrl('não-é-url')).toThrow(/inválida/);
    expect(() => assertSafeWebhookUrl('https://exemplo.com/hook')).not.toThrow();
  });
});

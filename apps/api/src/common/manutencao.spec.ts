import { passaPelaBarreira, ROTA_DA_SAUDE } from './manutencao';

/**
 * A decisão da barreira de manutenção (ADR-053): só `GET /api/health` pelo
 * SOCKET de loopback passa. Os cabeçalhos encaminhados nem entram na decisão.
 */
describe('a barreira de manutenção: quem passa', () => {
  const req = (method: string, path: string, remoteAddress: string | undefined) =>
    ({ method, path, socket: { remoteAddress } }) as Parameters<typeof passaPelaBarreira>[0];

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('a saúde pelo loopback (%s) passa', (ip) => {
    expect(passaPelaBarreira(req('GET', ROTA_DA_SAUDE, ip))).toBe(true);
  });

  it.each([
    ['GET', ROTA_DA_SAUDE, '172.18.0.5', 'a saúde pela rede'],
    ['GET', ROTA_DA_SAUDE, '10.0.1.7', 'a saúde pela rede do proxy'],
    ['GET', ROTA_DA_SAUDE, undefined, 'o socket sem endereço'],
    ['HEAD', ROTA_DA_SAUDE, '127.0.0.1', 'outro método'],
    ['POST', ROTA_DA_SAUDE, '127.0.0.1', 'outro método'],
    ['GET', '/api/health/', '127.0.0.1', 'outro caminho'],
    ['GET', '/api/auth/me', '127.0.0.1', 'outra rota pelo loopback'],
    ['POST', '/api/auth/login', '127.0.0.1', 'o login pelo loopback'],
  ])('%s %s de %s não passa (%s)', (method, path, ip, _motivo) => {
    expect(passaPelaBarreira(req(method, path, ip))).toBe(false);
  });

  it('o X-Forwarded-For não conta: só o endereço do socket', () => {
    const forjado = {
      method: 'GET',
      path: ROTA_DA_SAUDE,
      socket: { remoteAddress: '172.18.0.5' },
      headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
      ip: '127.0.0.1',
    } as unknown as Parameters<typeof passaPelaBarreira>[0];
    expect(passaPelaBarreira(forjado)).toBe(false);
  });
});

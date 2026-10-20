import { inspect } from 'node:util';
import { comSessaoEmUtc } from './prisma-adapter';

/** A fixação de UTC vai na URL, somada ao que ela já traga (ADR-049). */
describe('comSessaoEmUtc', () => {
  const UTC = 'options=-c%20TimeZone%3DUTC';

  it('URL sem parâmetros ganha a fixação, codificada com %20', () => {
    expect(comSessaoEmUtc('postgresql://u:s@localhost:5432/banco')).toBe(
      `postgresql://u:s@localhost:5432/banco?${UTC}`,
    );
  });

  it('os outros parâmetros seguem BYTE A BYTE (nada é recodificado)', () => {
    const url = 'postgresql://u:s@db:5432/banco?sslmode=require&sslrootcert=/etc/ca%20dir/ca.pem';
    expect(comSessaoEmUtc(url)).toBe(`${url}&${UTC}`);
  });

  it('aceita o formato de socket, que o `new URL()` recusaria', () => {
    expect(comSessaoEmUtc('postgresql://u:s@/banco?host=/var/run/postgresql')).toBe(
      `postgresql://u:s@/banco?host=/var/run/postgresql&${UTC}`,
    );
  });

  it('SOMA a um `options` que a URL já traga (com `+` ou `%20`), com a fixação por último', () => {
    const resultado = comSessaoEmUtc(
      'postgresql://u:s@db/banco?options=-c+TimeZone%3DAmerica%2FSao_Paulo%20-c%20statement_timeout%3D0&x=1',
    );
    expect(resultado).toBe(
      'postgresql://u:s@db/banco?x=1&options=' +
        encodeURIComponent('-c TimeZone=America/Sao_Paulo -c statement_timeout=0 -c TimeZone=UTC'),
    );
  });

  it('um fragmento continua no fim, fora da query', () => {
    expect(comSessaoEmUtc('postgresql://u:s@db/banco#ancora')).toBe(
      `postgresql://u:s@db/banco?${UTC}#ancora`,
    );
  });

  it('`options` mal codificado: erro sem a URL, sem a senha, sem `cause`', () => {
    const senha = 'SENHA/abc+def==';
    let erro: unknown;
    try {
      comSessaoEmUtc(`postgresql://veyra:${senha}@db:5432/veyra?options=%E0%A4%A`);
    } catch (capturado) {
      erro = capturado;
    }
    expect(erro).toBeInstanceOf(Error);
    expect(inspect(erro)).not.toContain(senha);
    expect(inspect(erro)).not.toContain('postgresql://');
    expect((erro as Error).cause).toBeUndefined();
  });

  it('senha com caracteres que quebrariam o `new URL()` não vira erro com a senha', () => {
    const url = 'postgresql://veyra:SENHA/abc+def==@db:5432/veyra';
    expect(() => comSessaoEmUtc(url)).not.toThrow();
    expect(comSessaoEmUtc(url)).toBe(`${url}?${UTC}`);
  });
});

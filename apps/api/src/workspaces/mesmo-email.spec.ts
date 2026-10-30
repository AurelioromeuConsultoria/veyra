import { mesmoEmail } from './mesmo-email';

/**
 * O critério único de "mesmo e-mail" (ADR-054 item 13): ignora maiúsculas e
 * minúsculas, e nada além. `%` e `_` são caracteres como os outros.
 */
describe('mesmoEmail', () => {
  it('ignora maiúsculas e minúsculas', () => {
    expect(mesmoEmail('Maria@Clinica.test', 'maria@clinica.test')).toBe(true);
  });

  it('trata `_` e `%` literalmente', () => {
    expect(mesmoEmail('a_b@x.test', 'axb@x.test')).toBe(false);
    expect(mesmoEmail('a%c@x.test', 'abbbc@x.test')).toBe(false);
    expect(mesmoEmail('A_B@x.test', 'a_b@x.test')).toBe(true);
  });

  it('não cria equivalências de pontos, aliases ou provedor', () => {
    expect(mesmoEmail('maria.silva@x.test', 'mariasilva@x.test')).toBe(false);
    expect(mesmoEmail('maria+clinica@x.test', 'maria@x.test')).toBe(false);
    expect(mesmoEmail('maria@x.test', ' maria@x.test')).toBe(false);
  });
});

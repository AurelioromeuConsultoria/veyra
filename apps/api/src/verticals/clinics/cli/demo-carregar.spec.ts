import { diaUtil, hojeNaUnidade, somarDias } from './demo-carregar.core';

/**
 * As datas da carga da demonstração (ADR-048 adendo 13): relativas ao dia da
 * carga, no calendário local da unidade, pulando o domingo (o expediente da
 * carga é de segunda a sábado). Datas fixas: o teste não depende do dia em que
 * roda.
 */
describe('as datas da carga da demonstração', () => {
  it('somarDias atravessa o mês e o ano, e volta no tempo', () => {
    expect(somarDias('2026-10-31', 1)).toBe('2026-11-01');
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDias('2026-11-01', -7)).toBe('2026-10-25');
  });

  it.each([
    // quinta → sexta, sábado
    ['2026-10-29', 1, '2026-10-30'],
    ['2026-10-29', 2, '2026-10-31'],
    // sexta → sábado, e o segundo pula o domingo
    ['2026-10-30', 1, '2026-10-31'],
    ['2026-10-30', 2, '2026-11-02'],
    // sábado → segunda: o domingo nunca é dia útil
    ['2026-10-31', 1, '2026-11-02'],
    // domingo → segunda
    ['2026-11-01', 1, '2026-11-02'],
  ])('o dia útil %s + %d é %s', (hoje, n, esperado) => {
    expect(diaUtil(hoje, n as number)).toBe(esperado);
  });

  it('o dia da carga é o do fuso da unidade, não o UTC', () => {
    // 02:30 UTC do dia 30 ainda é 23:30 do dia 29 em São Paulo
    const agora = new Date('2026-10-30T02:30:00.000Z');
    expect(hojeNaUnidade(agora, 'America/Sao_Paulo')).toBe('2026-10-29');
    expect(hojeNaUnidade(agora, 'UTC')).toBe('2026-10-30');
  });
});

import {
  centsToReaisInput,
  endInputToMinutes,
  hhmmToMinutes,
  minutesToEndInput,
  minutesToHHMM,
  reaisToCents,
} from './format';

describe('conversões do catálogo — centavos inteiros, nunca float', () => {
  it('reais em texto viram centavos exatos', () => {
    expect(reaisToCents('150')).toBe(15000);
    expect(reaisToCents('150,5')).toBe(15050);
    expect(reaisToCents('150,50')).toBe(15050);
    expect(reaisToCents('1.500,50')).toBe(150050);
    expect(reaisToCents('R$ 0,10')).toBe(10);
    // 0,29 em float daria 28,999…; aqui é aritmética de texto
    expect(reaisToCents('0,29')).toBe(29);
    expect(reaisToCents('')).toBeNull();
    for (const invalido of ['abc', '1,234', '1.50', '-5', '15.00,0']) {
      expect(reaisToCents(invalido)).toBeUndefined();
    }
  });

  it('centavos voltam ao campo de edição', () => {
    expect(centsToReaisInput(150050)).toBe('1.500,50');
    expect(centsToReaisInput(5)).toBe('0,05');
    expect(centsToReaisInput(null)).toBe('');
  });

  it('HH:MM ↔ minutos do dia, com 24:00 como fim do dia', () => {
    expect(hhmmToMinutes('08:30')).toBe(510);
    expect(hhmmToMinutes('24:00')).toBe(1440);
    expect(hhmmToMinutes('24:01')).toBeUndefined();
    expect(hhmmToMinutes('8:30')).toBeUndefined();
    expect(hhmmToMinutes('08:60')).toBeUndefined();
    expect(minutesToHHMM(510)).toBe('08:30');
    expect(minutesToHHMM(1440)).toBe('24:00');
  });

  it('fim do dia: o campo de hora mostra "00:00" e o valor é 1440 (24h)', () => {
    expect(endInputToMinutes('00:00')).toBe(1440);
    expect(endInputToMinutes('18:00')).toBe(1080);
    expect(minutesToEndInput(1440)).toBe('00:00');
    expect(minutesToEndInput(1080)).toBe('18:00');
  });
});

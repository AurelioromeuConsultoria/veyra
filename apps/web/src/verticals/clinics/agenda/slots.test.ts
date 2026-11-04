import { describe, expect, it } from 'vitest';
import { diaDaSemana, horariosLivres } from './slots';

const U = '0b9f1c2e-5d6a-4c3b-9e8f-1a2b3c4d5e02';

describe('horários livres — a mesma regra do servidor', () => {
  const comercial = [1, 2, 3, 4, 5].map((weekday) => ({
    unitId: U,
    weekday,
    startMinute: 480,
    endMinute: 720,
  }));

  it('dentro do expediente, em passos de 15 min, com o fim cabendo', () => {
    const opcoes = horariosLivres({
      data: '2030-11-04', // segunda
      timezone: 'America/Sao_Paulo',
      duracaoMin: 60,
      intervalos: comercial,
      ocupados: [],
    });
    expect(opcoes[0].hora).toBe('08:00');
    expect(opcoes.at(-1)!.hora).toBe('11:00'); // 11:00 + 60 = 12:00, o fim do intervalo
    expect(opcoes).toHaveLength(13);
    expect(diaDaSemana('2030-11-04')).toBe(1);
  });

  it('expediente fora da grade (08:07) começa a oferecer no próximo passo (08:15)', () => {
    const opcoes = horariosLivres({
      data: '2030-11-04',
      timezone: 'America/Sao_Paulo',
      duracaoMin: 30,
      intervalos: [{ weekday: 1, startMinute: 487, endMinute: 600 }],
      ocupados: [],
    });
    expect(opcoes[0].hora).toBe('08:15');
    expect(opcoes.every((o) => Number(o.hora.slice(3)) % 15 === 0)).toBe(true);
  });

  it('não oferece horário que sobrepõe um agendamento ativo', () => {
    const opcoes = horariosLivres({
      data: '2030-11-04',
      timezone: 'America/Sao_Paulo',
      duracaoMin: 60,
      intervalos: comercial,
      // 09:00–10:00 em São Paulo
      ocupados: [{ startsAt: '2030-11-04T12:00:00.000Z', endsAt: '2030-11-04T13:00:00.000Z' }],
    });
    const horas = opcoes.map((o) => o.hora);
    expect(horas).toContain('08:00'); // termina às 09:00 exatamente
    expect(horas).not.toContain('08:15');
    expect(horas).not.toContain('09:45');
    expect(horas).toContain('10:00');
  });

  it('mudança de horário: o pulo não aparece; a hora que se repete aparece duas vezes, com o deslocamento', () => {
    const madrugada = [{ unitId: U, weekday: 7, startMinute: 0, endMinute: 240 }];
    const pulo = horariosLivres({
      data: '2025-03-09',
      timezone: 'America/New_York',
      duracaoMin: 30,
      intervalos: madrugada,
      ocupados: [],
    }).map((o) => o.hora);
    expect(pulo).not.toContain('02:00');
    expect(pulo).not.toContain('02:30');
    // a LISTA COMPLETA, em ordem de INSTANTE: a hora repetida inteira de
    // -04:00 primeiro (01:00 a 01:45) e depois a de -05:00
    const repete = horariosLivres({
      data: '2025-11-02',
      timezone: 'America/New_York',
      duracaoMin: 30,
      intervalos: madrugada,
      ocupados: [],
    });
    expect(repete.map((o) => [o.valor, o.inicio.toISOString()])).toEqual([
      ['00:00|', '2025-11-02T04:00:00.000Z'],
      ['00:15|', '2025-11-02T04:15:00.000Z'],
      ['00:30|', '2025-11-02T04:30:00.000Z'],
      ['00:45|', '2025-11-02T04:45:00.000Z'],
      ['01:00|-04:00', '2025-11-02T05:00:00.000Z'],
      ['01:15|-04:00', '2025-11-02T05:15:00.000Z'],
      ['01:30|-04:00', '2025-11-02T05:30:00.000Z'],
      ['01:45|-04:00', '2025-11-02T05:45:00.000Z'],
      ['01:00|-05:00', '2025-11-02T06:00:00.000Z'],
      ['01:15|-05:00', '2025-11-02T06:15:00.000Z'],
      ['01:30|-05:00', '2025-11-02T06:30:00.000Z'],
      ['01:45|-05:00', '2025-11-02T06:45:00.000Z'],
      ['02:00|', '2025-11-02T07:00:00.000Z'],
      ['02:15|', '2025-11-02T07:15:00.000Z'],
      ['02:30|', '2025-11-02T07:30:00.000Z'],
      ['02:45|', '2025-11-02T07:45:00.000Z'],
      ['03:00|', '2025-11-02T08:00:00.000Z'],
      ['03:15|', '2025-11-02T08:15:00.000Z'],
      ['03:30|', '2025-11-02T08:30:00.000Z'],
    ]);
    expect(repete.filter((o) => o.hora === '01:30').map((o) => o.rotulo)).toEqual([
      '01:30 (antes da mudança de horário, -04:00)',
      '01:30 (depois da mudança de horário, -05:00)',
    ]);
  });

  it('intervalos de expediente fora de ordem: a lista sai em ordem de instante', () => {
    const opcoes = horariosLivres({
      data: '2030-11-04',
      timezone: 'America/Sao_Paulo',
      duracaoMin: 60,
      intervalos: [
        { weekday: 1, startMinute: 840, endMinute: 960 }, // 14:00–16:00
        { weekday: 1, startMinute: 480, endMinute: 600 }, // 08:00–10:00
      ],
      ocupados: [],
    });
    expect(opcoes.map((o) => o.hora)).toEqual([
      '08:00',
      '08:15',
      '08:30',
      '08:45',
      '09:00',
      '14:00',
      '14:15',
      '14:30',
      '14:45',
      '15:00',
    ]);
  });
});

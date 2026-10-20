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
      intervalos: [{ unitId: U, weekday: 1, startMinute: 487, endMinute: 600 }],
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
    const repete = horariosLivres({
      data: '2025-11-02',
      timezone: 'America/New_York',
      duracaoMin: 30,
      intervalos: madrugada,
      ocupados: [],
    }).filter((o) => o.hora === '01:30');
    expect(repete.map((o) => [o.utcOffset, o.rotulo])).toEqual([
      ['-04:00', '01:30 (antes da mudança de horário, -04:00)'],
      ['-05:00', '01:30 (depois da mudança de horário, -05:00)'],
    ]);
  });
});

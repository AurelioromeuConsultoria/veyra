import { describe, expect, it } from 'vitest';
import { faixaDoDia, foraDoExpediente, intervaloDoAgendamento, raias } from './grade';

describe('grade da agenda', () => {
  it('a faixa vai do primeiro ao último horário, em horas cheias; vazia, o horário comercial', () => {
    expect(
      faixaDoDia([
        { inicio: 8 * 60 + 30, fim: 12 * 60 },
        { inicio: 13 * 60, fim: 17 * 60 + 15 },
      ]),
    ).toEqual({ inicio: 480, fim: 1080 });
    expect(faixaDoDia([])).toEqual({ inicio: 480, fim: 1080 });
    expect(faixaDoDia([{ inicio: 0, fim: 1440 }])).toEqual({ inicio: 0, fim: 1440 });
    // agendamento sem duração útil ainda ganha uma hora de grade
    expect(faixaDoDia([{ inicio: 600, fim: 600 }])).toEqual({ inicio: 600, fim: 660 });
  });

  it('o bloco começa na hora local e dura o que os instantes dizem (a mudança de horário não engana)', () => {
    expect(
      intervaloDoAgendamento({
        localStart: '09:00',
        startsAt: '2030-11-04T12:00:00.000Z',
        endsAt: '2030-11-04T12:45:00.000Z',
      }),
    ).toEqual({ inicio: 540, fim: 585 });
    // o fim nunca passa da meia-noite
    expect(
      intervaloDoAgendamento({
        localStart: '23:30',
        startsAt: '2030-11-04T02:30:00.000Z',
        endsAt: '2030-11-04T03:30:00.000Z',
      }),
    ).toEqual({ inicio: 1410, fim: 1440 });
  });

  it('fora do expediente: os trechos da faixa que sobram', () => {
    expect(
      foraDoExpediente({ inicio: 480, fim: 1080 }, [
        { inicio: 780, fim: 1020 },
        { inicio: 540, fim: 720 },
      ]),
    ).toEqual([
      { inicio: 480, fim: 540 },
      { inicio: 720, fim: 780 },
      { inicio: 1020, fim: 1080 },
    ]);
    expect(foraDoExpediente({ inicio: 480, fim: 720 }, [])).toEqual([{ inicio: 480, fim: 720 }]);
    expect(foraDoExpediente({ inicio: 0, fim: 1440 }, [{ inicio: 0, fim: 1440 }])).toEqual([]);
  });

  it('blocos que se sobrepõem dividem a largura; os que só se encostam não', () => {
    const r = raias([
      { id: 'a', inicio: 540, fim: 600 },
      { id: 'b', inicio: 540, fim: 600 },
      { id: 'c', inicio: 570, fim: 630 },
      { id: 'd', inicio: 630, fim: 660 },
    ]);
    expect(r.get('a')).toEqual({ raia: 0, raias: 3 });
    expect(r.get('b')).toEqual({ raia: 1, raias: 3 });
    expect(r.get('c')).toEqual({ raia: 2, raias: 3 });
    // começa onde o grupo termina: largura inteira
    expect(r.get('d')).toEqual({ raia: 0, raias: 1 });
  });
});

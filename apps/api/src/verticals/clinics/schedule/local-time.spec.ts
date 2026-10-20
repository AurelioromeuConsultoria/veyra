import { horaLocal, resolverHoraLocal, somarDias } from '@veyra/contracts/verticals/clinics';

/**
 * Fusos FICTÍCIOS para o produto (a clínica é no Brasil): Nova York tem
 * mudança de horário todo ano, e a regra não pode depender de o Brasil não ter
 * mais horário de verão (ADR-048 adendo 2, item 4). Em 2026, NY adianta em
 * 8/mar às 02:00 (vira 03:00) e atrasa em 1/nov às 02:00 (volta a 01:00).
 */
describe('hora local da unidade ↔ instante', () => {
  const NY = 'America/New_York';

  it('hora comum: um instante só, e a leitura volta igual', () => {
    const r = resolverHoraLocal('2026-10-20', '09:00', 'America/Sao_Paulo');
    expect(r).toEqual({ kind: 'ok', instante: new Date('2026-10-20T12:00:00Z') });
    expect(horaLocal(new Date('2026-10-20T12:00:00Z'), 'America/Sao_Paulo')).toEqual({
      data: '2026-10-20',
      hora: '09:00',
      minutoDoDia: 540,
      diaDaSemana: 2,
    });
  });

  it('o PULO da primavera: 02:30 não existe em NY', () => {
    expect(resolverHoraLocal('2026-03-08', '02:30', NY)).toEqual({ kind: 'inexistente' });
    // nem com deslocamento: nenhum instante tem essa leitura, e o motivo é esse
    expect(resolverHoraLocal('2026-03-08', '02:30', NY, '-05:00')).toEqual({ kind: 'inexistente' });
  });

  it('a hora que SE REPETE no outono: ambígua, com os dois deslocamentos na ordem do tempo', () => {
    expect(resolverHoraLocal('2026-11-01', '01:30', NY)).toEqual({
      kind: 'ambigua',
      deslocamentos: ['-04:00', '-05:00'],
    });
    expect(resolverHoraLocal('2026-11-01', '01:30', NY, '-04:00')).toEqual({
      kind: 'ok',
      instante: new Date('2026-11-01T05:30:00Z'),
    });
    expect(resolverHoraLocal('2026-11-01', '01:30', NY, '-05:00')).toEqual({
      kind: 'ok',
      instante: new Date('2026-11-01T06:30:00Z'),
    });
    expect(resolverHoraLocal('2026-11-01', '01:30', NY, '-03:00')).toEqual({
      kind: 'deslocamento_invalido',
    });
  });

  it('deslocamento informado que bate com a hora comum é aceito; o que não bate, não', () => {
    expect(resolverHoraLocal('2026-07-01', '10:00', NY, '-04:00')).toEqual({
      kind: 'ok',
      instante: new Date('2026-07-01T14:00:00Z'),
    });
    expect(resolverHoraLocal('2026-07-01', '10:00', NY, '-05:00')).toEqual({
      kind: 'deslocamento_invalido',
    });
  });

  it('dia SEM meia-noite (Brasil, 2018: o horário de verão começava às 00:00)', () => {
    expect(resolverHoraLocal('2018-11-04', '00:00', 'America/Sao_Paulo')).toEqual({
      kind: 'inexistente',
    });
    expect(resolverHoraLocal('2018-11-04', '01:00', 'America/Sao_Paulo')).toEqual({
      kind: 'ok',
      instante: new Date('2018-11-04T03:00:00Z'),
    });
  });

  it('a leitura atravessando a mudança: 01:30 + 60 min no domingo da primavera é 03:30', () => {
    const inicio = (resolverHoraLocal('2026-03-08', '01:30', NY) as { instante: Date }).instante;
    const fim = new Date(inicio.getTime() + 60 * 60_000);
    expect(horaLocal(fim, NY)).toMatchObject({
      data: '2026-03-08',
      hora: '03:30',
      minutoDoDia: 210,
    });
  });

  it('somarDias é calendário puro', () => {
    expect(somarDias('2026-02-28', 1)).toBe('2026-03-01');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});

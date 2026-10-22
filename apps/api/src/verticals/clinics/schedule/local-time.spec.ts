import {
  horaLocal,
  inicioDoDiaLocal,
  resolverHoraLocal,
  somarDias,
} from '@veyra/contracts/verticals/clinics';

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

  describe('o INÍCIO do dia local: o primeiro instante cuja data local é aquele dia (aprovação da F3.3)', () => {
    const SP = 'America/Sao_Paulo';
    const horas = (de: string, ate: string, fuso: string) =>
      (inicioDoDiaLocal(ate, fuso).getTime() - inicioDoDiaLocal(de, fuso).getTime()) / 3_600_000;

    it('dia comum: a meia-noite, e o dia tem 24 horas', () => {
      expect(inicioDoDiaLocal('2026-10-20', SP)).toEqual(new Date('2026-10-20T03:00:00Z'));
      expect(horas('2026-10-20', '2026-10-21', SP)).toBe(24);
      expect(inicioDoDiaLocal('2026-03-08', NY)).toEqual(new Date('2026-03-08T05:00:00Z'));
      // o pulo e a volta de NY são às 02:00: os dias têm 23 e 25 horas
      expect(horas('2026-03-08', '2026-03-09', NY)).toBe(23);
      expect(horas('2026-11-01', '2026-11-02', NY)).toBe(25);
    });

    it('a meia-noite que cai no PULO: o dia começa quando o pulo termina (São Paulo 2018, Santiago 2025)', () => {
      expect(resolverHoraLocal('2018-11-04', '00:00', SP)).toEqual({ kind: 'inexistente' });
      const inicio = inicioDoDiaLocal('2018-11-04', SP);
      expect(inicio).toEqual(new Date('2018-11-04T03:00:00Z'));
      expect(horaLocal(inicio, SP)).toMatchObject({ data: '2018-11-04', hora: '01:00' });
      expect(horaLocal(new Date(inicio.getTime() - 1), SP).data).toBe('2018-11-03');
      expect(horas('2018-11-04', '2018-11-05', SP)).toBe(23);
      const santiago = inicioDoDiaLocal('2025-09-07', 'America/Santiago');
      expect(horaLocal(santiago, 'America/Santiago')).toMatchObject({
        data: '2025-09-07',
        hora: '01:00',
      });
      expect(horaLocal(new Date(santiago.getTime() - 1), 'America/Santiago').data).toBe(
        '2025-09-06',
      );
    });

    it('a meia-noite REPETIDA: a primeira ocorrência (Havana, 2025-11-02)', () => {
      const HAVANA = 'America/Havana';
      expect(resolverHoraLocal('2025-11-02', '00:00', HAVANA)).toMatchObject({ kind: 'ambigua' });
      const inicio = inicioDoDiaLocal('2025-11-02', HAVANA);
      expect(inicio).toEqual(new Date('2025-11-02T04:00:00Z'));
      expect(horaLocal(new Date(inicio.getTime() - 1), HAVANA).data).toBe('2025-11-01');
      expect(horas('2025-11-02', '2025-11-03', HAVANA)).toBe(25);
    });

    it('a meia-noite que acontece, VOLTA para o dia anterior e acontece de novo: o dia começa na primeira entrada (Goose Bay, 2000-10-29)', () => {
      const GOOSE = 'America/Goose_Bay';
      const inicio = inicioDoDiaLocal('2000-10-29', GOOSE);
      expect(inicio).toEqual(new Date('2000-10-29T03:00:00Z'));
      expect(horaLocal(new Date(inicio.getTime() - 1), GOOSE).data).toBe('2000-10-28');
      // às 00:01 o relógio volta para 23:01 do dia 28, e a meia-noite volta às 04:00Z
      expect(horaLocal(new Date('2000-10-29T03:30:00Z'), GOOSE).data).toBe('2000-10-28');
      expect(horaLocal(new Date('2000-10-29T04:00:00Z'), GOOSE)).toMatchObject({
        data: '2000-10-29',
        hora: '00:00',
      });
    });

    it('o DIA que não existe: o início é o do dia seguinte que existe (Samoa pulou 2011-12-30)', () => {
      const APIA = 'Pacific/Apia';
      expect(inicioDoDiaLocal('2011-12-29', APIA)).toEqual(new Date('2011-12-29T10:00:00Z'));
      expect(inicioDoDiaLocal('2011-12-30', APIA)).toEqual(inicioDoDiaLocal('2011-12-31', APIA));
      expect(horaLocal(inicioDoDiaLocal('2011-12-30', APIA), APIA)).toMatchObject({
        data: '2011-12-31',
        hora: '00:00',
      });
      expect(horas('2011-12-29', '2011-12-31', APIA)).toBe(24);
      expect(horas('2011-12-30', '2011-12-31', APIA)).toBe(0);
    });

    it('o dia de 25 horas, com a meia-noite seguinte única (São Paulo, 2019-02-16)', () => {
      expect(inicioDoDiaLocal('2019-02-16', SP)).toEqual(new Date('2019-02-16T02:00:00Z'));
      expect(inicioDoDiaLocal('2019-02-17', SP)).toEqual(new Date('2019-02-17T03:00:00Z'));
      expect(horas('2019-02-16', '2019-02-17', SP)).toBe(25);
    });
  });
});

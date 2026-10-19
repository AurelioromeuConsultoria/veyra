import { postgresConstraintName, postgresErrorCode } from './prisma-exception.filter';

describe('postgresErrorCode — código original do Postgres por trás do P2039', () => {
  it('lê o código da causa do driver adapter (forma real, capturada no spike da F1.c)', () => {
    const p2039 = {
      code: 'P2039',
      meta: {
        modelName: 'Reserva',
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23P01',
            originalMessage:
              'conflicting key value violates exclusion constraint "Reserva_no_overlap"',
            kind: 'postgres',
            detail: 'Key (...)=(id-sensivel) conflicts with existing key (...)',
          },
        },
      },
    };
    expect(postgresErrorCode(p2039)).toBe('23P01');
    // o nome da constraint, para o log — nunca o `detail`
    expect(postgresConstraintName(p2039)).toBe('Reserva_no_overlap');
  });

  it('erro sem a causa, sem meta, nulo ou com código não textual: indefinido', () => {
    expect(postgresErrorCode({ code: 'P2002', meta: { target: ['x'] } })).toBeUndefined();
    expect(postgresErrorCode(new Error('x'))).toBeUndefined();
    expect(postgresErrorCode(null)).toBeUndefined();
    expect(
      postgresErrorCode({ meta: { driverAdapterError: { cause: { originalCode: 23 } } } }),
    ).toBeUndefined();
  });
});

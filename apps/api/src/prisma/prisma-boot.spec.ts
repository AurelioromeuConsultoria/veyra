import { Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Boot e o fuso da sessão (ADR-049): banco alcançável FORA de UTC recusa
 * subir; banco que não responde NÃO derruba a subida (o e2e sobe a API antes
 * de criar o banco) e o aviso não carrega a URL.
 */
describe('PrismaService no boot — fuso da sessão', () => {
  const SENHA = 'segredo-de-teste';
  const criar = () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = `postgresql://veyra:${SENHA}@localhost:1/inexistente`;
    try {
      return new PrismaService({ get: () => undefined } as never);
    } finally {
      process.env.DATABASE_URL = original;
    }
  };
  afterEach(() => jest.restoreAllMocks());

  it('banco alcançável FORA de UTC: recusa subir', async () => {
    const servico = criar();
    jest.spyOn(servico.raw, '$connect').mockResolvedValue(undefined);
    jest
      .spyOn(servico.raw, '$queryRawUnsafe')
      .mockResolvedValue([{ TimeZone: 'America/Sao_Paulo' }] as never);
    await expect(servico.onModuleInit()).rejects.toThrow(/America\/Sao_Paulo.*não em UTC/);
  });

  it('banco em UTC: sobe', async () => {
    const servico = criar();
    jest.spyOn(servico.raw, '$connect').mockResolvedValue(undefined);
    jest.spyOn(servico.raw, '$queryRawUnsafe').mockResolvedValue([{ TimeZone: 'UTC' }] as never);
    await expect(servico.onModuleInit()).resolves.toBeUndefined();
  });

  it('banco que não responde: sobe, e o aviso traz o código, nunca a URL', async () => {
    const servico = criar();
    jest.spyOn(servico.raw, '$connect').mockResolvedValue(undefined);
    const falha = Object.assign(new Error(`falhou em postgresql://veyra:${SENHA}@localhost:1`), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '3D000' } } },
    });
    jest.spyOn(servico.raw, '$queryRawUnsafe').mockRejectedValue(falha);
    const aviso = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await expect(servico.onModuleInit()).resolves.toBeUndefined();
    const texto = aviso.mock.calls.map((chamada) => String(chamada[0])).join('\n');
    expect(texto).toContain('3D000');
    expect(texto).not.toContain(SENHA);
    expect(texto).not.toContain('postgresql://');
  });
});

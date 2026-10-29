import type { ConfigService } from '@nestjs/config';
import { JobsService } from './jobs.service';

/**
 * A manutenção desliga os jobs QUALQUER que seja o DISABLE_JOBS (ADR-053). O
 * `pg-boss` da unidade é o stub que FALHA ao ser instanciado: subir o worker
 * vira erro, e não subir vira silêncio.
 */
describe('os jobs na manutenção', () => {
  const servico = (env: Record<string, unknown>) =>
    // só a configuração importa aqui: as outras dependências não são tocadas
    new (JobsService as unknown as new (...deps: unknown[]) => JobsService)(
      { get: (chave: string) => env[chave] } as unknown as ConfigService,
      ...Array<unknown>(11).fill(null),
    );

  it('com MAINTENANCE_MODE, não sobe o worker nem com DISABLE_JOBS=false fora de teste', async () => {
    await expect(
      servico({
        MAINTENANCE_MODE: true,
        DISABLE_JOBS: false,
        NODE_ENV: 'production',
      }).onModuleInit(),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a chave ausente', undefined],
    ['a string "false" sem validação', 'false'],
  ])('fail-closed: %s conta como manutenção', async (_caso, valor) => {
    await expect(
      servico({
        MAINTENANCE_MODE: valor,
        DISABLE_JOBS: false,
        NODE_ENV: 'production',
      }).onModuleInit(),
    ).resolves.toBeUndefined();
  });

  it('sem a manutenção, o mesmo ambiente sobe o worker (o stub falha ao ser instanciado)', async () => {
    await expect(
      servico({
        MAINTENANCE_MODE: false,
        DISABLE_JOBS: false,
        NODE_ENV: 'production',
      }).onModuleInit(),
    ).rejects.toThrow(/pg-boss não deve ser instanciado/);
  });
});

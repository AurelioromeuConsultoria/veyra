import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { PermissionsService } from '../../../auth/permissions.service';
import type { AuthContext } from '../../../common/decorators';
import { ClinicsPackageCorrectionReplayGuard } from './clinics-package-correction-replay.guard';
import type { ClinicsPackageCorrectionsService } from './clinics-package-corrections.service';

/**
 * A guarda do replay da correção (ADR-059, ajuste 2): na integração, a guarda
 * da ROTA recusa primeiro quem perdeu a permissão. Aqui, as decisões da guarda
 * em si, para que ela valha mesmo se a rota mudar.
 */
describe('ClinicsPackageCorrectionReplayGuard', () => {
  const auth = { workspaceId: 'w', membershipId: 'm' } as AuthContext;
  const pedido = { auth } as unknown as Request & { auth?: AuthContext };
  const guardado = { status: 201, body: { id: 'c1', revision: 1 } };

  const guarda = (chaves: string[], existe = true, falha = false) =>
    new ClinicsPackageCorrectionReplayGuard(
      {
        has: async (_a: AuthContext, k: string) => {
          if (falha) throw new Error('banco fora');
          return chaves.includes(k);
        },
      } as unknown as PermissionsService,
      { exists: async () => existe } as unknown as ClinicsPackageCorrectionsService,
    );

  it('devolve a correção a quem tem as duas permissões AGORA e a correção existe', async () => {
    expect(
      await guarda(['clinics:care:write', 'clinics:care:read']).verdict(pedido, guardado),
    ).toBe('replay');
  });

  it.each([[['clinics:care:write']], [['clinics:care:read']], [[]]])(
    'sem uma das permissões (%j): recusa com 403, sem o corpo',
    async (chaves) => {
      const v = await guarda(chaves).verdict(pedido, guardado);
      expect(v).toEqual({ refuse: expect.any(ForbiddenException) });
    },
  );

  it('a correção guardada não é deste workspace, ou o corpo não tem id: 404', async () => {
    const todas = ['clinics:care:write', 'clinics:care:read'];
    expect(await guarda(todas, false).verdict(pedido, guardado)).toEqual({
      refuse: expect.any(NotFoundException),
    });
    expect(await guarda(todas).verdict(pedido, { status: 201, body: {} })).toEqual({
      refuse: expect.any(NotFoundException),
    });
  });

  it('sem sessão: 403; falha ao ler: indisponível (503, nada apagado)', async () => {
    const semSessao = {} as unknown as Request & { auth?: AuthContext };
    expect(await guarda([]).verdict(semSessao, guardado)).toEqual({
      refuse: expect.any(ForbiddenException),
    });
    expect(await guarda([], true, true).verdict(pedido, guardado)).toBe('unavailable');
  });
});

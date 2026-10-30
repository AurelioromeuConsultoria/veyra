import { AsyncLocalStorage } from 'node:async_hooks';
import { ClsService } from 'nestjs-cls';
import { ClinicsExperienceAvailability } from './clinics-experience';

/**
 * A porta da experiência `clinics` avalia o workspace PEDIDO num contexto
 * próprio (revisão de segurança da E-1 do ADR-055): nada da identidade nem do
 * workspace de quem chama entra nele, e o contexto de quem chama fica como
 * estava — com a resposta e com a falha.
 */
function montar(responder: (workspaceId: unknown) => Promise<{ status: string } | null>) {
  const cls = new ClsService(new AsyncLocalStorage());
  const vistos: Record<string, unknown>[] = [];
  const prisma = {
    db: {
      clinicsSettings: {
        findFirst: async () => {
          const workspaceId = cls.get('workspaceId');
          vistos.push({
            workspaceId,
            userId: cls.get('userId'),
            membershipId: cls.get('membershipId'),
            roleId: cls.get('roleId'),
          });
          return responder(workspaceId);
        },
      },
    },
  };
  return { cls, vistos, porta: new ClinicsExperienceAvailability(prisma as never, cls) };
}

/** o contexto de uma requisição no workspace A, com a identidade dela */
async function noContextoDeA<T>(cls: ClsService, fn: () => Promise<T>): Promise<T> {
  return cls.run(async () => {
    cls.set('workspaceId', 'w-a');
    cls.set('userId', 'u-a');
    cls.set('membershipId', 'm-a');
    cls.set('roleId', 'r-a');
    return fn();
  });
}
const contextoDeA = (cls: ClsService) => ({
  workspaceId: cls.get('workspaceId'),
  userId: cls.get('userId'),
  membershipId: cls.get('membershipId'),
  roleId: cls.get('roleId'),
});
const A = { workspaceId: 'w-a', userId: 'u-a', membershipId: 'm-a', roleId: 'r-a' };
const SO_B = { workspaceId: 'w-b', userId: undefined, membershipId: undefined, roleId: undefined };

describe('ClinicsExperienceAvailability — o contexto da porta', () => {
  it('pedida de dentro do contexto de A sobre B: vê só B, e A fica intacto', async () => {
    const { cls, vistos, porta } = montar(async (w) => (w === 'w-a' ? { status: 'active' } : null));
    await noContextoDeA(cls, async () => {
      expect(await porta.isAvailable('w-b')).toBe(false);
      expect(contextoDeA(cls)).toEqual(A);
    });
    expect(vistos).toEqual([SO_B]);
  });

  it('a falha da porta também não herda nada nem mexe no contexto de quem chama', async () => {
    const { cls, vistos, porta } = montar(async () => {
      throw new Error('banco fora');
    });
    await noContextoDeA(cls, async () => {
      await expect(porta.isAvailable('w-b')).rejects.toThrow('banco fora');
      expect(contextoDeA(cls)).toEqual(A);
    });
    expect(vistos).toEqual([SO_B]);
  });

  it('fora de qualquer contexto (login, refresh, CLI), avalia o workspace pedido', async () => {
    const { vistos, porta } = montar(async (w) => (w === 'w-b' ? { status: 'active' } : null));
    expect(await porta.isAvailable('w-b')).toBe(true);
    expect(vistos).toEqual([SO_B]);
  });
});

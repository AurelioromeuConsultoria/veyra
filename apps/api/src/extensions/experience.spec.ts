import { ExperienceService, type ExperienceAvailabilityProvider } from './experience';
import { composeRegistry } from './registry';

/**
 * A fachada das experiências (ADR-055 adendo 1, item 3): falha fechada, e o
 * boot recusa a composição sem a porta de cada experiência de extensão.
 */
const comTeste = (selecionavel = true) =>
  composeRegistry([{ name: 'teste', experience: { selectable: selecionavel } }]);
const porta = (isAvailable: () => Promise<boolean>): ExperienceAvailabilityProvider => ({
  experience: 'teste',
  isAvailable,
});

describe('ExperienceService', () => {
  it('a do Core está pronta; a chave não declarada é desconhecida', async () => {
    const servico = new ExperienceService(comTeste(), [porta(async () => true)]);
    expect(await servico.status('w1', 'crm')).toBe('ready');
    expect(await servico.status('w1', 'outra')).toBe('unknown');
  });

  it('a da extensão segue a porta: confirma → pronta; nega, falha ou não responde → indisponível', async () => {
    expect(
      await new ExperienceService(comTeste(), [porta(async () => true)]).status('w1', 'teste'),
    ).toBe('ready');
    expect(
      await new ExperienceService(comTeste(), [porta(async () => false)]).status('w1', 'teste'),
    ).toBe('unavailable');
    const falha = porta(async () => {
      throw new Error('banco fora');
    });
    expect(await new ExperienceService(comTeste(), [falha]).status('w1', 'teste')).toBe(
      'unavailable',
    );
    jest.useFakeTimers();
    try {
      const pendurada = new ExperienceService(comTeste(), [
        porta(() => new Promise(() => undefined)),
      ]);
      const status = pendurada.status('w1', 'teste');
      await jest.advanceTimersByTimeAsync(2_000);
      expect(await status).toBe('unavailable');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a porta responde pelo workspace pedido', async () => {
    const vistos: string[] = [];
    const servico = new ExperienceService(comTeste(), [
      { experience: 'teste', isAvailable: async (w) => (vistos.push(w), true) },
    ]);
    await servico.status('w-pedido', 'teste');
    expect(vistos).toEqual(['w-pedido']);
  });

  it('o boot recusa a experiência de extensão sem porta, a porta sem experiência e a porta repetida', () => {
    expect(() => new ExperienceService(comTeste(), [])).toThrow(
      /sem porta de disponibilidade: teste/,
    );
    expect(
      () =>
        new ExperienceService(comTeste(), [
          porta(async () => true),
          { experience: 'outra', isAvailable: async () => true },
        ]),
    ).toThrow(/sem experiência de extensão: outra/);
    expect(
      () =>
        new ExperienceService(comTeste(), [{ experience: 'crm', isAvailable: async () => true }]),
    ).toThrow(/sem experiência de extensão: crm/);
    expect(
      () => new ExperienceService(comTeste(), [porta(async () => true), porta(async () => true)]),
    ).toThrow(/repetida: teste/);
  });

  it('declara o que a composição declarou, com o selecionável', () => {
    const servico = new ExperienceService(comTeste(false), [porta(async () => true)]);
    expect(servico.declared('teste')).toEqual({
      key: 'teste',
      extension: 'teste',
      selectable: false,
    });
    expect(servico.declared('crm')?.selectable).toBe(true);
    expect(servico.declared('nada')).toBeUndefined();
  });
});

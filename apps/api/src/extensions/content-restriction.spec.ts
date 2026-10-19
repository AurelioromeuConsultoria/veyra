import { ContentRestrictionService, type ContentRestrictionProvider } from './content-restriction';

const WS = '6f1c2a5e-0b8e-4c1f-9a3d-2b7e8f9a0c1d';

const provider = (
  answer: (subjects: readonly (string | null)[]) => unknown,
): ContentRestrictionProvider => ({
  restricted: async (_ws, _consumer, subjects) => answer(subjects) as readonly boolean[],
});

describe('ContentRestrictionService — fachada fail-closed do E6 (ADR-047)', () => {
  it('sem porta composta nada é restrito (Core puro, sem regressão)', async () => {
    const service = new ContentRestrictionService([]);
    expect(await service.evaluate(WS, 'ai', ['a', null])).toEqual([false, false]);
  });

  it('respeita a resposta bem-formada da porta, sujeito a sujeito', async () => {
    const service = new ContentRestrictionService([provider((s) => s.map((x) => x === 'b'))]);
    expect(await service.evaluate(WS, 'ai', ['a', 'b'])).toEqual([false, true]);
  });

  it('várias portas: basta UMA restringir', async () => {
    const service = new ContentRestrictionService([
      provider((s) => s.map(() => false)),
      provider((s) => s.map((x) => x === null)),
    ]);
    expect(await service.evaluate(WS, 'webhook', ['a', null])).toEqual([false, true]);
  });

  it.each([
    ['exceção da porta', () => Promise.reject(new Error('fora do ar'))],
    ['tamanho diferente', () => [false]],
    ['valor que não é booleano', () => ['nao', 'nao']],
    ['resposta que não é lista', () => ({ a: false })],
  ])('%s vira RESTRITO para todos', async (_label, answer) => {
    const service = new ContentRestrictionService([
      { restricted: async () => (await answer()) as readonly boolean[] },
    ]);
    expect(await service.evaluate(WS, 'ai', ['a', 'b'])).toEqual([true, true]);
  });

  it('workspace inválido vira restrito (com porta composta)', async () => {
    const service = new ContentRestrictionService([provider((s) => s.map(() => false))]);
    expect(await service.evaluate('nao-e-uuid', 'ai', ['a'])).toEqual([true]);
  });

  it('anyRestricted sem sujeito é erro de quem chama — e erro aqui é "restrito"', async () => {
    const service = new ContentRestrictionService([]);
    expect(await service.anyRestricted(WS, 'ai', [])).toBe(true);
  });
});

import { VERTICAL_ROUTES } from './composition';
import { NAV_GROUPS } from './lib/nav';

/**
 * Rotas de vertical (ADR-047 E5, adendo 4) moram no PRÓPRIO prefixo e nunca
 * coincidem com uma seção do Core: um vertical não pode sombrear o Core.
 */
describe('raiz de composição do web', () => {
  const doCore = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to)).filter(
    (to) => to !== '/',
  );

  it('toda rota de vertical vive sob um prefixo próprio e não colide com o Core', () => {
    expect(VERTICAL_ROUTES.length).toBeGreaterThan(0);
    for (const { path } of VERTICAL_ROUTES) {
      expect(path).toMatch(/^\/[a-z]+\/[a-z0-9/-]+$/);
      for (const core of doCore) {
        expect(path === core || path.startsWith(`${core}/`)).toBe(false);
        expect(
          core.startsWith(`/${path.split('/')[1]}/`) || core === `/${path.split('/')[1]}`,
        ).toBe(false);
      }
    }
  });
});

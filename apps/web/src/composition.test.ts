import { EXPERIENCIAS_DE_EXTENSAO } from './composition';
import { ROTAS_DO_CORE } from './experiences/core-routes';
import { crmExperience } from './experiences/crm';

/**
 * A raiz de composição do web (ADR-047 E5; ADR-055 adendo 2). Cada extensão
 * entrega o manifesto da SUA experiência; o Core não soma nada ao menu dele.
 */
describe('raiz de composição do web', () => {
  const doCore = Object.values(ROTAS_DO_CORE);
  const caminhosDoCore = doCore.map((r) => r.path).filter((p) => p !== '/');

  it('a chave `crm` é só do Core, e cada extensão tem a sua', () => {
    const chaves = EXPERIENCIAS_DE_EXTENSAO.map((m) => m.key);
    expect(chaves.length).toBeGreaterThan(0);
    expect(chaves).not.toContain('crm');
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it('as rotas PRÓPRIAS de uma extensão vivem sob um prefixo dela e não colidem com o Core', () => {
    for (const manifesto of EXPERIENCIAS_DE_EXTENSAO) {
      const proprias = manifesto.rotas.filter((r) => !doCore.includes(r as never));
      expect(proprias.length).toBeGreaterThan(0);
      for (const { path } of proprias) {
        expect(path).toMatch(/^\/[a-z]+\/[a-z0-9/-]+$/);
        for (const core of caminhosDoCore) {
          expect(path === core || path.startsWith(`${core}/`)).toBe(false);
          expect(
            core.startsWith(`/${path.split('/')[1]}/`) || core === `/${path.split('/')[1]}`,
          ).toBe(false);
        }
      }
    }
  });

  it('a tela do Core numa extensão é a do registro do Core, nunca uma cópia com o mesmo caminho', () => {
    for (const manifesto of EXPERIENCIAS_DE_EXTENSAO) {
      for (const rota of manifesto.rotas) {
        if (caminhosDoCore.includes(rota.path)) expect(doCore).toContain(rota);
      }
    }
  });

  it('cada manifesto é fechado: o início, o menu e as configurações levam a rotas que ele monta', () => {
    // um início fora das rotas entraria em laço (o `/` vai a ele, que cai no `*`)
    for (const manifesto of [crmExperience, ...EXPERIENCIAS_DE_EXTENSAO]) {
      const caminhos = manifesto.rotas.map((r) => r.path);
      expect(caminhos).toContain(manifesto.inicio);
      for (const grupo of manifesto.grupos) {
        for (const item of grupo.items) expect(caminhos).toContain(item.to);
      }
      for (const secao of manifesto.configuracoes) expect(caminhos).toContain(secao.to);
    }
  });

  it('o menu do CRM não tem destino de extensão nenhuma (o menu não é mais a soma)', () => {
    const doCrm = crmExperience.grupos.flatMap((g) => g.items.map((i) => i.to));
    for (const manifesto of EXPERIENCIAS_DE_EXTENSAO) {
      const proprias = manifesto.rotas
        .filter((r) => !doCore.includes(r as never))
        .map((r) => r.path);
      for (const to of doCrm) expect(proprias).not.toContain(to);
    }
    expect(crmExperience.rotas.every((r) => doCore.includes(r as never))).toBe(true);
  });
});

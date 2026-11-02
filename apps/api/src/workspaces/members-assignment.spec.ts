import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_ROLE_TEMPLATES, systemKeyDoTemplate } from '@veyra/contracts';

/**
 * As convenções de que a regra de atribuição dos papéis de extensão depende
 * (ADR-056 adendo 1), presas aqui:
 * 1. nenhum papel de sistema do Core tem `:` no `systemKey` — senão o Core o
 *    leria como papel de extensão;
 * 2. os caminhos dos membros não tocam uso de conteúdo, reserva, run nem trava
 *    de restrição. A ativação e a desativação pegam a trava dos membros DEPOIS
 *    da trava de restrição do workspace e da marcação dos órfãos; um caminho
 *    dos membros que as pegasse, sob a trava dos membros, fecharia um ciclo.
 */
const CAMINHOS_DOS_MEMBROS = ['members.service.ts', 'invites.service.ts', 'members-lock.ts'];

/** o que pega trava de restrição ou toca as linhas que a marcação dos órfãos grava */
const PROIBIDO = [
  /from\s+['"][^'"]*content-use\//,
  /\bMudancasDeRestricao\b/,
  /veyra\.restriction/,
  /\.\s*(contentUse|usageReservation|aiRun|aiProposal)\s*\./,
];

describe('a atribuição de papel e a trava dos membros (ADR-056 adendo 1)', () => {
  it('nenhum papel de sistema do Core tem `:` no systemKey', () => {
    for (const nome of Object.keys(SYSTEM_ROLE_TEMPLATES)) {
      expect(systemKeyDoTemplate(nome)).not.toContain(':');
    }
  });

  it('os caminhos dos membros não pegam trava de restrição nem tocam usos, reservas, runs e propostas', () => {
    for (const arquivo of CAMINHOS_DOS_MEMBROS) {
      const texto = readFileSync(join(__dirname, arquivo), 'utf-8');
      for (const padrao of PROIBIDO) {
        expect({ arquivo, padrao: String(padrao), achou: padrao.test(texto) }).toEqual({
          arquivo,
          padrao: String(padrao),
          achou: false,
        });
      }
    }
  });

  it('o padrão pega as formas que importam', () => {
    expect(PROIBIDO[0].test("import { x } from '../content-use/restriction-changes';")).toBe(true);
    expect(PROIBIDO[3].test('await tx.contentUse.updateMany({})')).toBe(true);
    expect(PROIBIDO[3].test('await tx.usageReservation.deleteMany({})')).toBe(true);
    expect(PROIBIDO[3].test('await tx.membership.updateMany({})')).toBe(false);
  });
});

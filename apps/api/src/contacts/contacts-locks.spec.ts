import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A ordem das travas dos escritores de telefone (ADR-052 item 3), fixada no
 * texto do serviço: a corrida que ela evita (um deadlock entre a exclusão e a
 * identificação) não se reproduz de forma determinística num teste de banco.
 */
const SERVICO = readFileSync(join(__dirname, 'contacts.service.ts'), 'utf8');

/** O corpo de um método da classe, até o próximo membro. */
function corpo(metodo: string): string {
  const inicio = SERVICO.indexOf(`  async ${metodo}(`);
  expect(inicio).toBeGreaterThan(-1);
  const resto = SERVICO.slice(inicio + 1);
  const fim = resto.search(/\n {2}(async |private |\/\*\*)/);
  return resto.slice(0, fim === -1 ? undefined : fim);
}

describe('as travas dos escritores de telefone (ADR-052 item 3)', () => {
  it('a exclusão pega o contato e os endereços numa passada SÓ, antes de qualquer linha', () => {
    const remove = corpo('remove');
    // a mudança por contato vem uma vez, pelas travas de identidade, com os endereços
    expect(remove.match(/this\.travas\.paraTelefones\(/g)).toHaveLength(1);
    expect(remove).not.toMatch(/this\.restricao\.porContato\(/);
    // e antes de travar a linha (o nível 4)
    expect(remove.indexOf('this.travas.paraTelefones(')).toBeLessThan(
      remove.indexOf('this.lockAndRead('),
    );
  });

  it('a importação só CRIA contatos: sem atualizar, fundir ou buscar por telefone (a condição do desvio 7)', () => {
    const importar = corpo('import');
    expect(importar).toMatch(/tx\.contact\.createMany\(/);
    expect(importar).not.toMatch(/contact\.(update|updateMany|upsert|findFirst|findMany)\(/);
    expect(importar).not.toMatch(/phoneMatchKeys: \{ has/);
  });
});

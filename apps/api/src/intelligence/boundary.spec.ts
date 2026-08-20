import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * BARREIRA TÉCNICA do ADR-027, em teste — porque regra de lint pode ser
 * afrouxada num commit apressado e ninguém percebe; teste vermelho, não.
 *
 * O módulo `intelligence` não pode importar Prisma de forma alguma: as portas
 * são interfaces e os adaptadores vivem em `src/intelligence-persistence/`.
 * Não existe exceção aqui dentro — nem para arquivo de teste. O spec de
 * integração da IA, que asserta estado do banco, mora junto dos adaptadores e
 * exercita o módulo de fora, por HTTP.
 */
const MODULE_ROOT = join(__dirname);

const FORBIDDEN = [
  /from\s+['"].*prisma\.service['"]/,
  /from\s+['"].*\/prisma\/[^'"]*['"]/,
  /from\s+['"]@prisma\/client['"]/,
  /from\s+['"].*generated\/prisma[^'"]*['"]/,
  /PrismaService/,
  /prisma\.(db|raw)\./,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('fronteira do módulo intelligence (ADR-027)', () => {
  const files = walk(MODULE_ROOT).filter((file) => !file.endsWith('boundary.spec.ts'));

  it('encontra os arquivos do módulo (guarda contra teste vazio passando à toa)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(FORBIDDEN.map((pattern) => [pattern.source, pattern] as const))(
    'nenhum arquivo do módulo casa com %s',
    (_label, pattern) => {
      const culpados = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
      expect(culpados).toEqual([]);
    },
  );

  it('as portas de persistência existem e são só interfaces + tokens', () => {
    const ports = readFileSync(join(MODULE_ROOT, 'ports', 'repositories.ts'), 'utf8');
    for (const port of ['AiRunRepository', 'AiProposalRepository', 'AiConsentRepository']) {
      expect(ports).toContain(`interface ${port}`);
    }
    // porta não implementa nada: sem classe, sem import de runtime de banco
    expect(ports).not.toMatch(/\bclass\b/);
  });
});

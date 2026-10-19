import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * BARREIRA do ADR-047, em teste — a mesma regra do ESLint, porque lint pode ser
 * afrouxado num commit apressado e ninguém percebe; teste vermelho, não.
 *
 * O Core nunca importa um vertical. Só a raiz de composição (`composition.ts`
 * de cada app e o `app.module.ts` da API) e o próprio código do vertical
 * (`src/verticals/**`) podem citar `verticals/`.
 */
const REPO = join(__dirname, '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'apps/web/src', 'packages/contracts/src'];
const ALLOWED = new Set([
  'apps/api/src/app.module.ts',
  'apps/api/src/composition.ts',
  'apps/web/src/composition.ts',
  'apps/web/src/composition.tsx',
  // este arquivo cita o padrão nos próprios exemplos
  'apps/api/src/extensions/boundary.spec.ts',
]);
const IMPORT_OF_VERTICAL =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*\/verticals(?:\/|['"])/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated' || entry === 'verticals') return [];
      return walk(full);
    }
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

describe('fronteira Core → vertical (ADR-047)', () => {
  const files = ROOTS.flatMap((root) => walk(join(REPO, root))).map((file) => relative(REPO, file));

  it('encontra os arquivos do Core (guarda contra teste vazio passando à toa)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/api/src/app.module.ts');
  });

  it('nenhum arquivo do Core fora da raiz de composição importa `verticals/`', () => {
    const culpados = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => IMPORT_OF_VERTICAL.test(readFileSync(join(REPO, file), 'utf8')));
    expect(culpados).toEqual([]);
  });

  it('nenhum arquivo do Core usa delegate do Prisma de modelo de vertical', () => {
    // modelos declarados FORA do schema do Core (um arquivo por vertical)
    const schemaDir = join(REPO, 'apps/api/prisma/schema');
    const delegates = readdirSync(schemaDir)
      .filter((f) => f.endsWith('.prisma') && f !== 'schema.prisma')
      .flatMap((f) => [
        ...readFileSync(join(schemaDir, f), 'utf8').matchAll(/^model\s+(\w+)\s+\{/gm),
      ])
      .map((m) => m[1].charAt(0).toLowerCase() + m[1].slice(1));
    expect(delegates.length).toBeGreaterThan(0);
    const uso = new RegExp(`\\.\\s*(${delegates.join('|')})\\s*\\.`);
    const culpados = files
      .filter((file) => file.startsWith('apps/api/src/') && !ALLOWED.has(file))
      .filter((file) => uso.test(readFileSync(join(REPO, file), 'utf8')));
    expect(culpados).toEqual([]);
  });

  it('o padrão pega as formas de import que importam', () => {
    for (const sample of [
      "import { x } from '../verticals/clinics/x';",
      "import x from './verticals';",
      "const m = await import('../../verticals/clinics');",
      "const m = require('../verticals/clinics');",
    ]) {
      expect(IMPORT_OF_VERTICAL.test(sample)).toBe(true);
    }
    expect(IMPORT_OF_VERTICAL.test("import { x } from './vertical-agnostic';")).toBe(false);
  });
});

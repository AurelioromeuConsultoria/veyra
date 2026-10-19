import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Limite da exceção aceita no schema do CORE (ADR-047 adendo 2, item 1): o
 * arquivo do Core pode citar modelo de OUTRO arquivo (de um vertical) APENAS
 * como tipo de campo de relação REVERSO — o lado que o Prisma exige porque um
 * modelo não se divide entre arquivos. Nunca com `@relation(fields: …)` (a FK
 * mora no arquivo do vertical), nunca como escalar e nunca como enum.
 */
const DIR = path.resolve(__dirname, '../../prisma/schema');
const CORE_FILE = 'schema.prisma';
const read = (file: string) => readFileSync(path.join(DIR, file), 'utf8');
const declared = (source: string, kind: 'model' | 'enum') =>
  new Set([...source.matchAll(new RegExp(`^${kind}\\s+(\\w+)\\s+\\{`, 'gm'))].map((m) => m[1]));

describe('schema do Core — modelos de outros arquivos só como relação reversa', () => {
  const core = read(CORE_FILE);
  const outros = readdirSync(DIR).filter((f) => f.endsWith('.prisma') && f !== CORE_FILE);
  const modelosDeFora = new Set(outros.flatMap((f) => [...declared(read(f), 'model')]));
  const enumsDeFora = new Set(outros.flatMap((f) => [...declared(read(f), 'enum')]));

  it('existe ao menos um arquivo além do Core (sanidade do teste)', () => {
    expect(outros.length).toBeGreaterThan(0);
    expect(modelosDeFora.size).toBeGreaterThan(0);
  });

  it('nenhum campo do Core usa enum de outro arquivo', () => {
    const usos = core
      .split('\n')
      .filter((line) =>
        [...enumsDeFora].some((e) => new RegExp(`^\\s*\\w+\\s+${e}\\b`).test(line)),
      );
    expect(usos).toEqual([]);
  });

  it('todo campo do Core com tipo de outro arquivo é reverso: lista ou opcional, sem `fields:`', () => {
    const REVERSO = /^\s*\w+\s+(\w+)(\[\]|\?)(\s+@relation\("[^"]+"\))?\s*(\/\/.*)?$/;
    const violacoes = core.split('\n').filter((line) => {
      const tipo = /^\s*\w+\s+(\w+)/.exec(line)?.[1];
      if (!tipo || !modelosDeFora.has(tipo)) return false;
      return !REVERSO.test(line) || /fields\s*:/.test(line);
    });
    expect(violacoes).toEqual([]);
  });
});

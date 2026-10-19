import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPOSITION } from '../composition';
import { composeRegistry } from '../extensions/registry';
import { CORE_GLOBAL_MODELS, WORKSPACE_MODELS as CORE_WORKSPACE_MODELS } from './workspace-models';

/**
 * Teste de DRIFT (unit, sem banco): o registro de modelos protegidos é mantido
 * à mão — este teste o compara com o schema REAL. Modelo novo com workspaceId
 * fora do registro, typo de nome ou relação não mapeada = build vermelho, em
 * vez de isolamento desligado silenciosamente (CLAUDE.md §3.1).
 *
 * Desde o ADR-047 o schema é uma PASTA (Core + verticais, um arquivo cada) e o
 * registro é COMPOSTO na raiz: o teste lê todos os arquivos e compara com a
 * mesma composição que o app sobe — não com a constante do Core sozinha.
 */
const SCHEMA_DIR = path.resolve(__dirname, '../../prisma/schema');
const schemaFiles = readdirSync(SCHEMA_DIR).filter((file) => file.endsWith('.prisma'));
const schema = schemaFiles
  .map((file) => readFileSync(path.join(SCHEMA_DIR, file), 'utf8'))
  .join('\n');
const registry = composeRegistry(COMPOSITION.extensions);
const WORKSPACE_MODELS = registry.workspaceModels;
const RELATION_TARGETS = registry.relationTargets;

interface ParsedModel {
  name: string;
  body: string;
}

function parseModels(source: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const re = /^model\s+(\w+)\s+\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    models.push({ name: m[1], body: m[2] });
  }
  return models;
}

const models = parseModels(schema);
const modelNames = new Set(models.map((m) => m.name));

function hasWorkspaceId(model: ParsedModel): boolean {
  return /^\s*workspaceId\s/m.test(model.body);
}

/** campos de relação: linhas `nome Tipo` cujo Tipo (sem ?/[]) é outro model */
function relationFields(model: ParsedModel): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of model.body.split('\n')) {
    const fm = /^\s*(\w+)\s+(\w+)(\[\])?\??(\s|$)/.exec(line);
    if (!fm) continue;
    const [, fieldName, fieldType] = fm;
    if (modelNames.has(fieldType)) fields[fieldName] = fieldType;
  }
  return fields;
}

describe('registro de modelos protegidos — drift contra o schema', () => {
  it('o schema foi parseado (sanidade do próprio teste)', () => {
    expect(schemaFiles.length).toBeGreaterThanOrEqual(1);
    expect(modelNames.size).toBeGreaterThanOrEqual(7);
    expect(modelNames.has('Workspace')).toBe(true);
  });

  it('todo model com workspaceId está em WORKSPACE_MODELS (e nada além deles)', () => {
    const withWorkspaceId = models
      .filter(hasWorkspaceId)
      .map((m) => m.name)
      .sort();
    expect(withWorkspaceId).toEqual([...WORKSPACE_MODELS].sort());
  });

  it('todo modelo do arquivo do CORE está classificado: de workspace ou global', () => {
    // é esta lista que impede uma extensão de reivindicar `User` (ADR-047, E1)
    const core = parseModels(readFileSync(path.join(SCHEMA_DIR, 'schema.prisma'), 'utf8'));
    const naoClassificados = core
      .map((model) => model.name)
      .filter((name) => !CORE_WORKSPACE_MODELS.has(name) && !CORE_GLOBAL_MODELS.has(name));
    expect(naoClassificados).toEqual([]);
    for (const name of CORE_GLOBAL_MODELS) {
      const model = core.find((m) => m.name === name);
      expect(model).toBeDefined();
      expect(hasWorkspaceId(model as ParsedModel)).toBe(false);
    }
  });

  it('toda entrada de WORKSPACE_MODELS existe no schema (sem typo)', () => {
    for (const name of WORKSPACE_MODELS) {
      expect(modelNames.has(name)).toBe(true);
    }
  });

  it('RELATION_TARGETS cobre exatamente as relações dos modelos protegidos', () => {
    for (const name of WORKSPACE_MODELS) {
      const model = models.find((m) => m.name === name);
      expect(model).toBeDefined();
      expect(RELATION_TARGETS[name]).toEqual(relationFields(model as ParsedModel));
    }
  });

  it('toda FK entre modelos de workspace é composta e o alvo tem @@unique([workspaceId, id]) (ADR-010)', () => {
    for (const model of models) {
      if (!hasWorkspaceId(model)) continue; // FK partindo de tabela global — fora do escopo
      const fkRe = /^\s*\w+\s+(\w+)\??\s+@relation\(fields:\s*\[([^\]]+)\]/gm;
      let fk: RegExpExecArray | null;
      while ((fk = fkRe.exec(model.body)) !== null) {
        const [, targetName, fieldsList] = fk;
        if (!WORKSPACE_MODELS.has(targetName)) continue; // alvo global/raiz — FK simples ok
        // FK protegido→protegido: precisa incluir workspaceId (composta)…
        expect(`${model.name}→${targetName}: ${fieldsList}`).toMatch(/workspaceId/);
        // …e o alvo precisa expor o par (workspaceId, id) como unique
        const target = models.find((m) => m.name === targetName) as ParsedModel;
        expect(target.body).toMatch(/@@unique\(\[workspaceId,\s*id\]\)/);
      }
    }
  });
});

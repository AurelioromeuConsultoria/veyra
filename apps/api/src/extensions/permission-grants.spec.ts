import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PERMISSION_CATALOG, SYSTEM_ROLE_TEMPLATES } from '@veyra/contracts';

/**
 * NENHUM fluxo do Core concede permissão de extensão (ADR-047 E2; aprovação da
 * F1). A porta de disponibilidade foi adiada por não ter consumidor — e este
 * teste é o que torna o adiamento seguro: ele quebra no dia em que surgir um
 * caminho novo de concessão, que então precisará da porta.
 *
 * Três garantias, juntas:
 * 1. só o PROVISIONAMENTO escreve `RolePermission` no Core;
 * 2. o provisionamento só concede os templates de sistema;
 * 3. os templates e o catálogo do Core só contêm chaves do CORE — uma chave de
 *    extensão no catálogo do Core (que daria ao Owner de TODO workspace a
 *    permissão de um vertical) quebra aqui.
 */
const SRC = join(__dirname, '..');

/** escrita em RolePermission: client Prisma ou SQL cru */
const WRITES = [
  /rolePermission\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|upsert)\b/,
  /(INSERT\s+INTO|UPDATE)\s+"?RolePermission"?/i,
  // escrita ANINHADA: `role.create({ data: { permissions: { create } } })` e afins
  /\b(permissions|rolePermissions)\s*:\s*\{\s*(create|createMany|connect|connectOrCreate|upsert)\b/,
];

/** namespaces do catálogo do Core. Namespace NOVO do Core entra aqui de propósito. */
const CORE_NAMESPACES = [
  'workspace',
  'members',
  'roles',
  'contacts',
  'pipelines',
  'deals',
  'tasks',
  'conversations',
  'calendar',
  'files',
  'automations',
  'webhooks',
  'audit',
  'billing',
  'intelligence',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // código de vertical é governado pela própria CLI de ativação (F1.b)
      if (entry === 'generated' || entry === 'verticals') return [];
      return walk(full);
    }
    return entry.endsWith('.ts') && !/\.(spec|integration-spec)\.ts$/.test(entry) ? [full] : [];
  });
}

describe('concessão de permissões no Core (ADR-047 E2)', () => {
  it('só o provisionamento escreve RolePermission', () => {
    const writers = walk(SRC)
      .filter((file) => WRITES.some((pattern) => pattern.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file));
    expect(writers).toEqual(['workspaces/provisioning.service.ts']);
  });

  it('o provisionamento referencia os templates de sistema do Core', () => {
    // sanidade estática. A prova de COMPORTAMENTO — provisionar com uma extensão
    // composta não concede nem registra chave dela — está em
    // `composition.integration-spec.ts`
    const source = readFileSync(join(SRC, 'workspaces/provisioning.service.ts'), 'utf8');
    expect(source).toMatch(/SYSTEM_ROLE_TEMPLATES/);
  });

  it('o padrão de escrita pega também a forma aninhada', () => {
    for (const sample of [
      'tx.role.create({ data: { name, permissions: { create: keys } } })',
      'raw.permission.update({ data: { rolePermissions: { connectOrCreate: x } } })',
    ]) {
      expect(WRITES.some((pattern) => pattern.test(sample))).toBe(true);
    }
  });

  it('todo template de papel de sistema usa só chaves do catálogo do Core', () => {
    const catalog = new Set(Object.keys(PERMISSION_CATALOG));
    for (const [role, keys] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
      for (const key of keys)
        expect(`${role}:${key}:${catalog.has(key)}`).toBe(`${role}:${key}:true`);
    }
  });

  it('o catálogo do Core só tem chaves de namespaces do Core', () => {
    const fora = Object.keys(PERMISSION_CATALOG).filter(
      (key) => !CORE_NAMESPACES.includes(key.split(':')[0]),
    );
    expect(fora).toEqual([]);
  });
});

import { PERMISSION_CATALOG } from '@veyra/contracts';
import { AUDIT_FIELDS } from '../audit/audit-fields';
import { APPEND_ONLY_MODELS, RELATION_TARGETS, WORKSPACE_MODELS } from '../prisma/workspace-models';
import type { CoreExtension } from './extension';
import { CORE_REGISTRY, composeRegistry as composeWithSchema } from './registry';

/** schema de mentira: os modelos da extensão de teste "existem" */
const SCHEMA = new Set([...WORKSPACE_MODELS, 'User', 'Workspace', 'DemoThing', 'DemoLog', 'Other']);
const composeRegistry = (extensions: CoreExtension[]) => composeWithSchema(extensions, SCHEMA);

/** Extensão de teste VÁLIDA: o formato que um vertical entrega na composição. */
const valid = (): CoreExtension => ({
  name: 'demo',
  tenantModels: {
    workspaceModels: ['DemoThing', 'DemoLog'],
    appendOnlyModels: ['DemoLog'],
    relationTargets: {
      DemoThing: { workspace: 'Workspace', contact: 'Contact', logs: 'DemoLog' },
      DemoLog: { thing: 'DemoThing' },
      // lado oposto que o Prisma exige no modelo do Core
      Contact: { demoThings: 'DemoThing' },
    },
  },
  permissionCatalog: { 'demo:read': 'Ver', 'demo:write': 'Editar' },
  auditFields: { demoThing: ['status'] },
});

describe('composeRegistry (ADR-047: E1, E2, E4)', () => {
  it('sem extensões é exatamente o Core', () => {
    expect([...CORE_REGISTRY.workspaceModels].sort()).toEqual([...WORKSPACE_MODELS].sort());
    expect([...CORE_REGISTRY.appendOnlyModels].sort()).toEqual([...APPEND_ONLY_MODELS].sort());
    expect(CORE_REGISTRY.relationTargets).toEqual(RELATION_TARGETS);
    expect([...CORE_REGISTRY.permissionKeys].sort()).toEqual(
      Object.keys(PERMISSION_CATALOG).sort(),
    );
    expect(CORE_REGISTRY.auditFields).toEqual(AUDIT_FIELDS);
    expect(CORE_REGISTRY.permissionCatalog).toEqual(PERMISSION_CATALOG);
    // a experiência do Core, e só ela (ADR-055)
    expect([...CORE_REGISTRY.experiences.values()]).toEqual([
      { key: 'crm', extension: null, selectable: true },
    ]);
  });

  it('a experiência da extensão tem a chave do nome dela e diz se é selecionável (ADR-055)', () => {
    const registry = composeRegistry([{ ...valid(), experience: { selectable: false } }]);
    expect(registry.experiences.get('demo')).toEqual({
      key: 'demo',
      extension: 'demo',
      selectable: false,
    });
    expect(registry.experiences.get('crm')?.extension).toBeNull();
    // sem declarar, nenhuma experiência nova
    expect([...composeRegistry([valid()]).experiences.keys()]).toEqual(['crm']);
  });

  it('nenhuma extensão pode se chamar `crm`, a experiência do Core', () => {
    expect(() => composeRegistry([{ name: 'crm' }])).toThrow(/colide com um namespace do Core/);
  });

  it('compõe uma extensão válida sem tocar no que é do Core', () => {
    const registry = composeRegistry([valid()]);
    expect(registry.workspaceModels.has('DemoThing')).toBe(true);
    expect(registry.appendOnlyModels.has('DemoLog')).toBe(true);
    expect(registry.relationTargets.Contact.demoThings).toBe('DemoThing');
    // as relações originais do Contact continuam lá
    expect(registry.relationTargets.Contact.deals).toBe('Deal');
    expect(registry.permissionKeys.has('demo:read')).toBe(true);
    // a descrição declarada pela extensão chega à tela de papéis (ADR-054 item 7)
    expect(registry.permissionCatalog['demo:read']).toBe('Ver');
    expect(registry.permissionCatalog['contacts:read']).toBe(PERMISSION_CATALOG['contacts:read']);
    expect(registry.auditFields.demoThing).toEqual(['status']);
    // compor não muta as constantes do Core
    expect(RELATION_TARGETS.Contact).not.toHaveProperty('demoThings');
    expect(PERMISSION_CATALOG).not.toHaveProperty('demo:read');
  });

  const rejects: [string, (ext: CoreExtension) => CoreExtension][] = [
    ['nome fora do padrão', (e) => ({ ...e, name: 'Demo-X' })],
    ['nome que colide com namespace do Core', (e) => ({ ...e, name: 'contacts' })],
    [
      'modelo GLOBAL do Core reivindicado (User)',
      (e) => ({
        ...e,
        tenantModels: {
          workspaceModels: ['User'],
          relationTargets: { User: {} },
        },
      }),
    ],
    [
      'modelo sem o prefixo da extensão',
      (e) => ({
        ...e,
        tenantModels: { workspaceModels: ['Other'], relationTargets: { Other: {} } },
      }),
    ],
    [
      'modelo que não existe no schema',
      (e) => ({
        ...e,
        tenantModels: { workspaceModels: ['DemoGhost'], relationTargets: { DemoGhost: {} } },
      }),
    ],
    [
      'tipo de auditoria com prefixo colado (sem maiúscula)',
      (e) => ({ ...e, auditFields: { demothing: ['status'] } }),
    ],
    [
      'modelo que já existe no Core',
      (e) => ({
        ...e,
        tenantModels: { ...e.tenantModels!, workspaceModels: ['Contact'], appendOnlyModels: [] },
      }),
    ],
    [
      'append-only de modelo alheio',
      (e) => ({ ...e, tenantModels: { ...e.tenantModels!, appendOnlyModels: ['AuditLog'] } }),
    ],
    [
      'modelo sem mapa de relações',
      (e) => ({
        ...e,
        tenantModels: {
          ...e.tenantModels!,
          relationTargets: { DemoThing: e.tenantModels!.relationTargets.DemoThing },
        },
      }),
    ],
    [
      'relação acrescentada a modelo do Core apontando para fora da extensão',
      (e) => ({
        ...e,
        tenantModels: {
          ...e.tenantModels!,
          relationTargets: { ...e.tenantModels!.relationTargets, Contact: { sneaky: 'User' } },
        },
      }),
    ],
    [
      'redefinição de relação existente do Core',
      (e) => ({
        ...e,
        tenantModels: {
          ...e.tenantModels!,
          relationTargets: { ...e.tenantModels!.relationTargets, Contact: { deals: 'DemoThing' } },
        },
      }),
    ],
    [
      'chave sem o prefixo da extensão',
      (e) => ({ ...e, permissionCatalog: { 'contacts:read': 'x' } }),
    ],
    [
      'allowlist que sobrescreve tipo do Core',
      (e) => ({ ...e, auditFields: { contact: ['name', 'phones'] } }),
    ],
  ];

  it.each(rejects)('recusa no boot: %s', (_label, mutate) => {
    expect(() => composeRegistry([mutate(valid())])).toThrow(/ADR-047/);
  });

  it('recusa duas extensões com o mesmo nome', () => {
    expect(() => composeRegistry([valid(), valid()])).toThrow(/repetido/);
  });
});

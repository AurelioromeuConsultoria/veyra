import { PERMISSION_CATALOG } from '@veyra/contracts';
import { AUDIT_FIELDS } from '../audit/audit-fields';
import { Prisma } from '../generated/prisma/client';
import {
  APPEND_ONLY_MODELS,
  CORE_GLOBAL_MODELS,
  OUTCOME_ONLY_MODELS,
  RELATION_TARGETS,
  WORKSPACE_MODELS,
} from '../prisma/workspace-models';
import type { CoreExtension } from './extension';

/**
 * Registro COMPOSTO (Core ∪ extensões), montado uma vez na raiz e injetado onde
 * antes se lia a constante do Core (ADR-047: E1, E2, E4).
 */
export interface ComposedRegistry {
  readonly extensionNames: readonly string[];
  readonly workspaceModels: ReadonlySet<string>;
  readonly appendOnlyModels: ReadonlySet<string>;
  /** só o Core declara: o modelo, os campos do desfecho e os instantes do banco */
  readonly outcomeOnlyModels: typeof OUTCOME_ONLY_MODELS;
  readonly relationTargets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly permissionKeys: ReadonlySet<string>;
  readonly auditFields: Readonly<Record<string, readonly string[]>>;
}

export const EXTENSION_REGISTRY = Symbol('EXTENSION_REGISTRY');

const NAME_RE = /^[a-z][a-z0-9]{1,30}$/;

/** modelos que o client gerado conhece — o de extensão precisa existir no schema */
const SCHEMA_MODELS = new Set<string>(Object.values(Prisma.ModelName));

/** `clinics` → `Clinics`: prefixo obrigatório dos modelos e tipos de auditoria */
function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** namespaces que o Core já usa no catálogo — nome de extensão não pode colidir */
const CORE_NAMESPACES = new Set(Object.keys(PERMISSION_CATALOG).map((key) => key.split(':')[0]));

class ExtensionCompositionError extends Error {
  constructor(extension: string, detail: string) {
    super(`Composição inválida da extensão "${extension}": ${detail} (ADR-047).`);
  }
}

/**
 * Compõe e VALIDA. Qualquer violação derruba o boot: uma extensão que
 * redefinisse modelo, chave ou allowlist do Core trocaria uma garantia de
 * isolamento por outra em silêncio, e isso precisa falhar alto.
 */
export function composeRegistry(
  extensions: readonly CoreExtension[],
  /** modelos existentes no schema; o padrão é o client gerado */
  schemaModels: ReadonlySet<string> = SCHEMA_MODELS,
): ComposedRegistry {
  const workspaceModels = new Set(WORKSPACE_MODELS);
  const appendOnlyModels = new Set(APPEND_ONLY_MODELS);
  const relationTargets: Record<string, Record<string, string>> = {};
  for (const [model, fields] of Object.entries(RELATION_TARGETS)) {
    relationTargets[model] = { ...fields };
  }
  const permissionKeys = new Set<string>(Object.keys(PERMISSION_CATALOG));
  const auditFields: Record<string, readonly string[]> = { ...AUDIT_FIELDS };
  const names: string[] = [];

  for (const extension of extensions) {
    const name = extension.name;
    if (!NAME_RE.test(name)) {
      throw new ExtensionCompositionError(name, 'nome fora do padrão [a-z][a-z0-9]{1,30}');
    }
    if (CORE_NAMESPACES.has(name)) {
      throw new ExtensionCompositionError(name, 'nome colide com um namespace do Core');
    }
    if (names.includes(name)) {
      throw new ExtensionCompositionError(name, 'nome repetido');
    }
    names.push(name);

    const own = new Set(extension.tenantModels?.workspaceModels ?? []);
    for (const model of own) {
      // modelo do Core — de workspace OU global — nunca vira "da extensão"
      if (workspaceModels.has(model) || CORE_GLOBAL_MODELS.has(model)) {
        throw new ExtensionCompositionError(name, `modelo ${model} já pertence a outro dono`);
      }
      if (!model.startsWith(pascal(name))) {
        throw new ExtensionCompositionError(
          name,
          `modelo ${model} sem o prefixo "${pascal(name)}"`,
        );
      }
      if (!schemaModels.has(model)) {
        throw new ExtensionCompositionError(name, `modelo ${model} não existe no schema`);
      }
      workspaceModels.add(model);
    }
    for (const model of extension.tenantModels?.appendOnlyModels ?? []) {
      if (!own.has(model)) {
        throw new ExtensionCompositionError(name, `append-only ${model} não é modelo da extensão`);
      }
      appendOnlyModels.add(model);
    }
    for (const model of own) {
      if (!extension.tenantModels?.relationTargets[model]) {
        throw new ExtensionCompositionError(name, `modelo ${model} sem mapa de relações`);
      }
    }
    for (const [model, fields] of Object.entries(extension.tenantModels?.relationTargets ?? {})) {
      const isOwn = own.has(model);
      if (!isOwn && !relationTargets[model]) {
        throw new ExtensionCompositionError(name, `relações para modelo desconhecido ${model}`);
      }
      const target = (relationTargets[model] ??= {});
      for (const [field, targetModel] of Object.entries(fields)) {
        if (field in target) {
          throw new ExtensionCompositionError(name, `relação ${model}.${field} já existe`);
        }
        // acréscimo a modelo alheio só pode apontar para dentro da extensão
        if (!isOwn && !own.has(targetModel)) {
          throw new ExtensionCompositionError(
            name,
            `relação ${model}.${field} acrescentada a modelo alheio aponta para fora da extensão`,
          );
        }
        target[field] = targetModel;
      }
    }

    for (const key of Object.keys(extension.permissionCatalog ?? {})) {
      if (!key.startsWith(`${name}:`)) {
        throw new ExtensionCompositionError(name, `chave ${key} sem o prefixo "${name}:"`);
      }
      if (permissionKeys.has(key)) {
        throw new ExtensionCompositionError(name, `chave ${key} repetida`);
      }
      permissionKeys.add(key);
    }

    for (const [entityType, fields] of Object.entries(extension.auditFields ?? {})) {
      // `clinicsPatient`: o prefixo é seguido de maiúscula — `clinicsx` não passa
      const prefixed = new RegExp(`^${name}[A-Z]`).test(entityType);
      if (!prefixed || entityType in auditFields) {
        throw new ExtensionCompositionError(
          name,
          `tipo de auditoria ${entityType} precisa começar com "${name}" + maiúscula e ser novo`,
        );
      }
      auditFields[entityType] = [...fields];
    }
  }

  return {
    extensionNames: names,
    workspaceModels,
    appendOnlyModels,
    outcomeOnlyModels: OUTCOME_ONLY_MODELS,
    relationTargets,
    permissionKeys,
    auditFields,
  };
}

/** Registro do Core puro — o padrão quando nada é composto (testes de unidade, CLI). */
export const CORE_REGISTRY: ComposedRegistry = composeRegistry([]);

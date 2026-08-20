import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateCustomFieldInput,
  CustomFieldDto,
  CustomFieldEntity,
  CustomFieldValues,
  UpdateCustomFieldInput,
} from '@veyra/contracts';
import { PrismaService, type Db } from '../prisma/prisma.service';

interface DefinitionRow {
  id: string;
  entityType: CustomFieldEntity;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
}

/** Valor já validado/normalizado, pronto para persistir. */
export interface ValidatedCustomFields {
  /** definitionId → valor (null = limpar) */
  byDefinition: Map<string, unknown>;
}

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  async listDefinitions(entityType?: CustomFieldEntity): Promise<CustomFieldDto[]> {
    const rows = await this.prisma.db.customFieldDefinition.findMany({
      where: entityType ? { entityType } : undefined,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toDto(row as DefinitionRow));
  }

  async createDefinition(input: CreateCustomFieldInput): Promise<CustomFieldDto> {
    const existing = await this.prisma.db.customFieldDefinition.findFirst({
      where: { entityType: input.entityType, key: input.key },
    });
    if (existing) throw new BadRequestException(`Já existe um campo com a chave "${input.key}"`);
    const row = await this.prisma.db.customFieldDefinition.create({
      data: {
        entityType: input.entityType,
        key: input.key,
        label: input.label,
        type: input.type,
        options: input.options ?? [],
        required: input.required,
      },
    } as never);
    return this.toDto(row as DefinitionRow);
  }

  async updateDefinition(id: string, input: UpdateCustomFieldInput): Promise<CustomFieldDto> {
    const row = await this.prisma.db.customFieldDefinition.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Campo não encontrado');
    // mesma invariante do create, resolvida contra o TYPE existente: select/
    // multiselect nunca ficam sem opções; demais tipos não aceitam opções
    const isSelect = row.type === 'select' || row.type === 'multiselect';
    if (input.options !== undefined) {
      if (isSelect && input.options.length === 0) {
        throw new BadRequestException('Campos de seleção exigem ao menos uma opção');
      }
      if (!isSelect && input.options.length > 0) {
        throw new BadRequestException('Apenas campos de seleção aceitam opções');
      }
    }
    // encolher options órfãos: valores existentes com opção removida continuam
    // gravados (leitura tolera); a UI sinaliza. Documentado no DOMAIN_MODEL.
    await this.prisma.db.customFieldDefinition.updateMany({
      where: { id },
      data: {
        label: input.label,
        options: input.options,
        required: input.required,
      },
    });
    const updated = await this.prisma.db.customFieldDefinition.findFirst({ where: { id } });
    return this.toDto(updated as DefinitionRow);
  }

  async removeDefinition(id: string): Promise<void> {
    // cascade da FK composta apaga os CustomFieldValue da definição
    const { count } = await this.prisma.db.customFieldDefinition.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException('Campo não encontrado');
  }

  /**
   * Valida o input contra as definições do workspace. Rejeita chave
   * desconhecida; `requireAll` (create) exige os campos required.
   */
  async validateValues(
    entityType: CustomFieldEntity,
    input: Record<string, unknown>,
    options: { requireAll: boolean },
  ): Promise<ValidatedCustomFields> {
    const definitions = (await this.prisma.db.customFieldDefinition.findMany({
      where: { entityType },
    })) as DefinitionRow[];
    const byKey = new Map(definitions.map((d) => [d.key, d]));

    const byDefinition = new Map<string, unknown>();
    for (const [key, raw] of Object.entries(input)) {
      const def = byKey.get(key);
      if (!def) throw new BadRequestException(`Campo personalizado desconhecido: "${key}"`);
      byDefinition.set(def.id, this.normalize(def, raw));
    }

    if (options.requireAll) {
      for (const def of definitions) {
        if (!def.required) continue;
        const value = byDefinition.get(def.id);
        if (value === undefined || value === null) {
          throw new BadRequestException(`Campo obrigatório ausente: "${def.key}"`);
        }
      }
    } else {
      // update: não se limpa campo required
      for (const def of definitions) {
        if (def.required && byDefinition.has(def.id) && byDefinition.get(def.id) === null) {
          throw new BadRequestException(`Campo obrigatório não pode ser limpo: "${def.key}"`);
        }
      }
    }
    return { byDefinition };
  }

  /**
   * Persiste os valores validados (substitui apenas as chaves enviadas).
   * Recebe o client da transação do chamador (db ou tx do db.$transaction —
   * a extensão de isolamento se aplica dentro da itx, coberto pelo teste P0).
   */
  async syncValues(
    db: Db,
    entityType: CustomFieldEntity,
    entityId: string,
    validated: ValidatedCustomFields,
  ): Promise<void> {
    const definitionIds = [...validated.byDefinition.keys()];
    if (definitionIds.length === 0) return;
    await db.customFieldValue.deleteMany({
      where: { entityType, entityId, definitionId: { in: definitionIds } },
    });
    const rows = definitionIds
      .filter((definitionId) => validated.byDefinition.get(definitionId) !== null)
      .map((definitionId) => ({
        definitionId,
        entityType,
        entityId,
        value: validated.byDefinition.get(definitionId) as object,
      }));
    if (rows.length > 0) {
      await db.customFieldValue.createMany({ data: rows } as never);
    }
  }

  /** Apaga todos os valores de uma entidade (chamado pelo delete do dono). */
  async deleteValues(db: Db, entityType: CustomFieldEntity, entityId: string): Promise<void> {
    await db.customFieldValue.deleteMany({ where: { entityType, entityId } });
  }

  /** Carrega os valores de várias entidades de uma vez (montagem de DTOs). */
  async valuesByEntity(
    entityType: CustomFieldEntity,
    entityIds: string[],
  ): Promise<Map<string, CustomFieldValues>> {
    const result = new Map<string, CustomFieldValues>();
    if (entityIds.length === 0) return result;
    const [definitions, values] = await Promise.all([
      this.prisma.db.customFieldDefinition.findMany({ where: { entityType } }),
      this.prisma.db.customFieldValue.findMany({
        where: { entityType, entityId: { in: entityIds } },
      }),
    ]);
    const keyByDefinition = new Map(definitions.map((d) => [d.id, d.key]));
    for (const value of values) {
      const key = keyByDefinition.get(value.definitionId);
      if (!key) continue;
      // Object.create(null): sem Object.prototype na cadeia (hardening; a regex
      // de key já bloqueia __proto__, isto cobre constructor/toString etc.)
      const bucket = result.get(value.entityId) ?? (Object.create(null) as CustomFieldValues);
      bucket[key] = value.value as CustomFieldValues[string];
      result.set(value.entityId, bucket);
    }
    return result;
  }

  private normalize(def: DefinitionRow, raw: unknown): unknown {
    if (raw === null) return null;
    const fail = (expected: string): never => {
      throw new BadRequestException(`Campo "${def.key}": esperado ${expected}`);
    };
    switch (def.type) {
      case 'text':
        return typeof raw === 'string' && raw.length <= 2000 ? raw : fail('texto (≤2000)');
      case 'number':
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : fail('número');
      case 'boolean':
        return typeof raw === 'boolean' ? raw : fail('booleano');
      case 'date': {
        if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
          return fail('data ISO (AAAA-MM-DD)');
        }
        return raw;
      }
      case 'select':
        return typeof raw === 'string' && def.options.includes(raw)
          ? raw
          : fail(`uma das opções: ${def.options.join(', ')}`);
      case 'multiselect': {
        const ok =
          Array.isArray(raw) &&
          raw.length <= def.options.length && // dedupado nunca excede as opções
          raw.every((item) => typeof item === 'string' && def.options.includes(item));
        return ok
          ? [...new Set(raw as string[])]
          : fail(`lista dentro das opções: ${def.options.join(', ')}`);
      }
      default:
        return fail('tipo suportado');
    }
  }

  private toDto(row: DefinitionRow): CustomFieldDto {
    return {
      id: row.id,
      entityType: row.entityType,
      key: row.key,
      label: row.label,
      type: row.type as CustomFieldDto['type'],
      options: row.options,
      required: row.required,
    };
  }
}

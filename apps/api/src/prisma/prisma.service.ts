import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '../generated/prisma/client';
import { RELATION_TARGETS, WORKSPACE_MODELS } from './workspace-models';

/**
 * Operações por chave única não aceitam filtro extra de workspace no where —
 * seriam um bypass silencioso do isolamento. Proibidas nos modelos protegidos:
 * use findFirst/updateMany/deleteMany, que passam pelo filtro (SECURITY.md §2).
 */
const UNSAFE_OPERATIONS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WHERE_LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT']);
const RELATION_FILTER_WRAPPERS = new Set(['some', 'every', 'none', 'is', 'isNot']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * O hook do Prisma só intercepta a operação de TOPO: relações resolvidas dentro
 * de include/select/where/orderBy não voltam ao hook. Travessia
 * protegido→protegido é segura (FK composta garante mesmo workspace, ADR-010);
 * travessia para FORA do perímetro (User, Workspace, Permission) vazaria — é
 * bloqueada aqui, fail-closed. Precisa do dado global? prisma.raw com
 * justificativa, em consulta separada.
 */
function assertSafeTraversal(model: string, key: string): string | undefined {
  const target = RELATION_TARGETS[model]?.[key];
  if (target === undefined) return undefined; // campo escalar/operador
  if (!WORKSPACE_MODELS.has(target)) {
    throw new Error(
      `Travessia ${model}.${key} → ${target} sai do perímetro protegido — ` +
        `proteção multitenant bloqueou a operação. Consulte ${target} separadamente via prisma.raw (justificado).`,
    );
  }
  return target;
}

function assertSafeSelection(model: string, selection: unknown): void {
  if (!isPlainObject(selection)) return;
  for (const [key, value] of Object.entries(selection)) {
    if (key === '_count') {
      // _count.select conta relações do MESMO modelo — validar como relações
      if (isPlainObject(value) && isPlainObject(value.select)) {
        for (const countKey of Object.keys(value.select)) {
          assertSafeTraversal(model, countKey);
        }
      }
      continue;
    }
    const target = assertSafeTraversal(model, key);
    if (target && isPlainObject(value)) {
      assertSafeSelection(target, value.include);
      assertSafeSelection(target, value.select);
      assertSafeWhere(target, value.where);
      assertSafeOrderBy(target, value.orderBy);
    }
  }
}

function assertSafeWhere(model: string, where: unknown): void {
  if (Array.isArray(where)) {
    for (const w of where) assertSafeWhere(model, w);
    return;
  }
  if (!isPlainObject(where)) return;
  for (const [key, value] of Object.entries(where)) {
    if (WHERE_LOGICAL_KEYS.has(key)) {
      assertSafeWhere(model, value);
      continue;
    }
    const target = assertSafeTraversal(model, key);
    if (!target) continue;
    // filtro de relação protegida: recursar (desembrulhando some/every/none/is/isNot)
    if (isPlainObject(value)) {
      for (const [wrapKey, wrapValue] of Object.entries(value)) {
        if (RELATION_FILTER_WRAPPERS.has(wrapKey)) {
          assertSafeWhere(target, wrapValue);
        }
      }
      assertSafeWhere(target, value);
    }
  }
}

function assertSafeOrderBy(model: string, orderBy: unknown): void {
  if (Array.isArray(orderBy)) {
    for (const o of orderBy) assertSafeOrderBy(model, o);
    return;
  }
  if (!isPlainObject(orderBy)) return;
  for (const [key, value] of Object.entries(orderBy)) {
    const target = assertSafeTraversal(model, key);
    if (target) assertSafeOrderBy(target, value);
  }
}

/**
 * Escrita em modelo protegido: (1) `workspaceId` explícito no data é rejeitado
 * quando diverge do CLS — mover linha de workspace é escalada de privilégio
 * (as FKs compostas com ON UPDATE CASCADE arrastariam as junções); (2) objetos
 * de relação no data (nested create/connect/update) não passam pelo hook e são
 * rejeitados — use as FKs escalares (userId, roleId).
 */
function assertSafeData(model: string, data: unknown, workspaceId: string): void {
  if (Array.isArray(data)) {
    for (const d of data) assertSafeData(model, d, workspaceId);
    return;
  }
  if (!isPlainObject(data)) return;
  if ('workspaceId' in data && data.workspaceId !== workspaceId) {
    throw new Error(
      `workspaceId explícito no data de ${model} diverge do contexto — proteção multitenant bloqueou a operação.`,
    );
  }
  for (const key of Object.keys(data)) {
    const target = RELATION_TARGETS[model]?.[key];
    if (target !== undefined) {
      throw new Error(
        `Escrita aninhada ${model}.${key} (relação → ${target}) não passa pela proteção multitenant — use a FK escalar.`,
      );
    }
  }
}

function blockedRaw(method: string): never {
  throw new Error(
    `${method} não existe no client protegido — SQL cru só via prisma.raw, com justificativa (SECURITY.md §2).`,
  );
}

function createWorkspaceClient(base: PrismaClient, getWorkspaceId: () => unknown): PrismaClient {
  // O cast de volta para PrismaClient evita a inferência de tipos gigante do
  // $extends (que estoura a memória do tsc); o runtime não muda.
  return base.$extends({
    query: {
      // SQL cru ignora o filtro de workspace por definição — bloqueado no db.
      $queryRaw: () => blockedRaw('$queryRaw'),
      $queryRawUnsafe: () => blockedRaw('$queryRawUnsafe'),
      $executeRaw: () => blockedRaw('$executeRaw'),
      $executeRawUnsafe: () => blockedRaw('$executeRawUnsafe'),
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Fail-closed nos DOIS sentidos: modelo fora de WORKSPACE_MODELS não é
          // "livre", é PROIBIDO no db — identidade global e catálogos só via raw.
          if (!model || !WORKSPACE_MODELS.has(model)) {
            throw new Error(
              `${model ?? operation} não é modelo de workspace — proteção multitenant bloqueou; ` +
                `use prisma.raw com justificativa (SECURITY.md §2).`,
            );
          }

          const workspaceId = getWorkspaceId();
          if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
            // Sem contexto válido (ou contexto adulterado), nenhuma linha sai.
            throw new Error(
              `Query em ${model} sem workspace válido no contexto — proteção multitenant bloqueou a operação.`,
            );
          }

          if (UNSAFE_OPERATIONS.has(operation)) {
            throw new Error(
              `${operation} não é tenant-safe em ${model}; use findFirst/updateMany/deleteMany.`,
            );
          }

          // clona: o hook nunca muta o objeto args do chamador
          const a = { ...((args ?? {}) as Record<string, unknown>) };

          assertSafeSelection(model, a.include);
          assertSafeSelection(model, a.select);
          assertSafeWhere(model, a.where);
          assertSafeOrderBy(model, a.orderBy);

          switch (operation) {
            case 'create':
              assertSafeData(model, a.data, workspaceId);
              a.data = { ...(a.data as object), workspaceId };
              break;
            case 'createMany':
            case 'createManyAndReturn': {
              assertSafeData(model, a.data, workspaceId);
              const data = a.data;
              a.data = Array.isArray(data)
                ? data.map((d) => ({ ...(d as object), workspaceId }))
                : { ...(data as object), workspaceId };
              break;
            }
            case 'updateMany':
            case 'updateManyAndReturn':
              assertSafeData(model, a.data, workspaceId);
              a.where = { AND: [{ workspaceId }, (a.where as object) ?? {}] };
              break;
            default:
              a.where = { AND: [{ workspaceId }, (a.where as object) ?? {}] };
          }
          return query(a as never);
        },
      },
    },
  }) as unknown as PrismaClient;
}

export type Db = PrismaClient;

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  /** client com isolamento de workspace automático e fail-closed — o padrão */
  readonly db: Db;
  /**
   * client cru, SEM filtro de workspace. Uso excepcional e sempre comentado
   * (SECURITY.md §2): identidade global (User/RefreshToken), autenticação,
   * resolução de convite por tokenHash, provisionamento controlado, jobs
   * cross-workspace, rotinas administrativas.
   */
  readonly raw: PrismaClient;

  constructor(private readonly cls: ClsService) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL ausente — o PrismaService não pode iniciar.');
    }
    this.raw = new PrismaClient({
      adapter: new PrismaPg(process.env.DATABASE_URL),
    });
    // db estende o MESMO client (um pool só; transações compartilham conexão)
    this.db = createWorkspaceClient(this.raw, () => this.cls.get('workspaceId'));
  }

  async onModuleInit() {
    await this.raw.$connect();
  }

  async onModuleDestroy() {
    await this.raw.$disconnect();
  }
}

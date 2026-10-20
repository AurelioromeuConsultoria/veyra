import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { prismaAdapter } from './prisma-adapter';
import { ClsService } from 'nestjs-cls';
import { PrismaClient } from '../generated/prisma/client';
import { CORE_REGISTRY, EXTENSION_REGISTRY, type ComposedRegistry } from '../extensions/registry';
import { sqlDeCoordenacao } from '../content-use/coordination-sql';

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

/** Mutações proibidas em modelos append-only (histórico não se reescreve). */
const MUTATING_OPERATIONS = new Set<string>([
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
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
function assertSafeTraversal(
  reg: ComposedRegistry,
  model: string,
  key: string,
): string | undefined {
  const target = reg.relationTargets[model]?.[key];
  if (target === undefined) return undefined; // campo escalar/operador
  if (!reg.workspaceModels.has(target)) {
    throw new Error(
      `Travessia ${model}.${key} → ${target} sai do perímetro protegido — ` +
        `proteção multitenant bloqueou a operação. Consulte ${target} separadamente via prisma.raw (justificado).`,
    );
  }
  return target;
}

function assertSafeSelection(reg: ComposedRegistry, model: string, selection: unknown): void {
  if (!isPlainObject(selection)) return;
  for (const [key, value] of Object.entries(selection)) {
    if (key === '_count') {
      // _count.select conta relações do MESMO modelo — validar como relações
      if (isPlainObject(value) && isPlainObject(value.select)) {
        for (const countKey of Object.keys(value.select)) {
          assertSafeTraversal(reg, model, countKey);
        }
      }
      continue;
    }
    const target = assertSafeTraversal(reg, model, key);
    if (target && isPlainObject(value)) {
      assertSafeSelection(reg, target, value.include);
      assertSafeSelection(reg, target, value.select);
      assertSafeWhere(reg, target, value.where);
      assertSafeOrderBy(reg, target, value.orderBy);
    }
  }
}

function assertSafeWhere(reg: ComposedRegistry, model: string, where: unknown): void {
  if (Array.isArray(where)) {
    for (const w of where) assertSafeWhere(reg, model, w);
    return;
  }
  if (!isPlainObject(where)) return;
  for (const [key, value] of Object.entries(where)) {
    if (WHERE_LOGICAL_KEYS.has(key)) {
      assertSafeWhere(reg, model, value);
      continue;
    }
    const target = assertSafeTraversal(reg, model, key);
    if (!target) continue;
    // filtro de relação protegida: recursar (desembrulhando some/every/none/is/isNot)
    if (isPlainObject(value)) {
      for (const [wrapKey, wrapValue] of Object.entries(value)) {
        if (RELATION_FILTER_WRAPPERS.has(wrapKey)) {
          assertSafeWhere(reg, target, wrapValue);
        }
      }
      assertSafeWhere(reg, target, value);
    }
  }
}

function assertSafeOrderBy(reg: ComposedRegistry, model: string, orderBy: unknown): void {
  if (Array.isArray(orderBy)) {
    for (const o of orderBy) assertSafeOrderBy(reg, model, o);
    return;
  }
  if (!isPlainObject(orderBy)) return;
  for (const [key, value] of Object.entries(orderBy)) {
    const target = assertSafeTraversal(reg, model, key);
    if (target) assertSafeOrderBy(reg, target, value);
  }
}

/**
 * Escrita em modelo protegido: (1) `workspaceId` explícito no data é rejeitado
 * quando diverge do CLS — mover linha de workspace é escalada de privilégio
 * (as FKs compostas com ON UPDATE CASCADE arrastariam as junções); (2) objetos
 * de relação no data (nested create/connect/update) não passam pelo hook e são
 * rejeitados — use as FKs escalares (userId, roleId).
 */
function assertSafeData(
  reg: ComposedRegistry,
  model: string,
  data: unknown,
  workspaceId: string,
): void {
  if (Array.isArray(data)) {
    for (const d of data) assertSafeData(reg, model, d, workspaceId);
    return;
  }
  if (!isPlainObject(data)) return;
  if ('workspaceId' in data && data.workspaceId !== workspaceId) {
    throw new Error(
      `workspaceId explícito no data de ${model} diverge do contexto — proteção multitenant bloqueou a operação.`,
    );
  }
  for (const key of Object.keys(data)) {
    const target = reg.relationTargets[model]?.[key];
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

export function createWorkspaceClient(
  base: PrismaClient,
  getWorkspaceId: () => unknown,
  reg: ComposedRegistry,
): PrismaClient {
  // O cast de volta para PrismaClient evita a inferência de tipos gigante do
  // $extends (que estoura a memória do tsc); o runtime não muda.
  return base.$extends({
    query: {
      // SQL cru ignora o filtro de workspace por definição — bloqueado no db.
      // Única exceção: os modelos de COORDENAÇÃO de restrição (ADR-047 adendos
      // 6 e 7), conferidos pelo texto — travas consultivas, prazos de sessão,
      // prova de vida e o SAVEPOINT da guarda, nenhum lendo dado de tenant. Vai
      // ao banco o SQL reconstruído do modelo, nunca o objeto recebido. Os
      // `Unsafe` nunca passam.
      $queryRaw: ({ args, query }) => {
        const sql = sqlDeCoordenacao(args);
        return sql ? query(sql as never) : blockedRaw('$queryRaw');
      },
      $queryRawUnsafe: () => blockedRaw('$queryRawUnsafe'),
      $executeRaw: ({ args, query }) => {
        const sql = sqlDeCoordenacao(args);
        return sql ? query(sql as never) : blockedRaw('$executeRaw');
      },
      $executeRawUnsafe: () => blockedRaw('$executeRawUnsafe'),
      // SQL tipado também é cru: bloqueado mesmo que a preview seja ligada um dia
      // (o tipo do hook só existe com a preview; o runtime aceita a chave)
      ...({ $queryRawTyped: () => blockedRaw('$queryRawTyped') } as object),
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // Fail-closed nos DOIS sentidos: modelo fora do registro composto não é
          // "livre", é PROIBIDO no db — identidade global e catálogos só via raw.
          if (!model || !reg.workspaceModels.has(model)) {
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

          // append-only: histórico não se reescreve nem se apaga por aqui
          if (reg.appendOnlyModels.has(model) && MUTATING_OPERATIONS.has(operation)) {
            throw new Error(
              `${model} é append-only: ${operation} é proibido. Exclusão só por cascade do dono ` +
                `(LGPD) ou pelo job de retenção (prisma.raw justificado).`,
            );
          }

          // clona: o hook nunca muta o objeto args do chamador
          const a = { ...((args ?? {}) as Record<string, unknown>) };

          assertSafeSelection(reg, model, a.include);
          assertSafeSelection(reg, model, a.select);
          assertSafeWhere(reg, model, a.where);
          assertSafeOrderBy(reg, model, a.orderBy);

          switch (operation) {
            case 'create':
              assertSafeData(reg, model, a.data, workspaceId);
              a.data = { ...(a.data as object), workspaceId };
              break;
            case 'createMany':
            case 'createManyAndReturn': {
              assertSafeData(reg, model, a.data, workspaceId);
              const data = a.data;
              a.data = Array.isArray(data)
                ? data.map((d) => ({ ...(d as object), workspaceId }))
                : { ...(data as object), workspaceId };
              break;
            }
            case 'updateMany':
            case 'updateManyAndReturn':
              assertSafeData(reg, model, a.data, workspaceId);
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
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    private readonly cls: ClsService,
    /**
     * Registro COMPOSTO (Core ∪ extensões, ADR-047 E1). Ausente = Core puro: um
     * modelo de extensão não composto continua PROIBIDO no db, nunca liberado.
     */
    @Optional() @Inject(EXTENSION_REGISTRY) registry: ComposedRegistry = CORE_REGISTRY,
  ) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL ausente — o PrismaService não pode iniciar.');
    }
    this.raw = new PrismaClient({ adapter: prismaAdapter(process.env.DATABASE_URL) });
    // db estende o MESMO client (um pool só; transações compartilham conexão)
    this.db = createWorkspaceClient(this.raw, () => this.cls.get('workspaceId'), registry);
  }

  async onModuleInit() {
    await this.raw.$connect();
    // Confere a fixação de UTC (ADR-049): um pooler que descarte parâmetros de
    // sessão a perderia sem aviso. A conexão do Prisma é preguiçosa e o boot
    // NUNCA dependeu do banco (o e2e sobe a API antes de criar o banco; em
    // staging o banco sobe antes). Então: banco fora do ar ou inexistente NÃO
    // derruba a subida — só se registra; banco alcançável fora de UTC, sim.
    let TimeZone: string;
    try {
      [{ TimeZone }] = await this.raw.$queryRawUnsafe<{ TimeZone: string }[]>('SHOW TimeZone');
    } catch (error) {
      // o código (do Prisma ou o SQLSTATE) não é segredo e diz o que houve
      const erro = error as {
        code?: string;
        meta?: { driverAdapterError?: { cause?: { originalCode?: string } } };
      };
      const codigo =
        erro.meta?.driverAdapterError?.cause?.originalCode ?? erro.code ?? 'sem código';
      this.logger.warn(
        `Fuso da sessão não conferido no boot: o banco não respondeu (${
          error instanceof Error ? error.name : 'erro desconhecido'
        }, ${codigo}). A fixação vai na URL de cada conexão nova.`,
      );
      return;
    }
    if (TimeZone !== 'UTC') {
      throw new Error(
        `Sessão do banco em "${TimeZone}", não em UTC (ADR-049): a fixação vai na URL, então ` +
          'algo no caminho a descartou — confira se há um pooler que não repassa parâmetros de ' +
          'sessão (ex.: PgBouncer em modo transação).',
      );
    }
  }

  async onModuleDestroy() {
    await this.raw.$disconnect();
  }
}

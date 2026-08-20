import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  AutomationCondition,
  AutomationDto,
  AutomationExecutionDto,
  CreateAutomationInput,
  CreateTaskConfig,
  UpdateAutomationInput,
} from '@veyra/contracts';
import { createTaskConfigSchema } from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/decorators';
import { MAX_ATTEMPTS, OUTBOX_EVENTS, type ClaimedEvent } from '../outbox/outbox.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * Teto de PROFUNDIDADE da cadeia (ADR-035). Baixo de propósito: cadeia legítima
 * mais longa que isto é sinal de modelagem errada, não de necessidade.
 */
export const MAX_CHAIN_DEPTH = 3;

/**
 * Campos condicionáveis por gatilho, derivados da ALLOWLIST DE PAYLOAD do
 * próprio evento (fonte única). Sem isto, `field` aceitaria qualquer string e a
 * condição leria `undefined` para sempre — uma automação silenciosamente
 * inválida, que é pior que uma recusada: parece configurada e nunca dispara.
 */
export function allowedFieldsFor(trigger: string): string[] {
  const schema = (OUTBOX_EVENTS as Record<string, unknown>)[trigger];
  const shape = (schema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return shape ? Object.keys(shape) : [];
}

type AutomationRow = {
  id: string;
  name: string;
  trigger: string;
  conditions: unknown;
  action: 'create_task';
  actionConfig: unknown;
  enabled: boolean;
  createdAt: Date;
};

@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(): Promise<AutomationDto[]> {
    const rows = (await this.prisma.db.automation.findMany({
      orderBy: { createdAt: 'asc' },
    })) as unknown as AutomationRow[];
    return rows.map((row) => this.toDto(row));
  }

  async create(auth: AuthContext, input: CreateAutomationInput): Promise<AutomationDto> {
    this.assertConditionFields(input.trigger, input.conditions);
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const created = await tx.automation.create({
        data: {
          name: input.name,
          trigger: input.trigger,
          conditions: input.conditions as object,
          action: input.action,
          actionConfig: input.actionConfig as object,
          enabled: input.enabled,
        },
      } as never);
      const automationId = (created as unknown as { id: string }).id;
      await this.audit.record(tx, auth.workspaceId as string, 'automation.created', {
        entityType: 'automation',
        entityId: automationId,
        actor: this.audit.actorFrom(auth),
        after: { name: input.name, trigger: input.trigger, enabled: input.enabled },
      });
      return automationId;
    });
    return this.get(id);
  }

  async get(id: string): Promise<AutomationDto> {
    const row = (await this.prisma.db.automation.findFirst({
      where: { id },
    })) as unknown as AutomationRow | null;
    if (!row) throw new NotFoundException('Automação não encontrada');
    return this.toDto(row);
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateAutomationInput,
  ): Promise<AutomationDto> {
    const existing = (await this.prisma.db.automation.findFirst({
      where: { id },
    })) as unknown as AutomationRow | null;
    if (!existing) throw new NotFoundException('Automação não encontrada');
    if (input.conditions) this.assertConditionFields(existing.trigger, input.conditions);
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.automation.updateMany({
        where: { id },
        data: {
          name: input.name,
          conditions: input.conditions as object | undefined,
          actionConfig: input.actionConfig as object | undefined,
          enabled: input.enabled,
        },
      });
      await this.audit.record(tx, auth.workspaceId as string, 'automation.updated', {
        entityType: 'automation',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { name: existing.name, enabled: existing.enabled },
        after: { name: input.name, enabled: input.enabled },
      });
    });
    return this.get(id);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.automation.findFirst({
      where: { id },
    })) as unknown as AutomationRow | null;
    if (!existing) throw new NotFoundException('Automação não encontrada');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await this.audit.record(tx, auth.workspaceId as string, 'automation.deleted', {
        entityType: 'automation',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { name: existing.name, trigger: existing.trigger },
        after: null,
      });
      // excluir automação NÃO pode levar eventos de domínio embora: a coluna de
      // causalidade é anulada antes (a FK é NoAction justamente para isso)
      await tx.outboxEvent.updateMany({
        where: { originAutomationId: id },
        data: { originAutomationId: null },
      });
      await tx.automation.deleteMany({ where: { id } });
    });
  }

  async listExecutions(limit: number): Promise<AutomationExecutionDto[]> {
    const rows = (await this.prisma.db.automationExecution.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    } as never)) as unknown as {
      id: string;
      automationId: string;
      outboxEventId: string;
      status: 'executed' | 'skipped' | 'failed';
      reason: string | null;
      createdAt: Date;
    }[];
    const names = new Map(
      (
        (await this.prisma.db.automation.findMany({
          select: { id: true, name: true },
        })) as unknown as { id: string; name: string }[]
      ).map((row) => [row.id, row.name]),
    );
    return rows.map((row) => ({
      id: row.id,
      automationId: row.automationId,
      automationName: names.get(row.automationId) ?? '—',
      outboxEventId: row.outboxEventId,
      status: row.status,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  // ── Execução (chamada pelo dispatcher, ANTES dos webhooks) ────────────────

  /**
   * Roda as automações inscritas no evento. Chamado pelo dispatcher ANTES da
   * entrega de webhooks (ADR-035): uma ação de automação pode gerar dados que
   * o webhook deveria ver.
   *
   * `raw` justificado: o worker é cross-workspace, com workspaceId explícito.
   */
  async runForEvent(event: ClaimedEvent): Promise<void> {
    // TETO DA CADEIA: chegou no limite, não continua e deixa rastro
    if (event.depth >= MAX_CHAIN_DEPTH) {
      await this.recordChainCap(event);
      return;
    }

    const automations = await this.prisma.raw.automation.findMany({
      where: {
        workspaceId: event.workspaceId,
        trigger: event.eventType,
        enabled: true,
      },
    });

    const falhas: string[] = [];
    for (const automation of automations) {
      // AUTO-RETRIGGER: evento que ESTA automação originou não a reativa.
      // Sozinha, esta defesa não impede duas automações em ping-pong — é por
      // isso que o teto de profundidade também existe.
      if (event.originAutomationId === automation.id) continue;

      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const conditions = (automation.conditions ?? []) as AutomationCondition[];
      const matches = conditions.every((condition) => this.matches(condition, payload));

      try {
        await this.execute(event, automation.id, automation.actionConfig, payload, matches);
      } catch (error) {
        // uma automação com defeito não impede as OUTRAS de rodar…
        this.logger.error(
          `Automação ${automation.id} falhou no evento ${event.id} (${(error as Error).name})`,
        );
        falhas.push(automation.id);
        // …mas na ÚLTIMA tentativa o fracasso fica visível no histórico. Antes
        // disso, nada é gravado: uma linha de execução ocuparia o unique e
        // impediria a nova tentativa de fazer a ação.
        if (event.attempts >= MAX_ATTEMPTS) {
          await this.recordExecution(event, automation.id, 'failed', 'action_error');
        }
      }
    }

    // PROPAGA a falha: o dispatcher devolve o evento ao outbox, que tenta de
    // novo com backoff. Engolir aqui significava zero tarefa criada e nenhuma
    // nova tentativa — a falha transitória virava perda silenciosa. As
    // execuções que já deram certo seguem protegidas pelo unique.
    if (falhas.length > 0) {
      throw new Error(`Automação(ões) falharam no evento ${event.id}: ${falhas.join(', ')}`);
    }
  }

  /**
   * Ação + registro de execução na MESMA transação. O unique
   * (automationId, outboxEventId) é o que torna a reentrega do outbox
   * inofensiva: a segunda tentativa colide e nada roda de novo.
   */
  private async execute(
    event: ClaimedEvent,
    automationId: string,
    rawConfig: unknown,
    payload: Record<string, unknown>,
    matches: boolean,
  ): Promise<void> {
    await this.prisma.raw.$transaction(async (tx) => {
      try {
        await tx.automationExecution.create({
          data: {
            workspaceId: event.workspaceId,
            automationId,
            outboxEventId: event.id,
            status: matches ? 'executed' : 'skipped',
            reason: matches ? null : 'conditions_not_met',
          },
        });
      } catch (error) {
        // já executada para este evento: reentrega não repete a ação
        if ((error as { code?: string }).code === 'P2002') return;
        throw error;
      }
      if (!matches) return;

      const config = createTaskConfigSchema.parse(rawConfig);
      const dueAt = new Date(Date.now() + config.dueInDays * 24 * 60 * 60 * 1000);
      const title = this.renderTitle(config.title, payload);
      const taskId = await this.tasks.createWithin(
        tx as unknown as Db,
        event.workspaceId,
        {
          title,
          dueAt: dueAt.toISOString(),
          contactId:
            typeof payload.id === 'string' && event.eventType.startsWith('contact.')
              ? payload.id
              : undefined,
          priority: 'normal',
        },
        // ator SYSTEM: automação não é pessoa nem IA. `user` com membership
        // nula fazia a timeline mentir sobre quem agiu.
        { type: 'system', membershipId: null },
        {
          chainId: event.chainId ?? event.id,
          depth: event.depth + 1,
          originAutomationId: automationId,
        },
      );

      // a trilha diz QUAL automação agiu (actorId) e sobre o que
      await this.audit.record(
        tx as unknown as Db,
        event.workspaceId,
        'task.created_by_automation',
        {
          entityType: 'task',
          entityId: taskId,
          actor: { type: 'system', id: automationId },
          after: { title, status: 'open' },
        },
      );
    });
  }

  private async recordChainCap(event: ClaimedEvent): Promise<void> {
    this.logger.warn(
      `Cadeia de automação atingiu profundidade ${event.depth} — encerrada (evento ${event.id})`,
    );
    await this.prisma.raw.auditLog.create({
      data: {
        workspaceId: event.workspaceId,
        action: 'automation.chain_capped',
        entityType: 'automation',
        entityId: event.originAutomationId ?? event.id,
        actorType: 'system',
        actorId: 'automation-runner',
        after: { depth: event.depth, chainId: event.chainId ?? event.id },
      },
    });
  }

  private async recordExecution(
    event: ClaimedEvent,
    automationId: string,
    status: 'executed' | 'skipped' | 'failed',
    reason: string | null,
  ): Promise<void> {
    await this.prisma.raw.automationExecution
      .create({
        data: {
          workspaceId: event.workspaceId,
          automationId,
          outboxEventId: event.id,
          status,
          reason,
        },
      })
      .catch(() => undefined); // registro de falha é best-effort
  }

  /**
   * O catálogo só é FECHADO de verdade se o campo também for: operador restrito
   * com campo livre ainda permite condição que nunca casa.
   */
  private assertConditionFields(trigger: string, conditions: AutomationCondition[]): void {
    const allowed = allowedFieldsFor(trigger);
    const invalido = conditions.find((condition) => !allowed.includes(condition.field));
    if (invalido) {
      throw new BadRequestException(
        `Campo "${invalido.field}" não existe no evento ${trigger}. Disponíveis: ${allowed.join(', ')}`,
      );
    }
  }

  /** Predicado DECLARADO — nada de expressão avaliada. */
  private matches(condition: AutomationCondition, payload: Record<string, unknown>): boolean {
    const actual = payload[condition.field];
    switch (condition.op) {
      case 'equals':
        return String(actual) === String(condition.value);
      case 'contains':
        return String(actual ?? '')
          .toLowerCase()
          .includes(String(condition.value).toLowerCase());
      case 'gt':
        return Number(actual) > Number(condition.value);
      case 'lt':
        return Number(actual) < Number(condition.value);
      default:
        return false;
    }
  }

  /** Substituição simples de marcadores — sem template engine, por segurança. */
  private renderTitle(template: string, payload: Record<string, unknown>): string {
    return template
      .replace(/\{\{name\}\}/g, String(payload.name ?? ''))
      .replace(/\{\{title\}\}/g, String(payload.title ?? ''))
      .slice(0, 120)
      .trim();
  }

  private toDto(row: AutomationRow): AutomationDto {
    return {
      id: row.id,
      name: row.name,
      trigger: row.trigger as AutomationDto['trigger'],
      conditions: (row.conditions ?? []) as AutomationCondition[],
      action: row.action,
      actionConfig: row.actionConfig as CreateTaskConfig,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

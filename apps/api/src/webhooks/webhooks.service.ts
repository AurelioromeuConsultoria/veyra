import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CreateWebhookInput, UpdateWebhookInput, WebhookDto } from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/decorators';
import { CryptoService } from '../common/crypto.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { MAX_ATTEMPTS, OutboxService, type ClaimedEvent } from '../outbox/outbox.service';
import { UnsafeUrlError, assertSafeWebhookUrl, type SafeFetchResult } from './safe-http';

/**
 * TRANSPORTE INJETÁVEL (test seam, padrão do ADR-011 do Norteie): produção usa
 * `safePost` (https.request com IP pinado); testes de integração injetam um
 * fake, para que a suíte não dependa de DNS/rede real — a defesa SSRF em si é
 * coberta pelos testes unitários de `safe-http`.
 */
export const WEBHOOK_TRANSPORT = Symbol('WEBHOOK_TRANSPORT');
export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<SafeFetchResult>;

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/** 3 ENTREGAS MORTAS consecutivas pausam o webhook (ajuste #7). */
const DEAD_DELIVERIES_TO_PAUSE = 3;

/**
 * Teto de destinos por workspace. O fan-out é sequencial, então ele limita a
 * pior entrega possível (20 × 5s de timeout = 100s) bem abaixo do lease de
 * 5min — junto com o heartbeat, nenhum evento perde a posse por lentidão.
 */
const MAX_WEBHOOKS_PER_WORKSPACE = 20;

type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  status: 'active' | 'paused' | 'disabled';
  failureCount: number;
  secretCipher: string;
  createdAt: Date;
};

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
  ) {}

  async list(): Promise<WebhookDto[]> {
    const rows = (await this.prisma.db.webhook.findMany({
      orderBy: { createdAt: 'asc' },
    })) as unknown as WebhookRow[];
    return rows.map((row) => this.toDto(row));
  }

  /** O segredo é retornado UMA única vez, na criação (padrão do convite Owner). */
  async create(
    auth: AuthContext,
    input: CreateWebhookInput,
  ): Promise<WebhookDto & { secret: string }> {
    try {
      assertSafeWebhookUrl(input.url);
    } catch (error) {
      throw new BadRequestException(
        error instanceof UnsafeUrlError ? error.message : 'URL inválida',
      );
    }
    const existing = await this.prisma.db.webhook.count();
    if (existing >= MAX_WEBHOOKS_PER_WORKSPACE) {
      throw new BadRequestException(
        `Limite de ${MAX_WEBHOOKS_PER_WORKSPACE} webhooks por workspace atingido`,
      );
    }
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const db = this.prisma.db as unknown as TxRunner;
    const id = await db.$transaction(async (tx) => {
      const webhook = await tx.webhook.create({
        data: {
          url: input.url,
          events: input.events,
          secretCipher: this.crypto.encrypt(secret),
        },
      } as never);
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.created', {
        entityType: 'webhook',
        entityId: webhook.id,
        actor: this.audit.actorFrom(auth),
        after: { url: input.url, events: input.events, status: 'active' },
      });
      return webhook.id;
    });
    const row = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow;
    return { ...this.toDto(row), secret };
  }

  async update(auth: AuthContext, id: string, input: UpdateWebhookInput): Promise<WebhookDto> {
    const existing = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow | null;
    if (!existing) throw new NotFoundException('Webhook não encontrado');
    if (input.url) {
      try {
        assertSafeWebhookUrl(input.url);
      } catch (error) {
        throw new BadRequestException(
          error instanceof UnsafeUrlError ? error.message : 'URL inválida',
        );
      }
    }
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await tx.webhook.updateMany({
        where: { id },
        data: {
          url: input.url,
          events: input.events,
          status: input.status,
          // reativar manualmente zera o contador de entregas mortas
          failureCount: input.status === 'active' ? 0 : undefined,
        },
      });
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.updated', {
        entityType: 'webhook',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { url: existing.url, events: existing.events, status: existing.status },
        after: { url: input.url, events: input.events, status: input.status },
      });
    });
    const row = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow;
    return this.toDto(row);
  }

  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.webhook.findFirst({
      where: { id },
    })) as unknown as WebhookRow | null;
    if (!existing) throw new NotFoundException('Webhook não encontrado');
    const db = this.prisma.db as unknown as TxRunner;
    await db.$transaction(async (tx) => {
      await this.audit.record(tx, auth.workspaceId as string, 'webhook.deleted', {
        entityType: 'webhook',
        entityId: id,
        actor: this.audit.actorFrom(auth),
        before: { url: existing.url, status: existing.status },
        after: null,
      });
      await tx.webhook.deleteMany({ where: { id } });
    });
  }

  /** Assinatura: t=<ts>,v1=HMAC_SHA256(secret, `${ts}.${body}`) — resiste a replay. */
  sign(secret: string, timestamp: number, body: string): string {
    const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${mac}`;
  }

  /** Exposto para teste/documentação do consumidor. */
  verify(secret: string, header: string, body: string, toleranceSec = 300): boolean {
    const ts = Number(/t=(\d+)/.exec(header)?.[1]);
    const mac = /v1=([0-9a-f]+)/.exec(header)?.[1];
    if (!ts || !mac) return false;
    if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
    const expected = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Entrega um evento do outbox aos webhooks ativos inscritos. Chamado pelo
   * worker; `raw` justificado (cross-workspace, com workspaceId explícito).
   */
  async deliver(event: ClaimedEvent): Promise<void> {
    const webhooks = await this.prisma.raw.webhook.findMany({
      where: {
        workspaceId: event.workspaceId,
        status: 'active',
        events: { has: event.eventType },
      },
    });
    if (webhooks.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken); // ninguém inscrito
      return;
    }

    // RETRY PARCIAL (correção do P1): quem já recebeu ESTE outboxEventId com
    // sucesso não é reentregue — o retry existe para os que falharam. Sem isso,
    // uma falha parcial duplicaria a entrega nos destinos saudáveis a cada
    // tentativa.
    const alreadyDelivered = await this.prisma.raw.webhookDelivery.findMany({
      where: {
        workspaceId: event.workspaceId,
        outboxEventId: event.id,
        error: null,
        responseStatus: { gte: 200, lt: 300 },
      },
      select: { webhookId: true },
    });
    const deliveredIds = new Set(alreadyDelivered.map((row) => row.webhookId));
    const pendingWebhooks = webhooks.filter((webhook) => !deliveredIds.has(webhook.id));
    if (pendingWebhooks.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken); // todos já receberam
      return;
    }

    const body = JSON.stringify({
      id: event.id,
      type: event.eventType,
      createdAt: new Date().toISOString(),
      data: event.payload,
    });
    const failures: string[] = [];
    const failedIds: string[] = [];
    const succeededIds: string[] = [];

    for (const webhook of pendingWebhooks) {
      // HEARTBEAT: fan-out longo pode ultrapassar o lease. Renovar antes de
      // cada destino mantém a posse; se já a perdemos, outro worker assumiu o
      // evento e continuar aqui duplicaria entregas — abandona sem concluir.
      if (!(await this.outbox.renewLease(event.id, event.claimToken))) {
        this.logger.warn(`Lease de ${event.id} perdido durante o fan-out — entrega abandonada`);
        return;
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const secret = this.crypto.decrypt(webhook.secretCipher);
      let status: number | null = null;
      let error: string | null = null;
      let durationMs = 0;
      try {
        const result = await this.transport(webhook.url, body, {
          'x-veyra-event': event.eventType,
          'x-veyra-delivery': event.id,
          'x-veyra-signature': this.sign(secret, timestamp, body),
        });
        status = result.status;
        durationMs = result.durationMs;
        if (status >= 400) error = `HTTP ${status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : 'falha desconhecida';
      }
      await this.prisma.raw.webhookDelivery.create({
        data: {
          workspaceId: event.workspaceId,
          webhookId: webhook.id,
          outboxEventId: event.id,
          attempt: event.attempts,
          responseStatus: status,
          error,
          durationMs,
        },
      });
      if (error) {
        failures.push(`${webhook.id}: ${error}`);
        failedIds.push(webhook.id);
      } else {
        succeededIds.push(webhook.id);
      }
    }

    // sucesso zera o contador de quem entregou, mesmo em lote parcialmente falho
    if (succeededIds.length > 0) {
      await this.prisma.raw.webhook.updateMany({
        where: { workspaceId: event.workspaceId, id: { in: succeededIds } },
        data: { failureCount: 0 },
      });
    }
    if (failures.length === 0) {
      await this.outbox.markDelivered(event.id, event.claimToken);
      return;
    }

    const outcome = await this.outbox.markFailed(
      event.id,
      event.claimToken,
      event.attempts,
      failures.join('; '),
    );
    if (outcome === 'dead') {
      // AJUSTE #7: só a ENTREGA MORTA conta — instabilidade curta (retries) não
      // pausa webhook. Três eventos mortos consecutivos → pause automático.
      // SÓ quem falhou é penalizado: um webhook saudável não pode ser pausado
      // porque OUTRO do mesmo workspace está fora do ar
      for (const webhookId of failedIds) {
        const updated = await this.prisma.raw.webhook.update({
          where: { id: webhookId },
          data: { failureCount: { increment: 1 } },
        });
        if (updated.failureCount >= DEAD_DELIVERIES_TO_PAUSE) {
          await this.prisma.raw.webhook.updateMany({
            where: { id: webhookId, workspaceId: event.workspaceId },
            data: { status: 'paused' },
          });
          this.logger.warn(
            `Webhook ${webhookId} pausado após ${updated.failureCount} entregas mortas`,
          );
        }
      }
    }
  }

  /** DTO nunca expõe o segredo (nem cifrado). */
  private toDto(row: WebhookRow): WebhookDto {
    return {
      id: row.id,
      url: row.url,
      events: row.events,
      status: row.status,
      failureCount: row.failureCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export { MAX_ATTEMPTS };

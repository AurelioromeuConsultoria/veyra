import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss } from 'pg-boss';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { INTERNAL_EVENT_TYPES, OutboxService } from '../outbox/outbox.service';
import { WebhooksService } from '../webhooks/webhooks.service';

const OUTBOX_QUEUE = 'outbox-dispatch';
const RETENTION_QUEUE = 'audit-retention';

/**
 * Jobs no MESMO Postgres (pg-boss, ADR-007). Kill switch: DISABLE_JOBS.
 * Em NODE_ENV=test o worker NÃO sobe — as suítes chamam dispatchPending()
 * explicitamente, sem depender de timing.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private boss: PgBoss | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly outbox: OutboxService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  async onModuleInit(): Promise<void> {
    const disabled =
      this.config.get<boolean>('DISABLE_JOBS') === true ||
      this.config.get<string>('NODE_ENV') === 'test';
    if (disabled) {
      this.logger.log('Jobs desabilitados (DISABLE_JOBS ou NODE_ENV=test)');
      return;
    }
    this.boss = new PgBoss({ connectionString: process.env.DATABASE_URL as string });
    await this.boss.start();

    await this.boss.createQueue(OUTBOX_QUEUE);
    await this.boss.work(OUTBOX_QUEUE, async () => {
      await this.dispatchPending();
    });
    await this.boss.schedule(OUTBOX_QUEUE, '* * * * *', {}, { tz: 'America/Sao_Paulo' });

    await this.boss.createQueue(RETENTION_QUEUE);
    await this.boss.work(RETENTION_QUEUE, async () => {
      const days = this.config.getOrThrow<number>('AUDIT_RETENTION_DAYS');
      const purged = await this.audit.purgeOlderThan(days);
      if (purged > 0) this.logger.log(`Retenção: ${purged} registros de auditoria expurgados`);
    });
    await this.boss.schedule(RETENTION_QUEUE, '0 4 * * *', {}, { tz: 'America/Sao_Paulo' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  /**
   * Um ciclo de entrega do outbox. Público: o worker chama por agendamento e
   * os testes chamam direto (sem esperar cron).
   */
  async dispatchPending(limit = 20): Promise<{ delivered: number; failed: number }> {
    const batch = await this.outbox.claimBatch(limit);
    let delivered = 0;
    let failed = 0;
    for (const event of batch) {
      try {
        if (INTERNAL_EVENT_TYPES.has(event.eventType)) {
          // trabalho interno da plataforma: NUNCA vai para webhook de cliente
          await this.handleInternal(event);
        } else {
          await this.webhooks.deliver(event);
        }
        delivered += 1;
      } catch (error) {
        failed += 1;
        // falha do próprio dispatcher (não da entrega): reagenda com backoff
        await this.outbox.markFailed(
          event.id,
          event.claimToken,
          event.attempts,
          error instanceof Error ? error.message : 'erro no dispatcher',
        );
      }
    }
    return { delivered, failed };
  }

  /**
   * Handler dos eventos internos. Hoje só `file.purge`: apaga os bytes depois
   * que a linha já saiu do banco (ADR-024), com o lease/fencing do outbox
   * garantindo que um worker lento não apague o arquivo de outra tentativa.
   */
  private async handleInternal(event: {
    id: string;
    eventType: string;
    payload: unknown;
    claimToken: string;
  }): Promise<void> {
    if (event.eventType === 'file.purge') {
      const { key } = event.payload as { key: string };
      await this.files.purge(key);
    }
    await this.outbox.markDelivered(event.id, event.claimToken);
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgBoss } from 'pg-boss';
import { AuditService } from '../audit/audit.service';
import { AutomationsService } from '../automations/automations.service';
import { MediaCollectorService } from '../channels/media-collector.service';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { FilesService } from '../files/files.service';
import { UsageService } from '../usage/usage.service';
import { INTERNAL_EVENT_TYPES, OutboxService, type ClaimedEvent } from '../outbox/outbox.service';
import { WebhooksService } from '../webhooks/webhooks.service';

const OUTBOX_QUEUE = 'outbox-dispatch';
const RETENTION_QUEUE = 'audit-retention';
const RESERVATION_QUEUE = 'usage-reservations';
const DISPATCH_REAP_QUEUE = 'dispatch-reap';
const MEDIA_QUEUE = 'inbound-media';

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
    private readonly usage: UsageService,
    private readonly automations: AutomationsService,
    private readonly whatsappSend: WhatsappSendService,
    private readonly mediaCollector: MediaCollectorService,
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

    // reservas órfãs (processo morto entre reservar e liquidar) devolvem
    // orçamento — sem isso o teto encolheria silenciosamente (ADR-033)
    await this.boss.createQueue(RESERVATION_QUEUE);
    await this.boss.work(RESERVATION_QUEUE, async () => {
      await this.usage.purgeExpiredReservations();
    });
    await this.boss.schedule(RESERVATION_QUEUE, '*/5 * * * *', {}, { tz: 'America/Sao_Paulo' });

    // coleta de mídia recebida: varredura, não evento (ADR-037)
    await this.boss.createQueue(MEDIA_QUEUE);
    await this.boss.work(MEDIA_QUEUE, async () => {
      await this.mediaCollector.collectPending();
    });
    await this.boss.schedule(MEDIA_QUEUE, '* * * * *', {}, { tz: 'America/Sao_Paulo' });

    /**
     * Dispatches abandonados em voo: worker morto de forma que nem o dispatcher
     * do outbox percebeu (exceção entre o claim e a conclusão, processo morto).
     * Sem esta varredura a linha ficaria `sending` para sempre e a mensagem
     * desapareceria em silêncio — com a reserva presa junto (ADR-039).
     */
    await this.boss.createQueue(DISPATCH_REAP_QUEUE);
    await this.boss.work(DISPATCH_REAP_QUEUE, async () => {
      await this.whatsappSend.reapStaleDispatches();
    });
    await this.boss.schedule(DISPATCH_REAP_QUEUE, '*/5 * * * *', {}, { tz: 'America/Sao_Paulo' });
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
          // automações ANTES dos webhooks (ADR-035): a ação pode gerar dado
          // que o webhook deveria ver. Reentrega reaproveita a execução
          // idempotente, então rodar de novo aqui é inofensivo.
          await this.automations.runForEvent(event);
          await this.webhooks.deliver(event);
        }
        delivered += 1;
      } catch (error) {
        failed += 1;
        // falha do próprio dispatcher (não da entrega): reagenda com backoff.
        // Logar aqui é essencial — sem isso o motivo do reagendamento fica
        // invisível e só aparece como "evento parado em pending".
        this.logger.error(
          `Dispatcher falhou no evento ${event.id} (${event.eventType}): ${
            error instanceof Error ? error.message.slice(0, 300) : 'desconhecido'
          }`,
        );
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
  private async handleInternal(event: ClaimedEvent): Promise<void> {
    if (event.eventType === 'file.purge') {
      const { key } = event.payload as { key: string };
      await this.files.purge(key);
    }
    if (event.eventType === 'whatsapp.send_pending') {
      const resultado = await this.whatsappSend.dispatch(event);
      if (resultado === 'retry') {
        // falha transitória ANTES do envio: devolve ao outbox com backoff
        const desfecho = await this.outbox.markFailed(
          event.id,
          event.claimToken,
          event.attempts,
          'envio recusado antes do despacho (transitório)',
        );
        if (desfecho === 'dead') {
          /**
           * SOMENTE `dead` (tentativas esgotadas): não haverá nova tentativa, e
           * deixar o dispatch em `failed_before_send` seria um estado que MENTE
           * — o nome promete retentativa que não vem.
           *
           * `lost` é o oposto: outro worker assumiu o evento e VAI tentar.
           * Encerrar aqui mataria uma entrega viva.
           */
          const { messageId } = event.payload as { messageId: string };
          await this.whatsappSend.markExhausted(event.workspaceId, messageId);
        }
        return;
      }
    }
    await this.outbox.markDelivered(event.id, event.claimToken);
  }
}

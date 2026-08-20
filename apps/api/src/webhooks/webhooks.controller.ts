import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookDeliveryDto,
  WebhookDto,
  createWebhookSchema,
  updateWebhookSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly prisma: PrismaService,
  ) {}

  @RequirePermissions('webhooks:manage')
  @Get()
  list(): Promise<WebhookDto[]> {
    return this.webhooks.list();
  }

  /** Resposta traz o segredo UMA única vez — depois só o cifrado existe. */
  @RequirePermissions('webhooks:manage')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createWebhookSchema)) body: CreateWebhookInput,
  ): Promise<WebhookDto & { secret: string }> {
    return this.webhooks.create(auth, body);
  }

  @RequirePermissions('webhooks:manage')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(updateWebhookSchema)) body: UpdateWebhookInput,
  ): Promise<WebhookDto> {
    return this.webhooks.update(auth, id, body);
  }

  @RequirePermissions('webhooks:manage')
  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.webhooks.remove(auth, id);
    return { ok: true };
  }

  @RequirePermissions('webhooks:manage')
  @Get(':id/deliveries')
  async deliveries(@Param('id', new ParseUUIDPipe()) id: string): Promise<WebhookDeliveryDto[]> {
    const rows = await this.prisma.db.webhookDelivery.findMany({
      where: { webhookId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      outboxEventId: row.outboxEventId,
      attempt: row.attempt,
      responseStatus: row.responseStatus,
      error: row.error,
      durationMs: row.durationMs,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

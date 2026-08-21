import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { ChannelsModule } from '../channels/channels.module';
import { OutboxModule } from '../outbox/outbox.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { JobsService } from './jobs.service';

@Module({
  imports: [AutomationsModule, ChannelsModule, OutboxModule, WebhooksModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}

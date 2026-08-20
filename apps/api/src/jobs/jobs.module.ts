import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { JobsService } from './jobs.service';

@Module({
  imports: [OutboxModule, WebhooksModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}

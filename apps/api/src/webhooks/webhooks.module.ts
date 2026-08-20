import { Module } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService, CryptoService],
  exports: [WebhooksService],
})
export class WebhooksModule {}

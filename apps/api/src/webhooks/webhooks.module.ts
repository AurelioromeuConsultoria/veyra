import { Module } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { safePost } from './safe-http';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOK_TRANSPORT, WebhooksService } from './webhooks.service';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhooksService,
    CryptoService,
    // produção: entrega real com pinning de IP (substituído por fake nos testes)
    { provide: WEBHOOK_TRANSPORT, useValue: safePost },
  ],
  exports: [WebhooksService],
})
export class WebhooksModule {}

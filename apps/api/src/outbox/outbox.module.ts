import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/** Global: services de domínio enfileiram dentro da própria transação. */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}

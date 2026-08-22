import { Module } from '@nestjs/common';
import { IntelligencePersistenceModule } from '../intelligence-persistence/intelligence-persistence.module';
import { AutomationsModule } from '../automations/automations.module';
import { ChannelsModule } from '../channels/channels.module';
import { OutboxModule } from '../outbox/outbox.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    AutomationsModule,
    ChannelsModule,
    // persistência da IA, NÃO o módulo de domínio: aquele importa conversas,
    // contatos, deals e tarefas, e o ciclo resultante fazia o Nest resolver
    // providers como `undefined` de forma não determinística
    IntelligencePersistenceModule,
    OutboxModule,
    WebhooksModule,
  ],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}

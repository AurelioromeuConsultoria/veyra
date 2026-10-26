import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { ConsentPurposesService } from './consent-purposes.service';
import { ConversationConsentReplayGuard } from './consent-replay.guard';
import { ConsentsController } from './consents.controller';
import { ConsentsService } from './consents.service';

/**
 * Finalidades, consentimentos e o pedido de parar (ADR-052 item 5, F4.1b). Depende
 * do canal (o pedido cancela os despachos não iniciados) e da conversa (a rota
 * pela conversa usa a visibilidade dela, C13). O caminho inverso — o envio
 * confere o bloqueio, quem tira número revoga — usa `consent-records.ts`, sem
 * importar este módulo.
 */
@Module({
  imports: [ChannelsModule, ConversationsModule],
  controllers: [ConsentsController],
  providers: [ConsentsService, ConsentPurposesService, ConversationConsentReplayGuard],
  // a CLI pega o serviço das finalidades pelo contexto (`app.get`): ele não sai
  // do módulo, porque resolve qualquer workspace pelo slug
  exports: [ConsentsService],
})
export class ConsentsModule {}

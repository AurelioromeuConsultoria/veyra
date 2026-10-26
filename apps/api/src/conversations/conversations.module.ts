import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { ContactsModule } from '../contacts/contacts.module';
import { IntelligencePersistenceModule } from '../intelligence-persistence/intelligence-persistence.module';
import { ConversationSenderService } from './conversation-sender.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

@Module({
  // o envio externo vive no módulo do canal (ADR-039). A identificação do
  // remetente (ADR-052 item 2) cria e edita contato e expira o conteúdo de IA
  // da conversa na própria transação
  imports: [
    forwardRef(() => ChannelsModule),
    AuthModule,
    ContactsModule,
    IntelligencePersistenceModule,
  ],
  controllers: [ConversationsController],
  providers: [ConversationsService, ConversationSenderService],
  exports: [ConversationsService],
})
export class ConversationsModule {}

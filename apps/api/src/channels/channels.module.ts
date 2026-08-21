import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/** Importa ContactsModule: a ingestão cria contato PELO DOMÍNIO (ADR-040). */
@Module({
  imports: [ContactsModule],
  controllers: [WhatsappController],
  providers: [WhatsappService],
  exports: [WhatsappService],
})
export class ChannelsModule {}

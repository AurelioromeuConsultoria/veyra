import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { CryptoService } from '../common/crypto.service';
import { FilesModule } from '../files/files.module';
import { UsageModule } from '../usage/usage.module';
import { GraphApiTransport, META_TRANSPORT } from './meta.transport';
import { MediaCollectorService } from './media-collector.service';
import { WhatsappSendService } from './whatsapp-send.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

/** Importa ContactsModule: a ingestão cria contato PELO DOMÍNIO (ADR-040). */
@Module({
  imports: [ContactsModule, UsageModule, FilesModule],
  controllers: [WhatsappController],
  providers: [
    WhatsappService,
    WhatsappSendService,
    MediaCollectorService,
    CryptoService,
    // transporte real em produção; os testes injetam um falso (ADR-039)
    { provide: META_TRANSPORT, useClass: GraphApiTransport },
  ],
  exports: [WhatsappService, WhatsappSendService, MediaCollectorService],
})
export class ChannelsModule {}

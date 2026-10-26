import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactsModule } from '../contacts/contacts.module';
import { CryptoService } from '../common/crypto.service';
import { FilesModule } from '../files/files.module';
import { UsageModule } from '../usage/usage.module';
import { FakeMetaTransport } from './fake.transport';
import { GraphApiTransport, META_TRANSPORT } from './meta.transport';
import { CancelamentoDeDespachos } from './dispatch-cancellation.service';
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
    CancelamentoDeDespachos,
    CryptoService,
    /**
     * Transporte real por padrão; o falso SÓ quando `META_TRANSPORT_MODE=fake`,
     * que a validação de ambiente recusa fora de staging (ADR-046). A escolha é
     * por FÁBRICA e não por classe para caber num provider único: dois
     * providers do mesmo símbolo se sobrescreveriam pela ordem do array, que é
     * o tipo de dependência de ordenação que ninguém enxerga em revisão.
     *
     * Os testes continuam injetando o próprio falso por override (ADR-039).
     */
    {
      provide: META_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        // o par é garantido por `validateEnv`; repeti-lo aqui é defesa em
        // profundidade barata — se um dia a validação afrouxar, o falso
        // continua inalcançável fora de staging
        config.get<string>('META_TRANSPORT_MODE') === 'fake' &&
        config.get<string>('VEYRA_ENV') === 'staging'
          ? new FakeMetaTransport()
          : new GraphApiTransport(config),
    },
  ],
  exports: [WhatsappService, WhatsappSendService, MediaCollectorService, CancelamentoDeDespachos],
})
export class ChannelsModule {}

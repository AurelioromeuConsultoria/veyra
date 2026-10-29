import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContactsModule } from '../contacts/contacts.module';
import { CryptoService } from '../common/crypto.service';
import { FilesModule } from '../files/files.module';
import { UsageModule } from '../usage/usage.module';
import { FakeMetaTransport, transporteSimulado } from './fake.transport';
import { GraphApiTransport, META_TRANSPORT } from './meta.transport';
import { catalogoDoAmbiente, META_TEMPLATE_CATALOG } from './meta-templates.catalog';
import { PortaDoEnvioDoNegocio } from './business-dispatch.port';
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
    PortaDoEnvioDoNegocio,
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
        transporteSimulado(config) ? new FakeMetaTransport() : new GraphApiTransport(config),
    },
    /**
     * O catálogo de templates (F4.1c-2), pela mesma escolha: o falso, só com o
     * transporte falso em staging, com os templates FICTÍCIOS da demonstração
     * na WABA fictícia (ADR-048 adendo 12); a Graph API em todo o resto. Os
     * testes injetam o falso deles, vazio, por override.
     */
    {
      provide: META_TEMPLATE_CATALOG,
      inject: [ConfigService],
      useFactory: catalogoDoAmbiente,
    },
  ],
  exports: [
    WhatsappService,
    WhatsappSendService,
    MediaCollectorService,
    CancelamentoDeDespachos,
    META_TEMPLATE_CATALOG,
    PortaDoEnvioDoNegocio,
  ],
})
export class ChannelsModule {}

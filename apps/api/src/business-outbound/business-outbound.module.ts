import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { TemplatesModule } from '../templates/templates.module';
import { EnvioDoNegocioController } from './business-outbound.controller';
import { EnvioDoNegocioService } from './business-outbound.service';
import { ConferenciaDoEnvio } from './conferencia';
import { VerificadorDoNegocio } from './verificador';

/**
 * O envio iniciado pelo negócio (ADR-052 itens 6 a 8, F4.1c-3): a prévia, a
 * aprovação e o verificador que o worker de envio chama pela porta de
 * `channels`. Importa `channels` e `templates`; nenhum dos dois importa este.
 */
@Module({
  imports: [ChannelsModule, TemplatesModule],
  controllers: [EnvioDoNegocioController],
  providers: [ConferenciaDoEnvio, EnvioDoNegocioService, VerificadorDoNegocio],
})
export class BusinessOutboundModule {}

import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CryptoService } from '../common/crypto.service';
import { TemplateReviewsService } from './template-reviews.service';
import { TemplateVersionsService } from './template-versions.service';
import { TemplatesController } from './templates.controller';

/**
 * Templates do WhatsApp versionados, revisados e relidos (ADR-052 item 4,
 * F4.1c-2). Depende do canal (a credencial cifrada e a porta do catálogo da
 * Meta) e da transação das mudanças do `content-use` (global: o `lock_timeout`
 * da revisão e da divergência); as finalidades são lidas pelo client
 * protegido, no workspace do contexto. Nenhum módulo do Core depende deste nesta subentrega: ligar as
 * versões ao envio é da F4.1c-3.
 */
@Module({
  imports: [ChannelsModule],
  controllers: [TemplatesController],
  providers: [TemplateVersionsService, TemplateReviewsService, CryptoService],
  // a CLI pega o serviço das versões pelo contexto (`app.get`); a F4.1c-3
  // usará a releitura dele
  exports: [TemplateVersionsService],
})
export class TemplatesModule {}

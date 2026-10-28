import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import {
  ApproveBusinessOutboundInput,
  BusinessOutboundPreviewDto,
  BusinessOutboundResultDto,
  PreviewBusinessOutboundInput,
  TemplateOptionDto,
  TemplateOptionsQuery,
  approveBusinessOutboundSchema,
  previewBusinessOutboundSchema,
  templateOptionsQuerySchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { Idempotent } from '../common/idempotency.decorator';
import { ZodPipe } from '../common/zod.pipe';
import { EnvioDoNegocioService } from './business-outbound.service';

/**
 * O envio iniciado pelo negócio (ADR-052 itens 6 a 8, F4.1c-3). As permissões
 * são as que já existem (recomendação da F4.1c-3, sem chave nova): escrever na
 * conversa, ler o contato — a prévia mostra o nome e o número — e ler os
 * consentimentos — ela revela a finalidade consentida.
 *
 * O lote EXIGE `Idempotency-Key` (400 sem ela), e a mesma chave com outro
 * lote dá 409, pelo interceptor do Core. A resposta guardada traz só ids,
 * estados e motivos, nunca a prévia; o replay confere de novo as permissões da
 * rota (os guards rodam antes do interceptor).
 */
@Controller('business-outbound')
export class EnvioDoNegocioController {
  constructor(private readonly envio: EnvioDoNegocioService) {}

  @RequirePermissions('conversations:write', 'contacts:read', 'consents:read')
  @Get('options')
  opcoes(
    @Query(new ZodPipe(templateOptionsQuerySchema)) query: TemplateOptionsQuery,
  ): Promise<TemplateOptionDto[]> {
    return this.envio.opcoes(query.conversationId);
  }

  @RequirePermissions('conversations:write', 'contacts:read', 'consents:read')
  @Post('preview')
  @HttpCode(200)
  previa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(previewBusinessOutboundSchema)) body: PreviewBusinessOutboundInput,
  ): Promise<BusinessOutboundPreviewDto> {
    // a rota genérica: só a origem do Core
    return this.envio.previa(auth, body, 'core');
  }

  @RequirePermissions('conversations:write', 'contacts:read', 'consents:read')
  @Idempotent({ required: true })
  @Post()
  @HttpCode(200)
  async aprovar(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(approveBusinessOutboundSchema)) body: ApproveBusinessOutboundInput,
  ): Promise<BusinessOutboundResultDto> {
    const { items } = await this.envio.aprovar(auth, body, 'core');
    // o texto renderizado nunca sai pela resposta guardada do lote
    return { items: items.map(({ texto: _texto, ...item }) => item) };
  }
}

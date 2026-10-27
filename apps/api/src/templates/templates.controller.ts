import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  CreateTemplateReviewInput,
  ListTemplateVersionsInput,
  TemplateReviewDto,
  TemplateVersionDto,
  createTemplateReviewSchema,
  listTemplateVersionsSchema,
} from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { TemplateReviewsService } from './template-reviews.service';
import { TemplateVersionsService } from './template-versions.service';

/**
 * As versões de template e a revisão (ADR-052 item 4, F4.1c-2), sob
 * `templates:review` (Owner e Admin por padrão). A tela é da F4.4; o envio que
 * usa a revisão, da F4.1c-3. A repetição da revisão é pela chave natural
 * (versão, finalidade): devolve a existente.
 */
@Controller('templates/versions')
export class TemplatesController {
  constructor(
    private readonly versoes: TemplateVersionsService,
    private readonly revisoes: TemplateReviewsService,
  ) {}

  @RequirePermissions('templates:review')
  @Get()
  list(
    @Query(new ZodPipe(listTemplateVersionsSchema)) query: ListTemplateVersionsInput,
  ): Promise<TemplateVersionDto[]> {
    return this.versoes.listar(query.channelId);
  }

  @RequirePermissions('templates:review')
  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<TemplateVersionDto> {
    return this.versoes.obter(id);
  }

  @RequirePermissions('templates:review')
  @Post(':id/reviews')
  review(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(createTemplateReviewSchema)) body: CreateTemplateReviewInput,
  ): Promise<TemplateReviewDto> {
    return this.revisoes.revisar(auth, id, body);
  }
}

import { ProtectedContentService } from '../extensions/protected-content';
import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { ActivityPageDto, ListActivitiesInput, listActivitiesSchema } from '@veyra/contracts';
import { PermissionsService } from '../auth/permissions.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { ActivitiesService } from './activities.service';

/**
 * Timeline é READ-ONLY por API: só os services de domínio escrevem (ADR-011).
 *
 * RBAC por ALVO: `contacts:read` é o piso (o decorator garante), mas a timeline
 * de oportunidade carrega valores (amountCents, título) — exige `pipelines:read`
 * também. Sem isso, um papel custom "só contatos" leria o histórico financeiro.
 */
@Controller('activities')
export class ActivitiesController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly permissions: PermissionsService,
    private readonly protegido: ProtectedContentService,
  ) {}

  @RequirePermissions('contacts:read')
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listActivitiesSchema)) query: ListActivitiesInput,
  ): Promise<ActivityPageDto> {
    if (query.dealId && !(await this.permissions.has(auth, 'pipelines:read'))) {
      throw new ForbiddenException('Permissão insuficiente');
    }
    return this.activities.list(
      { contactId: query.contactId, dealId: query.dealId },
      query.limit,
      query.cursor,
      // eventos de oportunidade só aparecem na timeline do contato para quem
      // pode ver pipeline — o filtro é aplicado na projeção
      {
        includeDealEvents: await this.permissions.has(auth, 'pipelines:read'),
        // as atividades de nota e tarefa de contato protegido (ADR-061, adendo 2)
        conteudoVisivel: await this.protegido.atividadeVisivel(auth),
        conteudoRestrito: await this.protegido.alvoOculto(auth, {
          contactId: query.contactId,
          dealId: query.dealId,
        }),
        // o título das oportunidades de contato oculto (adendo 5)
        titulosOcultos: (dealIds) => this.protegido.oportunidadesOcultas(auth, dealIds),
      },
    );
  }
}

import { Controller, Get, Query } from '@nestjs/common';
import { ActivityPageDto, ListActivitiesInput, listActivitiesSchema } from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { ActivitiesService } from './activities.service';

/** Timeline é READ-ONLY por API: só os services de domínio escrevem (ADR-011). */
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @RequirePermissions('contacts:read')
  @Get()
  list(
    @Query(new ZodPipe(listActivitiesSchema)) query: ListActivitiesInput,
  ): Promise<ActivityPageDto> {
    return this.activities.list(
      { contactId: query.contactId, dealId: query.dealId },
      query.limit,
      query.cursor,
    );
  }
}

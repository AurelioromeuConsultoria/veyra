import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  clinicsNoShowQuerySchema,
  type ClinicsNoShowDto,
  type ClinicsNoShowQuery,
} from '@veyra/contracts/verticals/clinics';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsNoShowService } from './clinics-no-show.service';

/**
 * Taxa de faltas (ADR-048 adendo 7, item 7; F3.3a). Da agenda
 * (`schedule:read`), só agregados: nenhuma pessoa, nenhum agendamento.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsNoShowController {
  constructor(private readonly noShow: ClinicsNoShowService) {}

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('metrics/no-show')
  apurar(
    @Query(new ZodPipe(clinicsNoShowQuerySchema)) query: ClinicsNoShowQuery,
  ): Promise<ClinicsNoShowDto> {
    return this.noShow.apurar(query);
  }
}

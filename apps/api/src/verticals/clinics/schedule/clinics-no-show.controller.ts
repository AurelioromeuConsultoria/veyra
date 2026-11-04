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
 * (`schedule:read`), só agregados: nenhum paciente, nenhum agendamento. Com
 * `groupBy` (ADR-062 adendo 1, item A2), também a série por semana ou por
 * profissional (id e nome, que a agenda já mostra a quem tem `schedule:read`),
 * com a mesma permissão, os mesmos filtros e o mesmo limite de período.
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

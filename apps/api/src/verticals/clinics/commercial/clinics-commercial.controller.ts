import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  clinicsConversionQuerySchema,
  clinicsMetricPeriodSchema,
  setClinicsAppointmentDealSchema,
  type ClinicsAppointmentDealDto,
  type ClinicsConfirmationFunnelDto,
  type ClinicsConversionDto,
  type ClinicsConversionQuery,
  type ClinicsDealOptionDto,
  type ClinicsMetricPeriodQuery,
  type ClinicsReactivationDto,
  type SetClinicsAppointmentDealInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsDealLinksService } from './clinics-deal-links.service';
import { ClinicsOutreachMetricsService } from './clinics-outreach-metrics.service';

/**
 * O vínculo com o deal e as métricas do envio (ADR-048 adendos 8 e 10, F4.3).
 * - Escolher e mudar o vínculo: `pipelines:read` e `clinics:schedule:write`;
 *   ver o vínculo: `pipelines:read` e `clinics:schedule:read`.
 * - As métricas: `clinics:schedule:read`; a conversão, também `pipelines:read`.
 *   As contagens de resposta exigem `conversations:read` (sem ela, a etapa é
 *   omitida); só conta a conversa identificada e ainda do contato do envio.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsCommercialController {
  constructor(
    private readonly vinculos: ClinicsDealLinksService,
    private readonly metricas: ClinicsOutreachMetricsService,
  ) {}

  @RequireClinicsPermissions('pipelines:read', 'clinics:schedule:read')
  @Get('appointments/:id/deal')
  ler(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsAppointmentDealDto> {
    return this.vinculos.ler(id);
  }

  @RequireClinicsPermissions('pipelines:read', 'clinics:schedule:write')
  @Get('appointments/:id/deal-options')
  opcoes(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsDealOptionDto[]> {
    return this.vinculos.opcoes(id);
  }

  @RequireClinicsPermissions('pipelines:read', 'clinics:schedule:write')
  @Put('appointments/:id/deal')
  vincular(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(setClinicsAppointmentDealSchema)) body: SetClinicsAppointmentDealInput,
  ): Promise<ClinicsAppointmentDealDto> {
    return this.vinculos.vincular(auth, id, body.dealId);
  }

  @RequireClinicsPermissions('pipelines:read', 'clinics:schedule:write')
  @Post('appointments/:id/deal/unlink')
  @HttpCode(200)
  desvincular(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsAppointmentDealDto> {
    return this.vinculos.desvincular(auth, id);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('metrics/confirmation')
  funil(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(clinicsMetricPeriodSchema)) query: ClinicsMetricPeriodQuery,
  ): Promise<ClinicsConfirmationFunnelDto> {
    return this.metricas.funil(auth, query);
  }

  @RequireClinicsPermissions('clinics:schedule:read', 'pipelines:read')
  @Get('metrics/conversion')
  conversao(
    @Query(new ZodPipe(clinicsConversionQuerySchema)) query: ClinicsConversionQuery,
  ): Promise<ClinicsConversionDto> {
    return this.metricas.conversao(query);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('metrics/reactivation')
  reativacao(
    @Query(new ZodPipe(clinicsMetricPeriodSchema)) query: ClinicsMetricPeriodQuery,
  ): Promise<ClinicsReactivationDto> {
    return this.metricas.reativacao(query);
  }
}

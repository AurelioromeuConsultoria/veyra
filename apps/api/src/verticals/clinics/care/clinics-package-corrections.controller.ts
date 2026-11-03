import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  correctClinicsPackageConsumptionSchema,
  type ClinicsPackageCorrectionDto,
  type ClinicsPackageSessionsDto,
  type CorrectClinicsPackageConsumptionInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { Idempotent } from '../../../common/idempotency.decorator';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsPackageCorrectionReplayGuard } from './clinics-package-correction-replay.guard';
import { ClinicsPackageCorrectionsService } from './clinics-package-corrections.service';

/**
 * Correção do consumo de pacote de um atendimento registrado (ADR-059, F5.2a).
 * Pacote, saldo e consumo são dado de ATENDIMENTO: quem tem só a agenda não os
 * vê, nem por aqui. A correção amplia a capacidade operacional sobre um
 * consumo histórico, inclusive registrado por outra pessoa; o usuário aprovou
 * esse alcance com `care:write` e `care:read`, com auditoria (ajuste 3).
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsPackageCorrectionsController {
  constructor(private readonly corrections: ClinicsPackageCorrectionsService) {}

  // a repetição é da chave, OBRIGATÓRIA: sem ela, 400. O replay devolve a
  // correção original, com o acesso de agora conferido pela guarda
  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read')
  @Idempotent({ required: true, replayGuard: ClinicsPackageCorrectionReplayGuard })
  @Post('appointments/:id/attendance/package-correction')
  correct(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(correctClinicsPackageConsumptionSchema))
    body: CorrectClinicsPackageConsumptionInput,
  ): Promise<ClinicsPackageCorrectionDto> {
    return this.corrections.correct(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('packages/:id/sessions')
  sessions(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsPackageSessionsDto> {
    return this.corrections.sessions(id);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  createClinicsPackageSchema,
  listClinicsPackagesSchema,
  type ClinicsPackageDto,
  type CreateClinicsPackageInput,
  type ListClinicsPackagesInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsPackagesService } from './clinics-packages.service';

/**
 * Pacotes de sessões (ADR-048 adendo 7, F3.1). Pacote e saldo são dado de
 * ATENDIMENTO: quem tem só a agenda não os vê, nem por aqui.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsPackagesController {
  constructor(private readonly packages: ClinicsPackagesService) {}

  // a resposta é o pacote: quem o cria também precisa lê-lo (care:write
  // pressupõe care:read, ADR-048 adendo 7)
  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read', 'clinics:schedule:read')
  @Post('packages')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsPackageSchema)) body: CreateClinicsPackageInput,
  ): Promise<ClinicsPackageDto> {
    return this.packages.create(auth, body);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('packages')
  list(
    @Query(new ZodPipe(listClinicsPackagesSchema)) query: ListClinicsPackagesInput,
  ): Promise<ClinicsPackageDto[]> {
    return this.packages.listByPatient(query.patientId);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('packages/:id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsPackageDto> {
    return this.packages.get(id);
  }

  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read')
  @Post('packages/:id/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsPackageDto> {
    return this.packages.cancel(auth, id);
  }
}

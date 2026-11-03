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
import { AlcanceClinicoService, exigirAlcance } from './clinics-care-scope';
import { ClinicsPackagesService } from './clinics-packages.service';

/**
 * Pacotes de sessões (ADR-048 adendo 7, F3.1). Pacote e saldo são dado de
 * ATENDIMENTO: quem tem só a agenda não os vê, nem por aqui.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsPackagesController {
  constructor(
    private readonly packages: ClinicsPackagesService,
    private readonly alcance: AlcanceClinicoService,
  ) {}

  /**
   * D8 (ADR-061): o pacote é do PACIENTE, e quem alcança só os próprios
   * atendimentos o vê (para escolher no próprio registro, com o saldo que
   * reflete os consumos de todos). Sem vínculo válido, nenhum dado clínico.
   */
  private async comAlcance(auth: AuthContext): Promise<void> {
    exigirAlcance(await this.alcance.de(auth));
  }

  // a resposta é o pacote: quem o cria também precisa lê-lo (care:write
  // pressupõe care:read, ADR-048 adendo 7)
  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read', 'clinics:schedule:read')
  @Post('packages')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsPackageSchema)) body: CreateClinicsPackageInput,
  ): Promise<ClinicsPackageDto> {
    await this.comAlcance(auth);
    return this.packages.create(auth, body);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('packages')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listClinicsPackagesSchema)) query: ListClinicsPackagesInput,
  ): Promise<ClinicsPackageDto[]> {
    await this.comAlcance(auth);
    return this.packages.listByPatient(query.patientId);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('packages/:id')
  async get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsPackageDto> {
    await this.comAlcance(auth);
    return this.packages.get(id);
  }

  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read')
  @Post('packages/:id/cancel')
  async cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsPackageDto> {
    await this.comAlcance(auth);
    return this.packages.cancel(auth, id);
  }
}

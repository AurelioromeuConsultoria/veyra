import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  clinicsCatalogListQuerySchema,
  clinicsProfessionalNameSchema,
  clinicsProfessionalProfileSchema,
  createClinicsProfessionalSchema,
  createClinicsServiceSchema,
  setClinicsProfessionalAccountSchema,
  setClinicsProfessionalServicesSchema,
  setClinicsWorkingHoursSchema,
  updateClinicsServiceSchema,
  updateClinicsUnitSchema,
  type ClinicsCatalogListQuery,
  type ClinicsProfessionalDto,
  type ClinicsProfessionalNameInput,
  type ClinicsProfessionalProfileInput,
  type ClinicsServiceDto,
  type ClinicsUnitDto,
  type CreateClinicsProfessionalInput,
  type CreateClinicsServiceInput,
  type SetClinicsProfessionalAccountInput,
  type SetClinicsProfessionalServicesInput,
  type SetClinicsWorkingHoursInput,
  type UpdateClinicsServiceInput,
  type UpdateClinicsUnitInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsProfessionalsService } from './clinics-professionals.service';
import { ClinicsServiceCatalog } from './clinics-service-catalog.service';
import { ClinicsUnitsService } from './clinics-units.service';

const uuid = new ParseUUIDPipe();

/**
 * Catálogo da clínica (ADR-048 adendo 1). Leitura com `clinics:catalog:read`;
 * escrita com `clinics:catalog:manage`. Sem a chave, 403 pelo guard global (o
 * que inclui todo workspace com o Clinics desativado); o `ClinicsActiveGuard`
 * cobre só o caso residual de chave presente com o vertical desativado (404).
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsCatalogController {
  constructor(
    private readonly units: ClinicsUnitsService,
    private readonly services: ClinicsServiceCatalog,
    private readonly professionals: ClinicsProfessionalsService,
  ) {}

  // ── Unidade ───────────────────────────────────────────────────────────────

  @RequireClinicsPermissions('clinics:catalog:read')
  @Get('units')
  listUnits(): Promise<ClinicsUnitDto[]> {
    return this.units.list();
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Patch('units/:id')
  updateUnit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(updateClinicsUnitSchema)) body: UpdateClinicsUnitInput,
  ): Promise<ClinicsUnitDto> {
    return this.units.update(auth, id, body);
  }

  // ── Serviços ──────────────────────────────────────────────────────────────

  @RequireClinicsPermissions('clinics:catalog:read')
  @Get('services')
  listServices(
    @Query(new ZodPipe(clinicsCatalogListQuerySchema)) query: ClinicsCatalogListQuery,
  ): Promise<ClinicsServiceDto[]> {
    return this.services.list(query.includeArchived);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('services')
  createService(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsServiceSchema)) body: CreateClinicsServiceInput,
  ): Promise<ClinicsServiceDto> {
    return this.services.create(auth, body);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Patch('services/:id')
  updateService(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(updateClinicsServiceSchema)) body: UpdateClinicsServiceInput,
  ): Promise<ClinicsServiceDto> {
    return this.services.update(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('services/:id/archive')
  archiveService(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<ClinicsServiceDto> {
    return this.services.setArchived(auth, id, true);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('services/:id/unarchive')
  unarchiveService(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<ClinicsServiceDto> {
    return this.services.setArchived(auth, id, false);
  }

  // ── Profissionais ─────────────────────────────────────────────────────────

  @RequireClinicsPermissions('clinics:catalog:read')
  @Get('professionals')
  listProfessionals(
    @Query(new ZodPipe(clinicsCatalogListQuerySchema)) query: ClinicsCatalogListQuery,
  ): Promise<ClinicsProfessionalDto[]> {
    return this.professionals.list(query.includeArchived);
  }

  /** Cria com o perfil inteiro, numa transação (adendo 1, item 23). */
  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('professionals')
  createProfessional(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsProfessionalSchema)) body: CreateClinicsProfessionalInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.create(auth, body);
  }

  /** Salva nome, serviços e semana JUNTOS, ou nada (o drawer usa esta). */
  @RequireClinicsPermissions('clinics:catalog:manage')
  @Put('professionals/:id/profile')
  saveProfessionalProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(clinicsProfessionalProfileSchema)) body: ClinicsProfessionalProfileInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.saveProfile(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Patch('professionals/:id')
  renameProfessional(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(clinicsProfessionalNameSchema)) body: ClinicsProfessionalNameInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.rename(auth, id, body.name);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('professionals/:id/archive')
  archiveProfessional(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.setArchived(auth, id, true);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Post('professionals/:id/unarchive')
  unarchiveProfessional(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.setArchived(auth, id, false);
  }

  /** Vincular conta exige também `members:read`: escolhe-se entre membros. */
  @RequireClinicsPermissions('clinics:catalog:manage', 'members:read')
  @Put('professionals/:id/account')
  setProfessionalAccount(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(setClinicsProfessionalAccountSchema))
    body: SetClinicsProfessionalAccountInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.setAccount(auth, id, body.membershipId);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Put('professionals/:id/services')
  setProfessionalServices(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(setClinicsProfessionalServicesSchema))
    body: SetClinicsProfessionalServicesInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.setServices(auth, id, body.serviceIds);
  }

  @RequireClinicsPermissions('clinics:catalog:manage')
  @Put('professionals/:id/working-hours')
  setProfessionalWorkingHours(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(setClinicsWorkingHoursSchema)) body: SetClinicsWorkingHoursInput,
  ): Promise<ClinicsProfessionalDto> {
    return this.professionals.setWorkingHours(auth, id, body.intervals);
  }
}

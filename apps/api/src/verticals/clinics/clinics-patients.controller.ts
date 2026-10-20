import { Body, Controller, ForbiddenException, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  createClinicsPatientSchema,
  listClinicsPatientsSchema,
  type ClinicsPatientDto,
  type CreateClinicsPatientInput,
  type ListClinicsPatientsInput,
} from '@veyra/contracts/verticals/clinics';
import { PermissionsService } from '../../auth/permissions.service';
import { AuthContext, CurrentAuth } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { ClinicsActiveGuard } from './clinics-active.guard';
import { RequireClinicsPermissions } from './clinics-permissions';
import { ClinicsPatientsService } from './clinics-patients.service';

/**
 * Pacientes (ADR-048 §5.1). Ler é da agenda (`clinics:schedule:read`): o papel
 * `Profissional` vê o paciente por aqui, não pelo CRM. Criar o perfil exige
 * `clinics:schedule:write` E `contacts:read` — escolhe-se um contato do CRM.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsPatientsController {
  constructor(
    private readonly patients: ClinicsPatientsService,
    private readonly permissions: PermissionsService,
  ) {}

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('patients')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listClinicsPatientsSchema)) query: ListClinicsPatientsInput,
  ): Promise<ClinicsPatientDto[]> {
    const readsContacts = await this.permissions.has(auth, 'contacts:read');
    // filtrar POR CONTATO refaria o vínculo contato↔paciente que a omissão do
    // campo esconde: sem `contacts:read`, só a lista sem filtro
    if (query.contactIds && !readsContacts) {
      throw new ForbiddenException('Filtrar por contato exige permissão para ver contatos');
    }
    return this.patients.list(query, readsContacts);
  }

  @RequireClinicsPermissions('clinics:schedule:write', 'contacts:read')
  @Post('patients')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsPatientSchema)) body: CreateClinicsPatientInput,
  ): Promise<ClinicsPatientDto> {
    return this.patients.create(auth, body.contactId);
  }
}

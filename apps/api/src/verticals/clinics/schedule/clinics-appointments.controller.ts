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
import type { PermissionKey } from '@veyra/contracts';
import type { ClinicsPermissionKey } from '@veyra/contracts/verticals/clinics';
import {
  changeClinicsAppointmentStatusSchema,
  createClinicsAppointmentSchema,
  listClinicsAppointmentsSchema,
  rescheduleClinicsAppointmentSchema,
  type ChangeClinicsAppointmentStatusInput,
  type ClinicsAppointmentDto,
  type ClinicsAttendanceDto,
  type CreateClinicsAppointmentInput,
  type ListClinicsAppointmentsInput,
  type RescheduleClinicsAppointmentInput,
} from '@veyra/contracts/verticals/clinics';
import { PermissionsService } from '../../../auth/permissions.service';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsAppointmentsService } from './clinics-appointments.service';
import { ClinicsAttendanceService } from './clinics-attendance.service';

/**
 * Agenda e registro de atendimento (ADR-048 adendo 4, item 8). Marcar, remarcar
 * e mudar o estado é da recepção (`clinics:schedule:write`); registrar
 * atendimento é de quem atende (`clinics:care:write`), e o `Profissional` lê a
 * agenda mas não marca.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsAppointmentsController {
  constructor(
    private readonly appointments: ClinicsAppointmentsService,
    private readonly attendance: ClinicsAttendanceService,
    private readonly permissions: PermissionsService,
  ) {}

  /** O vínculo com o atendimento sai SÓ para quem lê atendimento (autorização de campo). */
  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('appointments')
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listClinicsAppointmentsSchema)) query: ListClinicsAppointmentsInput,
  ): Promise<ClinicsAppointmentDto[]> {
    // chave do vertical: o catálogo é COMPOSTO, a checagem é a mesma do guard;
    // o `satisfies` faz o TypeScript conferir a grafia contra o catálogo
    const careRead = 'clinics:care:read' satisfies ClinicsPermissionKey;
    const leAtendimento = await this.permissions.has(auth, careRead as PermissionKey);
    return this.appointments.list(query, leAtendimento);
  }

  @RequireClinicsPermissions('clinics:schedule:write')
  @Post('appointments')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsAppointmentSchema)) body: CreateClinicsAppointmentInput,
  ): Promise<ClinicsAppointmentDto> {
    return this.appointments.create(auth, body);
  }

  @RequireClinicsPermissions('clinics:schedule:write')
  @Post('appointments/:id/reschedule')
  reschedule(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rescheduleClinicsAppointmentSchema)) body: RescheduleClinicsAppointmentInput,
  ): Promise<ClinicsAppointmentDto> {
    return this.appointments.reschedule(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:schedule:write')
  @Post('appointments/:id/status')
  changeStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(changeClinicsAppointmentStatusSchema))
    body: ChangeClinicsAppointmentStatusInput,
  ): Promise<ClinicsAppointmentDto> {
    return this.appointments.changeStatus(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:care:write', 'clinics:schedule:read')
  @Post('appointments/:id/attendance')
  recordAttendance(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsAttendanceDto> {
    return this.attendance.record(auth, id);
  }

  @RequireClinicsPermissions('clinics:care:read')
  @Get('appointments/:id/attendance')
  getAttendance(@Param('id', new ParseUUIDPipe()) id: string): Promise<ClinicsAttendanceDto> {
    return this.attendance.get(id);
  }
}

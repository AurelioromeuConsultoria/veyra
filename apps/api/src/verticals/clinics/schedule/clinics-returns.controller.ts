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
  assignClinicsReturnSchema,
  cancelClinicsReturnSchema,
  createClinicsReturnSchema,
  linkClinicsReturnSchema,
  listClinicsReturnCandidatesSchema,
  listClinicsReturnsSchema,
  type AssignClinicsReturnInput,
  type CancelClinicsReturnInput,
  type ClinicsReturnAssigneeDto,
  type ClinicsReturnCandidatesPageDto,
  type ClinicsReturnDto,
  type CreateClinicsReturnInput,
  type LinkClinicsReturnInput,
  type ListClinicsReturnCandidatesInput,
  type ListClinicsReturnsInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsReturnsService } from './clinics-returns.service';

/**
 * Retornos (ADR-048 adendo 7, F3.2). A lista operacional é da agenda
 * (`schedule:read`), com a projeção decidida no servidor. Agir sobre o retorno
 * exige a escrita da agenda OU do atendimento, conferida no serviço; o motivo
 * de cancelamento clínico exige a do atendimento.
 */
@Controller('clinics')
@UseGuards(ClinicsActiveGuard)
export class ClinicsReturnsController {
  constructor(private readonly returns: ClinicsReturnsService) {}

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('returns')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listClinicsReturnsSchema)) query: ListClinicsReturnsInput,
  ): Promise<ClinicsReturnDto[]> {
    return this.returns.list(auth, query);
  }

  // antes de `returns/:id`: o seletor de responsável, só com id e nome
  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('returns/assignees')
  assignees(@CurrentAuth() auth: AuthContext): Promise<ClinicsReturnAssigneeDto[]> {
    return this.returns.assignees(auth);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('returns/:id')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsReturnDto> {
    return this.returns.get(auth, id);
  }

  // os candidatos ao vínculo: as permissões de vincular (a ação, no serviço)
  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('returns/:id/candidates')
  candidates(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodPipe(listClinicsReturnCandidatesSchema)) query: ListClinicsReturnCandidatesInput,
  ): Promise<ClinicsReturnCandidatesPageDto> {
    return this.returns.candidates(auth, id, query);
  }

  // criar à mão é decisão clínica; a resposta é o retorno (care:write ⇒ care:read)
  @RequireClinicsPermissions('clinics:care:write', 'clinics:care:read', 'clinics:schedule:read')
  @Post('returns')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClinicsReturnSchema)) body: CreateClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    return this.returns.create(auth, body);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Post('returns/:id/link')
  link(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(linkClinicsReturnSchema)) body: LinkClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    return this.returns.link(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Post('returns/:id/unlink')
  unlink(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsReturnDto> {
    return this.returns.unlink(auth, id);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Post('returns/:id/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(cancelClinicsReturnSchema)) body: CancelClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    return this.returns.cancel(auth, id, body);
  }

  @RequireClinicsPermissions('clinics:schedule:read')
  @Post('returns/:id/assign')
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(assignClinicsReturnSchema)) body: AssignClinicsReturnInput,
  ): Promise<ClinicsReturnDto> {
    return this.returns.assign(auth, id, body);
  }
}

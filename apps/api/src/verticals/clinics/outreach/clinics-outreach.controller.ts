import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  approveClinicsOutreachSchema,
  listClinicsOutreachCandidatesSchema,
  prepareClinicsOutreachSchema,
  previewClinicsOutreachSchema,
  type ApproveClinicsOutreachInput,
  type ClinicsOutreachCandidateDto,
  type ClinicsOutreachPrepareDto,
  type ClinicsOutreachPreviewDto,
  type ClinicsOutreachRequestDto,
  type ClinicsOutreachResultDto,
  type ListClinicsOutreachCandidatesInput,
  type PrepareClinicsOutreachInput,
  type PreviewClinicsOutreachInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, CurrentAuth } from '../../../common/decorators';
import { Idempotent } from '../../../common/idempotency.decorator';
import { ZodPipe } from '../../../common/zod.pipe';
import { ClinicsActiveGuard } from '../clinics-active.guard';
import { RequireClinicsPermissions } from '../clinics-permissions';
import { ClinicsOutreachService } from './clinics-outreach.service';

/**
 * O envio iniciado pela clínica (ADR-048 adendos 8 e 9, F4.2). Preparar, ver a
 * prévia e aprovar exigem a leitura E a escrita da agenda, além das três do
 * Core (escrever na conversa, ler o contato e os consentimentos): escrita não
 * implica leitura num papel personalizado. A porta do E7 declara as duas do
 * vertical, e o serviço do Core as confere de novo antes de consultar a
 * origem — esta é a segunda camada, e a que vale no replay do lote.
 *
 * O lote EXIGE `Idempotency-Key`; a resposta guardada traz só ids, estados e
 * motivos, nunca o texto.
 */
@Controller('clinics/outreach')
@UseGuards(ClinicsActiveGuard)
export class ClinicsOutreachController {
  constructor(private readonly outreach: ClinicsOutreachService) {}

  /** Os candidatos mostram o paciente, o horário e os números: agenda, contatos e consentimentos. */
  @RequireClinicsPermissions('clinics:schedule:read', 'contacts:read', 'consents:read')
  @Get('candidates')
  candidatos(
    @Query(new ZodPipe(listClinicsOutreachCandidatesSchema))
    query: ListClinicsOutreachCandidatesInput,
  ): Promise<ClinicsOutreachCandidateDto[]> {
    return this.outreach.candidatos(query);
  }

  @RequireClinicsPermissions(
    'clinics:schedule:read',
    'clinics:schedule:write',
    'conversations:write',
    'contacts:read',
    'consents:read',
  )
  @Post('requests')
  @HttpCode(200)
  preparar(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(prepareClinicsOutreachSchema)) body: PrepareClinicsOutreachInput,
  ): Promise<ClinicsOutreachPrepareDto> {
    return this.outreach.preparar(auth, body);
  }

  @RequireClinicsPermissions(
    'clinics:schedule:read',
    'clinics:schedule:write',
    'conversations:write',
    'contacts:read',
    'consents:read',
  )
  @Post('preview')
  @HttpCode(200)
  previa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(previewClinicsOutreachSchema)) body: PreviewClinicsOutreachInput,
  ): Promise<ClinicsOutreachPreviewDto> {
    return this.outreach.previa(auth, body);
  }

  @RequireClinicsPermissions(
    'clinics:schedule:read',
    'clinics:schedule:write',
    'conversations:write',
    'contacts:read',
    'consents:read',
  )
  @Idempotent({ required: true })
  @Post('approve')
  @HttpCode(200)
  aprovar(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(approveClinicsOutreachSchema)) body: ApproveClinicsOutreachInput,
  ): Promise<ClinicsOutreachResultDto> {
    return this.outreach.aprovar(auth, body);
  }

  /** O pedido: o número completo e o motivo dependem de `contacts:read` e `consents:read`. */
  @RequireClinicsPermissions('clinics:schedule:read')
  @Get('requests/:id')
  ler(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClinicsOutreachRequestDto> {
    return this.outreach.ler(auth, id);
  }
}

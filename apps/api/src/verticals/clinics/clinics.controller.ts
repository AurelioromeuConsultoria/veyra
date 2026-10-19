import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  grantClinicsAiReleaseSchema,
  type ClinicsAiReleaseDto,
  type ClinicsStatusDto,
  type GrantClinicsAiReleaseInput,
} from '@veyra/contracts/verticals/clinics';
import { AuthContext, AuthenticatedOnly, CurrentAuth } from '../../common/decorators';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService } from '../../prisma/prisma.service';
import { ClinicsActiveGuard } from './clinics-active.guard';
import { RequireClinicsPermissions } from './clinics-permissions';
import { ClinicsReleasesService } from './clinics-releases.service';

@Controller('clinics')
export class ClinicsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly releases: ClinicsReleasesService,
  ) {}

  /**
   * O vertical está ativo no workspace DESTA sessão? Alimenta a navegação do
   * web (E5, F1.c). Só autenticação: a resposta é um booleano sobre o próprio
   * workspace, sem dado de ninguém.
   */
  @AuthenticatedOnly()
  @Get('status')
  async status(@CurrentAuth() auth: AuthContext): Promise<ClinicsStatusDto> {
    if (!auth.workspaceId) return { active: false };
    const settings = (await this.prisma.db.clinicsSettings.findFirst({
      select: { status: true },
    })) as { status: string } | null;
    return { active: settings?.status === 'active' };
  }

  @UseGuards(ClinicsActiveGuard)
  @RequireClinicsPermissions('clinics:restriction:manage')
  @Get('ai-releases')
  list(): Promise<ClinicsAiReleaseDto[]> {
    return this.releases.list();
  }

  /** Liberar exige também ler o contato: a rota declara as duas famílias. */
  @UseGuards(ClinicsActiveGuard)
  @RequireClinicsPermissions('clinics:restriction:manage', 'contacts:read')
  @Post('contacts/:contactId/ai-release')
  grant(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
    @Body(new ZodPipe(grantClinicsAiReleaseSchema)) body: GrantClinicsAiReleaseInput,
  ): Promise<ClinicsAiReleaseDto> {
    return this.releases.grant(auth, contactId, body.reason);
  }

  @UseGuards(ClinicsActiveGuard)
  @RequireClinicsPermissions('clinics:restriction:manage', 'contacts:read')
  @Delete('contacts/:contactId/ai-release')
  async revoke(
    @CurrentAuth() auth: AuthContext,
    @Param('contactId', new ParseUUIDPipe()) contactId: string,
  ): Promise<{ ok: true }> {
    await this.releases.revoke(auth, contactId);
    return { ok: true };
  }
}

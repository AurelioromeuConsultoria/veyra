import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { BusinessOutboundModule } from '../../business-outbound/business-outbound.module';
import { CorpoOpcionalMiddleware } from '../../common/corpo-opcional.middleware';
import { ContactsModule } from '../../contacts/contacts.module';
import { IntelligenceModule } from '../../intelligence/intelligence.module';
import { JobsModule } from '../../jobs/jobs.module';
import { ClinicsPackagesController } from './care/clinics-packages.controller';
import { ClinicsPackagesService } from './care/clinics-packages.service';
import { ClinicsCatalogController } from './catalog/clinics-catalog.controller';
import { ClinicsProfessionalsService } from './catalog/clinics-professionals.service';
import { ClinicsServiceCatalog } from './catalog/clinics-service-catalog.service';
import { ClinicsUnitsService } from './catalog/clinics-units.service';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsActiveGuard } from './clinics-active.guard';
import { ClinicsController } from './clinics.controller';
import { ClinicsPatientsController } from './clinics-patients.controller';
import { ClinicsLeadsService } from './clinics-leads.service';
import { ClinicsPatientsService } from './clinics-patients.service';
import { ClinicsReleasesService } from './clinics-releases.service';
import { ClinicsCommercialController } from './commercial/clinics-commercial.controller';
import { ClinicsDealLinksService } from './commercial/clinics-deal-links.service';
import { ClinicsOutreachMetricsService } from './commercial/clinics-outreach-metrics.service';
import { ClinicsOutreachController } from './outreach/clinics-outreach.controller';
import { ClinicsOutreachService } from './outreach/clinics-outreach.service';
import { VarreduraDosPedidos } from './outreach/clinics-outreach.sweep';
import { ValidadeDosPedidos } from './outreach/clinics-outreach.validity';
import { ClinicsAppointmentsController } from './schedule/clinics-appointments.controller';
import { ClinicsAppointmentsService } from './schedule/clinics-appointments.service';
import { ClinicsAttendanceService } from './schedule/clinics-attendance.service';
import { ClinicsNoShowController } from './schedule/clinics-no-show.controller';
import { ClinicsNoShowService } from './schedule/clinics-no-show.service';
import { ClinicsReturnsController } from './schedule/clinics-returns.controller';
import { ClinicsReturnsService } from './schedule/clinics-returns.service';

/**
 * Vertical Veyra Clinics (ADR-048). Importa serviços do Core; o Core nunca o
 * importa — só a raiz de composição (`app.module.ts`, `composition.ts`).
 */
@Module({
  // o envio do negócio (F4.2): a prévia e a aprovação pela rota do vertical, e
  // o agendador do Core para a varredura do texto dos pedidos
  imports: [AuthModule, BusinessOutboundModule, ContactsModule, IntelligenceModule, JobsModule],
  controllers: [
    ClinicsController,
    ClinicsCatalogController,
    ClinicsPatientsController,
    ClinicsAppointmentsController,
    ClinicsPackagesController,
    ClinicsReturnsController,
    ClinicsNoShowController,
    ClinicsOutreachController,
    ClinicsCommercialController,
  ],
  providers: [
    ClinicsActivationService,
    ClinicsReleasesService,
    ClinicsActiveGuard,
    ClinicsUnitsService,
    ClinicsServiceCatalog,
    ClinicsProfessionalsService,
    ClinicsPatientsService,
    ClinicsLeadsService,
    ClinicsAppointmentsService,
    ClinicsAttendanceService,
    ClinicsPackagesService,
    ClinicsReturnsService,
    ClinicsNoShowService,
    ClinicsOutreachService,
    ValidadeDosPedidos,
    VarreduraDosPedidos,
    ClinicsDealLinksService,
    ClinicsOutreachMetricsService,
  ],
  exports: [ClinicsActivationService],
})
export class ClinicsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // o registro de atendimento: os bytes que ninguém interpretou são recusados
    // (415) antes do controller, e a ausência PROVADA de corpo responde 400 no
    // controller, porque a escolha é obrigatória (ADR-048 adendo 7, ajuste A1)
    consumer
      .apply(CorpoOpcionalMiddleware)
      .forRoutes({ path: 'clinics/appointments/:id/attendance', method: RequestMethod.POST });
  }
}

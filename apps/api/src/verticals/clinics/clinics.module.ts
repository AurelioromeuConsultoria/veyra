import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CorpoOpcionalMiddleware } from '../../common/corpo-opcional.middleware';
import { ContactsModule } from '../../contacts/contacts.module';
import { IntelligenceModule } from '../../intelligence/intelligence.module';
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
import { ClinicsPatientsService } from './clinics-patients.service';
import { ClinicsReleasesService } from './clinics-releases.service';
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
  imports: [AuthModule, ContactsModule, IntelligenceModule],
  controllers: [
    ClinicsController,
    ClinicsCatalogController,
    ClinicsPatientsController,
    ClinicsAppointmentsController,
    ClinicsPackagesController,
    ClinicsReturnsController,
    ClinicsNoShowController,
  ],
  providers: [
    ClinicsActivationService,
    ClinicsReleasesService,
    ClinicsActiveGuard,
    ClinicsUnitsService,
    ClinicsServiceCatalog,
    ClinicsProfessionalsService,
    ClinicsPatientsService,
    ClinicsAppointmentsService,
    ClinicsAttendanceService,
    ClinicsPackagesService,
    ClinicsReturnsService,
    ClinicsNoShowService,
  ],
  exports: [ClinicsActivationService],
})
export class ClinicsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // o registro de atendimento aceita corpo AUSENTE (a tela registra sem
    // corpo): a ausência é provada pelos bytes, antes do controller, e o
    // controller não aceita a ausência sem essa prova (ADR-048 adendo 7)
    consumer
      .apply(CorpoOpcionalMiddleware)
      .forRoutes({ path: 'clinics/appointments/:id/attendance', method: RequestMethod.POST });
  }
}

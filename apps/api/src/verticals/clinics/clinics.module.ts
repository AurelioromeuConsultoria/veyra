import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ContactsModule } from '../../contacts/contacts.module';
import { IntelligenceModule } from '../../intelligence/intelligence.module';
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
  ],
  exports: [ClinicsActivationService],
})
export class ClinicsModule {}

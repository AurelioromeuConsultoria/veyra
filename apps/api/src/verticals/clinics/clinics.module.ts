import { Module } from '@nestjs/common';
import { ContactsModule } from '../../contacts/contacts.module';
import { IntelligenceModule } from '../../intelligence/intelligence.module';
import { ClinicsActivationService } from './clinics-activation.service';
import { ClinicsActiveGuard } from './clinics-active.guard';
import { ClinicsController } from './clinics.controller';
import { ClinicsReleasesService } from './clinics-releases.service';

/**
 * Vertical Veyra Clinics (ADR-048). Importa serviços do Core; o Core nunca o
 * importa — só a raiz de composição (`app.module.ts`, `composition.ts`).
 */
@Module({
  imports: [ContactsModule, IntelligenceModule],
  controllers: [ClinicsController],
  providers: [ClinicsActivationService, ClinicsReleasesService, ClinicsActiveGuard],
  exports: [ClinicsActivationService],
})
export class ClinicsModule {}

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { JobsService } from '../../../jobs/jobs.service';
import { ClinicsActivationService } from '../clinics-activation.service';

const FILA = 'clinics-care-scope-backfill';

/**
 * O PREENCHIMENTO das chaves novas do vertical nos papéis que já existiam
 * (ADR-061, adendo 1, item 5), sem comando manual: pelo agendador de jobs do
 * Core, uma vez logo depois da subida e de hora em hora. Com os jobs desligados
 * (manutenção, `DISABLE_JOBS`, testes), não roda nada — as suítes chamam o
 * preenchimento direto. Idempotente pelo livro (`PermissionBackfill`): a chave
 * revogada depois não volta.
 */
@Injectable()
export class PreenchimentoDoAlcance implements OnApplicationBootstrap {
  private readonly logger = new Logger(PreenchimentoDoAlcance.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly ativacao: ClinicsActivationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.jobs.agendarPeriodico(FILA, '7 * * * *', () => this.preencher(), {
      tambemNaSubida: true,
    });
  }

  private async preencher(): Promise<void> {
    const concedidas = await this.ativacao.preencherChavesNovas();
    if (concedidas > 0) {
      this.logger.log(`Chaves novas do Clinics concedidas pelo livro: ${concedidas}`);
    }
  }
}

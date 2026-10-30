import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { ExperienceAvailabilityProvider } from '../../extensions/experience';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A experiência `clinics` (ADR-055) só vale com o vertical ATIVO no workspace.
 * Desativado, a sessão diz `unavailable`, e o web mostra a experiência
 * indisponível — nunca o CRM no lugar. Lê pelo client filtrado, num contexto
 * PRÓPRIO que só tem o workspace pedido (`ifNested: 'override'`): nada da
 * identidade nem do workspace de quem chama entra nele, e nada dele volta ao
 * contexto de quem chama.
 */
@Injectable()
export class ClinicsExperienceAvailability implements ExperienceAvailabilityProvider {
  readonly experience = 'clinics';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  isAvailable(workspaceId: string): Promise<boolean> {
    return this.cls.run({ ifNested: 'override' }, async () => {
      this.cls.set('workspaceId', workspaceId);
      // `await` DENTRO do run: a consulta do Prisma é preguiçosa
      const settings = await this.prisma.db.clinicsSettings.findFirst({
        select: { status: true },
      });
      return settings?.status === 'active';
    });
  }
}

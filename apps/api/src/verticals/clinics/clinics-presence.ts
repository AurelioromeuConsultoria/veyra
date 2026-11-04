import type { PrismaService } from '../../prisma/prisma.service';
import { CLINICS_MODELS } from './clinics.extension';

type Delegate = { findFirst: (args: unknown) => Promise<unknown> };

/**
 * Alguma linha de algum modelo do vertical, no workspace do CLS. As consultas
 * saem EM PARALELO (ADR-048 adendo 2, item 8): o caso comum é o workspace
 * SEM o Clinics, em que todas são feitas; em série, a latência crescia com
 * cada modelo novo. Qualquer erro rejeita — nunca vira "ausente". A lista vem
 * do próprio registro da extensão: um modelo novo entra sozinho.
 */
export async function temLinhaDoVertical(prisma: PrismaService): Promise<boolean> {
  const delegates = prisma.db as unknown as Record<string, Delegate>;
  const achados = await Promise.all(
    // `async`: até um erro SÍNCRONO de um delegate vira rejeição tratada, sem
    // deixar as consultas irmãs sem dono
    CLINICS_MODELS.map(async (model) =>
      delegates[model.charAt(0).toLowerCase() + model.slice(1)].findFirst({
        select: { id: true },
      }),
    ),
  );
  return achados.some((linha) => linha !== null);
}

/**
 * A PRESENÇA do Clinics no workspace do CLS (ADR-047 §4; ADR-061, adendo 3):
 * `ClinicsSettings` em QUALQUER status, ou qualquer linha do vertical. É a
 * regra da E6 e a do conteúdo protegido (E8): desativar não tira a presença.
 */
export async function clinicsPresente(prisma: PrismaService): Promise<boolean> {
  const settings = await prisma.db.clinicsSettings.findFirst({ select: { id: true } } as never);
  return settings !== null || (await temLinhaDoVertical(prisma));
}

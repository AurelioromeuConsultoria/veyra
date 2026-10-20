import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type {
  ContentRestrictionProvider,
  RestrictionConsumer,
  RestrictionSubject,
} from '../../extensions/content-restriction';
import { PrismaService } from '../../prisma/prisma.service';
import { CLINICS_MODELS } from './clinics.extension';

type Delegate = { findFirst: (args: unknown) => Promise<unknown> };

/**
 * Porta REAL do E6 para o Clinics (ADR-048 §6.4, ADR-047 §4 "ciclo de vida da
 * restrição").
 *
 * - PRESENÇA: há `ClinicsSettings` em QUALQUER status, ou qualquer linha de
 *   QUALQUER modelo do vertical. A lista vem do próprio registro da extensão,
 *   então um modelo novo (F1.c, F2) entra sozinho na checagem.
 * - Sem presença: nada é restrito (workspace sem Clinics = Core puro).
 * - `webhook` (e qualquer consumidor que não seja `ai`): tudo restrito — no MVP
 *   não existe liberação para eles.
 * - `ai`: restrito, exceto contato com liberação de IA vigente e Clinics
 *   ATIVO. Desativado, as liberações ficam suspensas. `null` e id sem contato
 *   no workspace (excluído depois da emissão) são restritos. PACIENTE é
 *   sempre restrito, com ou sem liberação (o vínculo clínico vence).
 *
 * Roda com o client protegido, no CLS do workspace pedido — nunca `raw`.
 */
@Injectable()
export class ClinicsContentRestriction implements ContentRestrictionProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  async restricted(
    workspaceId: string,
    consumer: RestrictionConsumer,
    subjects: readonly RestrictionSubject[],
  ): Promise<readonly boolean[]> {
    return this.cls.run(async () => {
      this.cls.set('workspaceId', workspaceId);
      const db = this.prisma.db;
      // `status` lido, mas a PRESENÇA não depende dele (teste de regressão)
      const settings = (await db.clinicsSettings.findFirst({
        select: { status: true },
      })) as { status: string } | null;
      const present = settings !== null || (await this.hasVerticalData());
      if (!present) return subjects.map(() => false);
      // só `ai` tem liberação no MVP. ALLOWLIST, não "webhook é restrito": um
      // consumidor novo do Core nasce restrito aqui, sem herdar a liberação de IA
      if (consumer !== 'ai') return subjects.map(() => true);
      if (settings?.status !== 'active') return subjects.map(() => true);

      const ids = [...new Set(subjects.filter((s): s is string => s !== null))];
      const [liberacoes, pacientes] =
        ids.length === 0
          ? [[], []]
          : // funções `async`: até um erro SÍNCRONO vira rejeição tratada
            ((await Promise.all([
              (async () =>
                db.clinicsContactRelease.findMany({
                  where: { consumer: 'ai', contactId: { in: ids } },
                  select: { contactId: true },
                }))(),
              (async () =>
                db.clinicsPatient.findMany({
                  where: { contactId: { in: ids } },
                  select: { contactId: true },
                }))(),
            ])) as unknown as [{ contactId: string }[], { contactId: string }[]]);
      const released = new Set(liberacoes.map((row) => row.contactId));
      // PACIENTE vence a liberação (ADR-048 §6.3, item 6; adendo 2, item 2):
      // regra DERIVADA, vale a partir do commit que cria o paciente, mesmo que
      // uma liberação sobre — é a garantia principal, não a limpeza
      const patients = new Set(pacientes.map((row) => row.contactId));
      // a liberação cai em CASCADE com o contato: id de contato excluído não
      // tem liberação e fica restrito, como manda o contrato da porta
      return subjects.map(
        (subject) => subject === null || patients.has(subject) || !released.has(subject),
      );
    });
  }

  /**
   * Alguma linha de algum modelo do vertical, neste workspace. As consultas
   * saem EM PARALELO (ADR-048 adendo 2, item 8): o caso comum é o workspace
   * SEM o Clinics, em que todas são feitas; em série, a latência crescia com
   * cada modelo novo. Qualquer erro rejeita — nunca vira "ausente".
   */
  private async hasVerticalData(): Promise<boolean> {
    const delegates = this.prisma.db as unknown as Record<string, Delegate>;
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
}

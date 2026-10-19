import type { ClsService } from 'nestjs-cls';
import type { PrismaService } from '../../prisma/prisma.service';
import { ClinicsContentRestriction } from './clinics-content-restriction';

type Rows = Record<string, unknown>;
const ok = (row: unknown) => jest.fn().mockResolvedValue(row);
const boom = () => jest.fn().mockRejectedValue(new Error('banco indisponível'));

/** Porta com delegates controláveis; CLS que só executa a função. */
const portWith = (db: Rows) => {
  const cls = { run: (fn: () => unknown) => fn(), set: jest.fn() } as unknown as ClsService;
  return new ClinicsContentRestriction({ db } as unknown as PrismaService, cls);
};
const vazio = () => ({
  clinicsSettings: { findFirst: ok(null) },
  clinicsUnit: { findFirst: ok(null) },
  clinicsContactRelease: { findFirst: ok(null), findMany: ok([]) },
});

/**
 * ADR-048 §6.6, "a consulta de presença falhando equivale a restrito": a porta
 * NUNCA converte erro em "liberado" — ela rejeita, e o Core (F1.a, provado com
 * a porta de teste) trata a rejeição como indisponível, que falha fechado.
 */
describe('ClinicsContentRestriction — falha nunca vira "liberado"', () => {
  it.each(['clinicsSettings', 'clinicsUnit', 'clinicsContactRelease'])(
    'falha ao ler %s na checagem de presença: rejeita',
    async (model) => {
      const db = vazio();
      (db as Record<string, { findFirst: jest.Mock }>)[model].findFirst = boom();
      for (const consumer of ['ai', 'webhook'] as const) {
        await expect(portWith(db).restricted('ws', consumer, ['c1', null])).rejects.toThrow(
          /indisponível/,
        );
      }
    },
  );

  it('falha ao ler as liberações (Clinics ativo): rejeita', async () => {
    const db = vazio();
    db.clinicsSettings.findFirst = ok({ status: 'active' });
    db.clinicsContactRelease.findMany = boom();
    await expect(portWith(db).restricted('ws', 'ai', ['c1'])).rejects.toThrow(/indisponível/);
  });

  it('sem presença nenhuma: nada restrito (Core puro); com presença, `null` sempre restrito', async () => {
    expect(await portWith(vazio()).restricted('ws', 'ai', ['c1', null])).toEqual([false, false]);
    const db = vazio();
    db.clinicsSettings.findFirst = ok({ status: 'active' });
    db.clinicsContactRelease.findMany = ok([{ contactId: 'c1' }]);
    expect(await portWith(db).restricted('ws', 'ai', ['c1', 'c2', null])).toEqual([
      false,
      true,
      true,
    ]);
    expect(await portWith(db).restricted('ws', 'webhook', ['c1'])).toEqual([true]);
  });

  it('consumidor DESCONHECIDO (um que o Core venha a criar) nasce restrito, sem herdar a liberação de IA', async () => {
    const db = vazio();
    db.clinicsSettings.findFirst = ok({ status: 'active' });
    db.clinicsContactRelease.findMany = ok([{ contactId: 'c1' }]);
    const futuro = 'export' as unknown as Parameters<ClinicsContentRestriction['restricted']>[1];
    expect(await portWith(db).restricted('ws', futuro, ['c1', null])).toEqual([true, true]);
  });
});

import { computeLeadScore, type ScoreSignals } from './lead-score';

const base: ScoreSignals = {
  daysSinceLastActivity: null,
  openDealsValueCents: 0,
  wonDealsCount: 0,
  messagesLast30Days: 0,
  hasEmail: false,
  hasPhone: false,
};

describe('score de lead determinístico', () => {
  it('é reproduzível: mesmos sinais, mesmo score', () => {
    const signals = { ...base, daysSinceLastActivity: 3, messagesLast30Days: 5 };
    expect(computeLeadScore(signals)).toEqual(computeLeadScore(signals));
  });

  it('contato sem sinal nenhum vale zero, e nunca passa de 100', () => {
    expect(computeLeadScore(base).score).toBe(0);
    const tudo = computeLeadScore({
      daysSinceLastActivity: 1,
      openDealsValueCents: 50_000_00,
      wonDealsCount: 9,
      messagesLast30Days: 40,
      hasEmail: true,
      hasPhone: true,
    });
    expect(tudo.score).toBe(100);
  });

  it('recência pesa: o mesmo contato vale menos depois de 90 dias parado', () => {
    const recente = computeLeadScore({ ...base, daysSinceLastActivity: 3 }).score;
    const antigo = computeLeadScore({ ...base, daysSinceLastActivity: 200 }).score;
    expect(recente).toBeGreaterThan(antigo);
  });

  it('todo ponto vem de um fator nomeado — nada de score opaco', () => {
    const resultado = computeLeadScore({
      ...base,
      daysSinceLastActivity: 2,
      openDealsValueCents: 20_000_00,
      hasEmail: true,
    });
    const soma = resultado.factors.reduce((total, f) => total + f.points, 0);
    expect(resultado.score).toBe(Math.min(100, soma));
    expect(resultado.factors.map((f) => f.key)).toEqual(['recency', 'pipeline', 'reachability']);
    expect(resultado.factors.every((f) => f.label.length > 0)).toBe(true);
  });
});

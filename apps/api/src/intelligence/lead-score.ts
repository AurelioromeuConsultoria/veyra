/**
 * Score de lead DETERMINÍSTICO (ajuste aprovado): sinais calculados no
 * domínio produzem score e fatores. O LLM apenas redige a explicação — sem
 * chave ou com provedor fora, o score e seus fatores continuam existindo.
 *
 * Nada de score opaco: cada ponto vem de um fator nomeado e auditável.
 */
export interface ScoreSignals {
  daysSinceLastActivity: number | null;
  openDealsValueCents: number;
  wonDealsCount: number;
  messagesLast30Days: number;
  hasEmail: boolean;
  hasPhone: boolean;
}

export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
}

export interface LeadScore {
  score: number;
  factors: ScoreFactor[];
}

const MAX_SCORE = 100;

export function computeLeadScore(signals: ScoreSignals): LeadScore {
  const factors: ScoreFactor[] = [];

  // recência: contato ativo vale mais que contato esquecido
  if (signals.daysSinceLastActivity === null) {
    factors.push({ key: 'recency', label: 'Sem atividade registrada', points: 0 });
  } else if (signals.daysSinceLastActivity <= 7) {
    factors.push({ key: 'recency', label: 'Atividade na última semana', points: 30 });
  } else if (signals.daysSinceLastActivity <= 30) {
    factors.push({ key: 'recency', label: 'Atividade no último mês', points: 18 });
  } else if (signals.daysSinceLastActivity <= 90) {
    factors.push({ key: 'recency', label: 'Atividade no último trimestre', points: 6 });
  } else {
    factors.push({ key: 'recency', label: 'Mais de 90 dias sem atividade', points: 0 });
  }

  // engajamento por conversa
  if (signals.messagesLast30Days >= 10) {
    factors.push({ key: 'engagement', label: 'Conversa intensa no mês', points: 20 });
  } else if (signals.messagesLast30Days >= 3) {
    factors.push({ key: 'engagement', label: 'Conversa ativa no mês', points: 12 });
  } else if (signals.messagesLast30Days > 0) {
    factors.push({ key: 'engagement', label: 'Pouca conversa no mês', points: 5 });
  }

  // oportunidade aberta em jogo
  if (signals.openDealsValueCents >= 10_000_00) {
    factors.push({ key: 'pipeline', label: 'Oportunidade aberta relevante', points: 25 });
  } else if (signals.openDealsValueCents > 0) {
    factors.push({ key: 'pipeline', label: 'Oportunidade aberta', points: 15 });
  }

  // histórico de compra
  if (signals.wonDealsCount > 0) {
    factors.push({
      key: 'history',
      label: `${signals.wonDealsCount} negócio(s) ganho(s)`,
      points: Math.min(15, signals.wonDealsCount * 8),
    });
  }

  // dados de contato utilizáveis
  const reachability = (signals.hasEmail ? 5 : 0) + (signals.hasPhone ? 5 : 0);
  if (reachability > 0) {
    factors.push({
      key: 'reachability',
      label: 'Canal de contato disponível',
      points: reachability,
    });
  }

  const raw = factors.reduce((total, factor) => total + factor.points, 0);
  return { score: Math.min(MAX_SCORE, raw), factors };
}

/**
 * Formatação de DADO (papel tipográfico próprio: mono + tabular-nums na UI).
 * Concentrada aqui para que "12:08", "R$ 4.800,00" e "23h38" tenham a mesma
 * forma em toda a aplicação — data espalhada por página vira dialeto.
 */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const hhmm = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const dayMonthYear = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const longDay = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'long' });
const full = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Dinheiro é sempre centavos inteiros (CLAUDE.md §3.11). */
export const formatCents = (cents: number) => brl.format(cents / 100);

export const timeOfDay = (value: Date | string) => hhmm.format(new Date(value));

/** Data e hora completas — só onde a precisão importa (title de um balão). */
export const fullStamp = (value: Date | string) => full.format(new Date(value));

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Distância em dias de calendário (não em múltiplos de 24h). */
function dayDistance(date: Date, now: Date) {
  return Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000);
}

/**
 * UM carimbo por linha: hora no mesmo dia, "ontem", dia/mês na semana, data
 * curta no resto. Data completa em toda linha competia com o nome do contato.
 */
export function relativeStamp(value: Date | string, now = new Date()): string {
  const date = new Date(value);
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) return 'agora';
  const days = dayDistance(date, now);
  if (days <= 0) return timeOfDay(date);
  if (days === 1) return 'ontem';
  if (days < 7) return `${days}d`;
  if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date);
  return dayMonthYear.format(date);
}

/** Separador de dia dentro da thread. */
export function dayLabel(value: Date | string, now = new Date()): string {
  const date = new Date(value);
  const days = dayDistance(date, now);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  return longDay.format(date);
}

export type WindowUrgency = 'none' | 'calm' | 'attention' | 'urgent' | 'closed';

export type WindowState = {
  urgency: WindowUrgency;
  /** milissegundos restantes (0 quando fechada) */
  remainingMs: number;
  /** fração de 24h ainda disponível, para o medidor */
  fraction: number;
  /** tempo exato, para render em mono */
  label: string;
};

const WINDOW_MS = 24 * 3_600_000;

/**
 * Janela de 24h do canal — o instante vem do SERVIDOR
 * (`SendPolicyDto.windowExpiresAt`); aqui só se lê o relógio, nunca a política.
 */
export function windowState(expiresAt: string | null, now = Date.now()): WindowState {
  if (!expiresAt) return { urgency: 'none', remainingMs: 0, fraction: 0, label: '' };
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) {
    return { urgency: 'closed', remainingMs: 0, fraction: 0, label: 'fechada' };
  }
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  const label = hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${minutes}min`;
  const urgency: WindowUrgency =
    remainingMs < 2 * 3_600_000 ? 'urgent' : remainingMs < 6 * 3_600_000 ? 'attention' : 'calm';
  return {
    urgency,
    remainingMs,
    fraction: Math.min(1, remainingMs / WINDOW_MS),
    label,
  };
}

/**
 * Conversões do formulário do catálogo. Dinheiro em centavos INTEIROS, nunca
 * float (CLAUDE.md §3.11): "1.500,50" vira 150050 por aritmética de texto.
 */

/** "150", "150,5", "150,50", "1.500,50", "R$ 1.500,50" → centavos; vazio → null; inválido → undefined. */
export function reaisToCents(text: string): number | null | undefined {
  const clean = text.replace(/R\$\s?/i, '').trim();
  if (clean === '') return null;
  const match = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/.exec(clean);
  if (!match) return undefined;
  const inteiros = Number.parseInt(match[1].replace(/\./g, ''), 10);
  const centavos = Number.parseInt((match[2] ?? '0').padEnd(2, '0'), 10);
  return inteiros * 100 + centavos;
}

/** 150050 → "1.500,50" (para o campo de edição, sem o "R$"). */
export function centsToReaisInput(cents: number | null): string {
  if (cents === null) return '';
  const inteiros = Math.floor(cents / 100).toLocaleString('pt-BR');
  return `${inteiros},${String(cents % 100).padStart(2, '0')}`;
}

/** "08:30" → 510; inválido → undefined. "24:00" é o fim do dia (1440). */
export function hhmmToMinutes(text: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const horas = Number(match[1]);
  const minutos = Number(match[2]);
  if (minutos > 59) return undefined;
  const total = horas * 60 + minutos;
  return total <= 1440 ? total : undefined;
}

/** 510 → "08:30". */
export function minutesToHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * FIM de intervalo no campo de hora: `<input type="time">` não exibe "24:00",
 * então o fim do dia é escrito "00:00" (convenção de agenda) e vale 1440.
 */
export function endInputToMinutes(text: string): number | undefined {
  return text.trim() === '00:00' ? 1440 : hhmmToMinutes(text);
}

/** 1440 → "00:00" (fim do dia), o resto como `minutesToHHMM`. */
export function minutesToEndInput(minutes: number): string {
  return minutes === 1440 ? '00:00' : minutesToHHMM(minutes);
}

export const WEEKDAYS: readonly { iso: number; label: string; short: string }[] = [
  { iso: 1, label: 'Segunda', short: 'Seg' },
  { iso: 2, label: 'Terça', short: 'Ter' },
  { iso: 3, label: 'Quarta', short: 'Qua' },
  { iso: 4, label: 'Quinta', short: 'Qui' },
  { iso: 5, label: 'Sexta', short: 'Sex' },
  { iso: 6, label: 'Sábado', short: 'Sáb' },
  { iso: 7, label: 'Domingo', short: 'Dom' },
];

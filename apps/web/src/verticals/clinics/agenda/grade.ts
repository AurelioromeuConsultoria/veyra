/**
 * Geometria da grade de horários da Agenda (ADR-062): só aritmética de minutos
 * do dia LOCAL da unidade. Nenhum relógio aqui — quem chama já leu as horas
 * locais que o servidor mandou (`localStart`) e o expediente do catálogo.
 */

/** Altura de uma hora na grade, em px (a do canvas aprovado). */
export const PX_POR_HORA = 64;
export const PX_POR_MINUTO = PX_POR_HORA / 60;

/** Sem expediente nem agendamento no dia, a grade mostra o horário comercial. */
const FAIXA_PADRAO = { inicio: 8 * 60, fim: 18 * 60 } as const;

export interface Intervalo {
  inicio: number;
  fim: number;
}

/** `HH:MM` → minuto do dia. */
export function minutosDe(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function hhmm(minuto: number): string {
  return `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
}

/**
 * Onde o agendamento fica na grade: começa na hora LOCAL de início (a do
 * servidor) e dura o que os instantes dizem — no dia da mudança de horário o
 * `localEnd` mente sobre a duração, os instantes não. Nunca passa da meia-noite.
 */
export function intervaloDoAgendamento(a: {
  localStart: string;
  startsAt: string;
  endsAt: string;
}): Intervalo {
  const inicio = minutosDe(a.localStart);
  const duracao = Math.max(5, Math.round((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000));
  return { inicio, fim: Math.min(1440, inicio + duracao) };
}

/**
 * A faixa de horas da grade: do começo do primeiro expediente (ou agendamento)
 * ao fim do último, arredondada para horas cheias. Agendamento fora do
 * expediente alarga a faixa — nada some da tela.
 */
export function faixaDoDia(intervalos: readonly Intervalo[]): Intervalo {
  if (intervalos.length === 0) return { ...FAIXA_PADRAO };
  const inicio = Math.min(...intervalos.map((i) => i.inicio));
  const fim = Math.max(...intervalos.map((i) => i.fim));
  return {
    inicio: Math.max(0, Math.floor(inicio / 60) * 60),
    fim: Math.min(1440, Math.max(Math.ceil(fim / 60) * 60, Math.floor(inicio / 60) * 60 + 60)),
  };
}

/** Os trechos da faixa fora do expediente do profissional (a grade os apaga). */
export function foraDoExpediente(faixa: Intervalo, expediente: readonly Intervalo[]): Intervalo[] {
  const ordenado = [...expediente].sort((a, b) => a.inicio - b.inicio);
  const fora: Intervalo[] = [];
  let cursor = faixa.inicio;
  for (const e of ordenado) {
    if (e.inicio > cursor) fora.push({ inicio: cursor, fim: Math.min(e.inicio, faixa.fim) });
    cursor = Math.max(cursor, e.fim);
    if (cursor >= faixa.fim) break;
  }
  if (cursor < faixa.fim) fora.push({ inicio: cursor, fim: faixa.fim });
  return fora.filter((f) => f.fim > f.inicio);
}

/**
 * Raias para os blocos que se sobrepõem na mesma coluna (um cancelado e o
 * novo horário no mesmo lugar, por exemplo): cada grupo que se encosta divide a
 * largura entre as raias que precisa, e cada bloco fica na primeira raia livre.
 */
export function raias<T extends Intervalo & { id: string }>(
  itens: readonly T[],
): Map<string, { raia: number; raias: number }> {
  const ordenados = [...itens].sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
  const resultado = new Map<string, { raia: number; raias: number }>();
  let grupo: { id: string; raia: number }[] = [];
  let fimDoGrupo = -Infinity;
  let fimDaRaia: number[] = [];
  const fecharGrupo = () => {
    for (const g of grupo) resultado.set(g.id, { raia: g.raia, raias: fimDaRaia.length });
    grupo = [];
    fimDaRaia = [];
  };
  for (const item of ordenados) {
    if (item.inicio >= fimDoGrupo) fecharGrupo();
    let raia = fimDaRaia.findIndex((fim) => fim <= item.inicio);
    if (raia === -1) {
      raia = fimDaRaia.length;
      fimDaRaia.push(item.fim);
    } else {
      fimDaRaia[raia] = item.fim;
    }
    grupo.push({ id: item.id, raia });
    fimDoGrupo = grupo.length === 1 ? item.fim : Math.max(fimDoGrupo, item.fim);
  }
  fecharGrupo();
  return resultado;
}

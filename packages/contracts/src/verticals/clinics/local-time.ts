/**
 * Hora LOCAL da unidade ↔ instante (ADR-048 adendo 4, item 3; adendo 5, item
 * 1). Função pura, sem dependência nova: a base de fusos é a do runtime
 * (`Intl`). Mora nos CONTRATOS para a tela e o servidor decidirem pela mesma
 * regra; quem decide continua sendo o servidor. O instante é a verdade; a
 * hora local é só leitura.
 */

export type ResolucaoDeHorario =
  | { kind: 'ok'; instante: Date }
  | { kind: 'inexistente' }
  | { kind: 'ambigua'; deslocamentos: string[] }
  | { kind: 'deslocamento_invalido' };

export interface HoraLocal {
  /** `AAAA-MM-DD` */
  data: string;
  /** `HH:MM` */
  hora: string;
  /** minutos desde a meia-noite local */
  minutoDoDia: number;
  /** ISO: 1 = segunda … 7 = domingo */
  diaDaSemana: number;
}

const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: fuso,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatadores.set(fuso, f);
  }
  return f;
}

function partes(instante: Date, fuso: string) {
  const p = Object.fromEntries(
    formatador(fuso)
      .formatToParts(instante)
      .map((parte) => [parte.type, parte.value]),
  );
  return {
    ano: Number(p.year),
    mes: Number(p.month),
    dia: Number(p.day),
    hora: Number(p.hour),
    minuto: Number(p.minute),
    segundo: Number(p.second),
  };
}

/** Deslocamento do fuso NESTE instante, em minutos (hora local − UTC). */
export function deslocamentoEmMinutos(instante: Date, fuso: string): number {
  const p = partes(instante, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  const semMilissegundos = Math.floor(instante.getTime() / 1000) * 1000;
  return Math.round((comoUtc - semMilissegundos) / 60_000);
}

/** `-180` → `-03:00` */
export function formatarDeslocamento(minutos: number): string {
  const sinal = minutos < 0 ? '-' : '+';
  const abs = Math.abs(minutos);
  return `${sinal}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function lerDeslocamento(valor: string): number {
  const sinal = valor.startsWith('-') ? -1 : 1;
  const [h, m] = valor.slice(1).split(':').map(Number);
  return sinal * (h * 60 + m);
}

/**
 * Todos os instantes cuja hora local, no fuso, é exatamente `data` `hora`:
 * nenhum no "pulo" da mudança de horário, dois na hora que se repete, um no
 * resto do ano. Com `deslocamento`, só o instante com esse deslocamento vale.
 */
export function resolverHoraLocal(
  data: string,
  hora: string,
  fuso: string,
  deslocamento?: string,
): ResolucaoDeHorario {
  const [ano, mes, dia] = data.split('-').map(Number);
  const [h, min] = hora.split(':').map(Number);
  const ingenuo = Date.UTC(ano, mes - 1, dia, h, min);

  const candidatos = new Set<number>();
  // os deslocamentos possíveis no entorno: um dia antes, no ponto e um dia depois
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const d = deslocamentoEmMinutos(new Date(ingenuo + delta), fuso);
    const instante = ingenuo - d * 60_000;
    if (deslocamentoEmMinutos(new Date(instante), fuso) === d) candidatos.add(instante);
  }
  const validos = [...candidatos].sort((a, b) => a - b);

  if (validos.length === 0) return { kind: 'inexistente' };
  if (deslocamento !== undefined) {
    const pedido = lerDeslocamento(deslocamento);
    const instante = ingenuo - pedido * 60_000;
    return validos.includes(instante)
      ? { kind: 'ok', instante: new Date(instante) }
      : { kind: 'deslocamento_invalido' };
  }
  if (validos.length === 1) return { kind: 'ok', instante: new Date(validos[0]) };
  return {
    kind: 'ambigua',
    deslocamentos: validos.map((v) =>
      formatarDeslocamento(deslocamentoEmMinutos(new Date(v), fuso)),
    ),
  };
}

/** Leitura do instante na hora local do fuso. */
export function horaLocal(instante: Date, fuso: string): HoraLocal {
  const p = partes(instante, fuso);
  const data = `${String(p.ano).padStart(4, '0')}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
  const hora = `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`;
  const diaUtc = new Date(Date.UTC(p.ano, p.mes - 1, p.dia)).getUTCDay();
  return {
    data,
    hora,
    minutoDoDia: p.hora * 60 + p.minuto,
    diaDaSemana: diaUtc === 0 ? 7 : diaUtc,
  };
}

/**
 * O INÍCIO do dia local `data` no fuso: o primeiro instante cuja data local é
 * `data` OU POSTERIOR (ADR-048 adendo 7, aprovação da F3.3 e o complemento da
 * F3.3a). Um dia local não tem sempre 24 horas, e a meia-noite pode não existir
 * ou se repetir:
 * - existe uma vez: é ela;
 * - repete (o relógio volta para 00:00): a PRIMEIRA ocorrência;
 * - cai no pulo (o relógio salta de 23:59 para 01:00): o instante em que o
 *   pulo termina, o primeiro horário local que existe naquele dia;
 * - o DIA não existe (Samoa pulou 2011-12-30 ao atravessar a linha de data): o
 *   início do dia seguinte que existe.
 * Um período local `[de, até)` vai do início de `de` ao início de `até`.
 */
export function inicioDoDiaLocal(data: string, fuso: string): Date {
  const [ano, mes, dia] = data.split('-').map(Number);
  const ingenuo = Date.UTC(ano, mes - 1, dia);
  // `AAAA-MM-DD` compara como data
  const chegou = (t: number) => horaLocal(new Date(t), fuso).data >= data;
  // o primeiro instante: já é o dia (ou depois), e o milissegundo anterior não
  const primeiro = (t: number) => chegou(t) && !chegou(t - 1);
  // candidatos: a meia-noite sob cada deslocamento do entorno (um dia antes, no
  // ponto e um dia depois). Na meia-noite que existe, é ela; na repetida, as
  // duas ocorrências; no pulo, a sob o deslocamento de antes cai exatamente no
  // fim do pulo
  const candidatos = [-86_400_000, 0, 86_400_000]
    .map((delta) => ingenuo - deslocamentoEmMinutos(new Date(ingenuo + delta), fuso) * 60_000)
    .filter(primeiro)
    .sort((a, b) => a - b);
  if (candidatos.length > 0) return new Date(candidatos[0]);
  // uma transição fora desses formatos: o primeiro minuto, por varredura (o dia
  // começa entre 15 h antes e, se não existir, 39 h depois da meia-noite em UTC)
  for (let t = ingenuo - 15 * 3_600_000; t <= ingenuo + 39 * 3_600_000; t += 60_000) {
    if (primeiro(t)) return new Date(t);
  }
  throw new Error(`Início do dia ${data} não encontrado no fuso ${fuso}`);
}

/** `AAAA-MM-DD` + `dias` (calendário puro, sem fuso). */
export function somarDias(data: string, dias: number): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, dia + dias)).toISOString().slice(0, 10);
}

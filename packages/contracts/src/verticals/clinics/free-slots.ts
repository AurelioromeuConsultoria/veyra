import { horaLocal, resolverHoraLocal, somarDias } from './local-time';

/**
 * O expediente e os horários livres da agenda (ADR-048 adendo 4, item 4;
 * adendo 5, item 3; ADR-062 adendo 1, parte B). Funções PURAS: uma regra só
 * para o servidor, que valida a marcação e a remarcação e calcula a sugestão
 * de remarcação, e para a tela da Agenda, que oferece os horários. Quem decide
 * continua sendo o servidor (e a sobreposição, o EXCLUDE do banco).
 */

/** Um intervalo de expediente: dia ISO (1 = segunda) e minutos locais `[início, fim)`. */
export interface IntervaloDeExpediente {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * Onde um atendimento `[inicio, fim)` cai no expediente, na hora LOCAL do
 * fuso da unidade:
 * - `ok`: começa e termina no mesmo dia local, dentro de UM intervalo;
 * - `dia`: atravessa a meia-noite local (terminar exatamente às 24:00 vale);
 * - `fora`: fora de todo intervalo do dia da semana em que começa.
 *
 * O fim local vem do INSTANTE de fim: atravessar uma mudança de horário pode
 * empurrá-lo para fora (adendo 4, item 4).
 */
export function encaixeNoExpediente(entrada: {
  inicio: Date;
  fim: Date;
  timezone: string;
  intervalos: readonly IntervaloDeExpediente[];
}): 'ok' | 'dia' | 'fora' {
  const inicioLocal = horaLocal(entrada.inicio, entrada.timezone);
  const fimLocal = horaLocal(entrada.fim, entrada.timezone);
  let fimMinuto: number;
  if (fimLocal.data === inicioLocal.data) fimMinuto = fimLocal.minutoDoDia;
  else if (fimLocal.data === somarDias(inicioLocal.data, 1) && fimLocal.minutoDoDia === 0)
    fimMinuto = 1440;
  else return 'dia';
  const cabe = entrada.intervalos.some(
    (i) =>
      i.weekday === inicioLocal.diaDaSemana &&
      i.startMinute <= inicioLocal.minutoDoDia &&
      fimMinuto <= i.endMinute,
  );
  return cabe ? 'ok' : 'fora';
}

export interface OpcaoDeHorario {
  /** único na lista: a hora e, na hora que se repete, o deslocamento */
  valor: string;
  rotulo: string;
  /** `HH:MM` local */
  hora: string;
  /** só na hora que se REPETE na mudança de horário */
  utcOffset?: string;
  /** o instante do início: a verdade */
  inicio: Date;
}

/** Dia da semana ISO (1 = segunda) de uma data de calendário. */
export function diaDaSemana(data: string): number {
  const [ano, mes, dia] = data.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
  return d === 0 ? 7 : d;
}

const hhmm = (minuto: number) =>
  `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;

/**
 * Horários LIVRES de um profissional num dia LOCAL da unidade, em ordem de
 * início: dentro do expediente (`encaixeNoExpediente`) e sem sobrepor os
 * agendamentos que ocupam o horário (`[início, fim)`, como o EXCLUDE). Os
 * inícios seguem a grade do passo a partir da meia-noite local: um expediente
 * às 08:07 começa a oferecer em 08:15 (o contrato só aceita passos de 5 min).
 * A hora inexistente da mudança de horário não aparece; a que se repete
 * aparece duas vezes, com o deslocamento de cada uma.
 */
export function horariosLivres(entrada: {
  data: string;
  timezone: string;
  duracaoMin: number;
  intervalos: readonly IntervaloDeExpediente[];
  ocupados: readonly { startsAt: string | Date; endsAt: string | Date }[];
  passoMin?: number;
}): OpcaoDeHorario[] {
  const passo = entrada.passoMin ?? 15;
  const dia = diaDaSemana(entrada.data);
  const doDia = entrada.intervalos.filter((i) => i.weekday === dia);
  const ocupados = entrada.ocupados.map((o) => [
    new Date(o.startsAt).getTime(),
    new Date(o.endsAt).getTime(),
  ]);
  // os minutos da grade que caem em algum intervalo do dia, sem repetir
  const minutos = new Set<number>();
  for (const intervalo of doDia) {
    const primeiro = Math.ceil(intervalo.startMinute / passo) * passo;
    for (let m = primeiro; m < intervalo.endMinute; m += passo) minutos.add(m);
  }
  const opcoes: OpcaoDeHorario[] = [];
  for (const m of [...minutos].sort((a, b) => a - b)) {
    const hora = hhmm(m);
    const r = resolverHoraLocal(entrada.data, hora, entrada.timezone);
    const candidatos =
      r.kind === 'ok'
        ? [{ instante: r.instante, utcOffset: undefined as string | undefined }]
        : r.kind === 'ambigua'
          ? r.deslocamentos.map((off) => {
              const c = resolverHoraLocal(entrada.data, hora, entrada.timezone, off);
              return { instante: (c as { instante: Date }).instante, utcOffset: off };
            })
          : [];
    candidatos.forEach((c, indice) => {
      const inicio = c.instante.getTime();
      const fim = inicio + entrada.duracaoMin * 60_000;
      const encaixe = encaixeNoExpediente({
        inicio: c.instante,
        fim: new Date(fim),
        timezone: entrada.timezone,
        intervalos: doDia,
      });
      if (encaixe !== 'ok') return;
      if (ocupados.some(([s, e]) => inicio < e && s < fim)) return;
      const rotulo =
        c.utcOffset === undefined
          ? hora
          : `${hora} (${indice === 0 ? 'antes' : 'depois'} da mudança de horário, ${c.utcOffset})`;
      opcoes.push({
        valor: `${hora}|${c.utcOffset ?? ''}`,
        rotulo,
        hora,
        utcOffset: c.utcOffset,
        inicio: c.instante,
      });
    });
  }
  // a hora que se repete fica em ordem de INSTANTE (o "depois" vem depois)
  return opcoes.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

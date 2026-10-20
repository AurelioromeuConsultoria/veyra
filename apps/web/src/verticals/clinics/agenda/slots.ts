import {
  horaLocal,
  resolverHoraLocal,
  somarDias,
  type ClinicsAppointmentStatus,
  type ClinicsCancelReason,
  type ClinicsWorkingIntervalDto,
} from '@veyra/contracts/verticals/clinics';

/** Estados que ocupam o horário: os mesmos do EXCLUDE no banco. */
export const ESTADOS_ATIVOS: readonly ClinicsAppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'arrived',
  'attended',
];

export const ROTULO_DO_ESTADO: Record<ClinicsAppointmentStatus, string> = {
  scheduled: 'Marcado',
  confirmed: 'Confirmado',
  arrived: 'Chegou',
  canceled: 'Cancelado',
  no_show: 'Faltou',
  attended: 'Atendido',
};

export const ROTULO_DO_MOTIVO: Record<ClinicsCancelReason, string> = {
  patient_request: 'Pedido do paciente',
  clinic_request: 'Pedido da clínica',
  professional_unavailable: 'Profissional indisponível',
  scheduling_error: 'Erro de agendamento',
};

/** Transições a partir de cada estado (as mesmas do servidor; ele decide). */
export const TRANSICOES: Record<
  ClinicsAppointmentStatus,
  readonly ('confirmed' | 'arrived' | 'canceled' | 'no_show')[]
> = {
  scheduled: ['confirmed', 'canceled', 'no_show'],
  confirmed: ['arrived', 'canceled', 'no_show'],
  arrived: [],
  canceled: [],
  no_show: [],
  attended: [],
};

export const ATENDIVEIS: readonly ClinicsAppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'arrived',
];

export interface OpcaoDeHorario {
  /** único na lista: a hora e, na hora que se repete, o deslocamento */
  valor: string;
  rotulo: string;
  hora: string;
  utcOffset?: string;
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
 * Horários LIVRES de um profissional num dia LOCAL da unidade (ADR-048 adendo
 * 5, item 3), pela mesma regra do servidor: dentro do expediente, com o fim
 * lido do instante de fim, e sem sobrepor os agendamentos ativos. A hora
 * inexistente da mudança de horário não aparece; a que se repete aparece duas
 * vezes, com o deslocamento de cada uma. O servidor continua decidindo.
 */
export function horariosLivres(entrada: {
  data: string;
  timezone: string;
  duracaoMin: number;
  intervalos: readonly ClinicsWorkingIntervalDto[];
  ocupados: readonly { startsAt: string; endsAt: string }[];
  passoMin?: number;
}): OpcaoDeHorario[] {
  const passo = entrada.passoMin ?? 15;
  const dia = diaDaSemana(entrada.data);
  const ocupados = entrada.ocupados.map((o) => [Date.parse(o.startsAt), Date.parse(o.endsAt)]);
  const opcoes: OpcaoDeHorario[] = [];
  const vistos = new Set<string>();
  for (const intervalo of entrada.intervalos.filter((i) => i.weekday === dia)) {
    // alinhado à GRADE do passo: um expediente às 08:07 começa a oferecer em
    // 08:15 (o servidor recusa minutos fora dos passos de 5)
    const primeiro = Math.ceil(intervalo.startMinute / passo) * passo;
    for (let m = primeiro; m < intervalo.endMinute; m += passo) {
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
        const fimLocal = horaLocal(new Date(fim), entrada.timezone);
        const fimMinuto =
          fimLocal.data === entrada.data
            ? fimLocal.minutoDoDia
            : fimLocal.data === somarDias(entrada.data, 1) && fimLocal.minutoDoDia === 0
              ? 1440
              : Infinity;
        if (fimMinuto > intervalo.endMinute) return;
        if (ocupados.some(([s, e]) => inicio < e && s < fim)) return;
        const valor = `${hora}|${c.utcOffset ?? ''}`;
        if (vistos.has(valor)) return;
        vistos.add(valor);
        const rotulo =
          c.utcOffset === undefined
            ? hora
            : `${hora} (${indice === 0 ? 'antes' : 'depois'} da mudança de horário, ${c.utcOffset})`;
        opcoes.push({ valor, rotulo, hora, utcOffset: c.utcOffset });
      });
    }
  }
  return opcoes;
}

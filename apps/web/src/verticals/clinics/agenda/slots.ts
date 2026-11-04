import {
  CLINICS_OCCUPYING_STATUSES,
  type ClinicsAppointmentStatus,
  type ClinicsCancelReason,
} from '@veyra/contracts/verticals/clinics';

/**
 * Os horários livres e o dia da semana moram nos CONTRATOS (ADR-062 adendo 1,
 * parte B): a mesma função pura que o servidor usa para validar o expediente
 * e para sugerir a remarcação. Reexportados aqui para a Agenda.
 */
export {
  diaDaSemana,
  horariosLivres,
  type OpcaoDeHorario,
} from '@veyra/contracts/verticals/clinics';

/** A chave de todas as agendas do dia no cache (invalidar recarrega a grade). */
export const AGENDA_KEY = ['clinics', 'appointments'] as const;

/** Estados que ocupam o horário: os mesmos do EXCLUDE no banco. */
export const ESTADOS_ATIVOS: readonly ClinicsAppointmentStatus[] = CLINICS_OCCUPYING_STATUSES;

export const ROTULO_DO_ESTADO: Record<ClinicsAppointmentStatus, string> = {
  scheduled: 'Marcado',
  confirmed: 'Confirmado',
  arrived: 'Chegou',
  canceled: 'Cancelado',
  no_show: 'Faltou',
  attended: 'Atendido',
};

/** O tom do estado (ADR-062): a mesma cor diz o mesmo estado em todo o app. */
export const TOM_DO_ESTADO: Record<
  ClinicsAppointmentStatus,
  'pending' | 'confirmed' | 'arrived' | 'done' | 'missed' | 'neutral'
> = {
  scheduled: 'pending',
  confirmed: 'confirmed',
  arrived: 'arrived',
  canceled: 'neutral',
  no_show: 'missed',
  attended: 'done',
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

import { z } from 'zod';
import type { BusinessOutboundReason } from '../../business-outbound';

export * from './local-time';

/**
 * Contratos do vertical Veyra Clinics (ADR-048). Expostos pelo subpath
 * `@veyra/contracts/verticals/clinics`: o barrel do Core NÃO os reexporta — o
 * Core não conhece o vertical (ADR-047, barreira de lint e teste de fronteira).
 */

/**
 * Catálogo de permissões do vertical (ADR-048 §5.1). Prefixo `clinics:`
 * obrigatório; registrado no catálogo global SÓ pela CLI de ativação.
 */
export const CLINICS_PERMISSION_CATALOG = {
  'clinics:catalog:read':
    'Ver unidades, serviços (com duração e preço), profissionais, serviços habilitados e horários',
  'clinics:catalog:manage':
    'Criar, editar e arquivar unidades, serviços, preços, profissionais e horários',
  'clinics:schedule:read':
    'Ver a agenda e o perfil operacional do paciente (sem atendimento, pacote ou saldo)',
  'clinics:schedule:write':
    'Criar perfil de paciente; agendar, remarcar, confirmar, cancelar; registrar chegada e falta',
  'clinics:care:read': 'Ver registros de atendimento, pacotes, saldo e histórico de retornos',
  'clinics:care:write':
    'Registrar atendimento realizado, consumir sessão, criar e encerrar pacote, gerar retorno',
  'clinics:restriction:manage':
    'Liberar um contato para uso de IA como sem relação com o Clinics, ou desfazer a liberação',
} as const;

export type ClinicsPermissionKey = keyof typeof CLINICS_PERMISSION_CATALOG;
export const CLINICS_PERMISSION_KEYS = Object.freeze(
  Object.keys(CLINICS_PERMISSION_CATALOG) as ClinicsPermissionKey[],
);

/** `systemKey` do papel padrão do vertical (ADR-047 E3: prefixo do vertical). */
export const CLINICS_PROFESSIONAL_SYSTEM_KEY = 'clinics:professional';

/**
 * Motivos, por LISTA FECHADA, para liberar um contato para IA (ADR-048 §6.4,
 * adendo 2 do ADR-047). Sem "outro" e sem texto livre.
 */
export const clinicsAiReleaseReasonSchema = z.enum([
  'supplier',
  'partner',
  'staff',
  'non_clinical_business',
]);
export type ClinicsAiReleaseReason = z.infer<typeof clinicsAiReleaseReasonSchema>;

export const grantClinicsAiReleaseSchema = z
  .object({ reason: clinicsAiReleaseReasonSchema })
  .strict();
export type GrantClinicsAiReleaseInput = z.infer<typeof grantClinicsAiReleaseSchema>;

export interface ClinicsStatusDto {
  /** o vertical está ATIVO no workspace da sessão */
  active: boolean;
}

/** Lista de liberações: cursor keyset (createdAt, id) desc, estável sob inserções. */
export const listClinicsAiReleasesSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListClinicsAiReleasesInput = z.infer<typeof listClinicsAiReleasesSchema>;

export interface ClinicsAiReleaseDto {
  contactId: string;
  /** nome do contato — a listagem exige também `contacts:read` */
  contactName: string;
  reason: ClinicsAiReleaseReason;
  releasedByMembershipId: string;
  createdAt: string;
}

export interface ClinicsAiReleasePageDto {
  items: ClinicsAiReleaseDto[];
  /** cursor da próxima página; null = fim */
  nextCursor: string | null;
}

// ── Catálogo da clínica (F1.c, ADR-048 adendo 1) ───────────────────────────

/**
 * Fuso IANA CANÔNICO, ou `null`. O construtor do `Intl` aceita mais do que a
 * lista IANA (caixa diferente, aliases, `EST`, offsets como `+03:00`, que o
 * Postgres lê com o sinal invertido). Por isso: canonizar pelo próprio runtime
 * e exigir que o resultado esteja em `Intl.supportedValuesOf('timeZone')` do
 * SERVIDOR, que é quem decide. A lista do navegador pode divergir (ex.: `UTC`,
 * `Etc/*`): a tela trata o 400 (ADR-048 adendo 1, itens 2 e 15).
 */
export function canonicalTimezone(value: string): string | null {
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
      .timeZone;
    return Intl.supportedValuesOf('timeZone').includes(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** `?includeArchived=true`. Explícito: `z.coerce.boolean()` faria de "false" um `true`. */
export const clinicsCatalogListQuerySchema = z
  .object({
    includeArchived: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .strict();
export type ClinicsCatalogListQuery = z.infer<typeof clinicsCatalogListQuerySchema>;

const catalogName = z
  .string()
  .trim()
  .min(1, 'Informe o nome')
  .max(80, 'Use no máximo 80 caracteres');
/** de 5 a 480 minutos, em passos de 5 (o banco garante o mesmo por CHECK) */
const durationMin = z.number().int().min(5).max(480).multipleOf(5);
/** centavos, nunca float; teto de R$ 1.000.000,00 por sanidade */
const priceCents = z.number().int().min(0).max(100_000_000);
/**
 * Intervalo do retorno automático, em dias, contado da data local do registro
 * de atendimento (ADR-048 adendo 7, F3.2). `null` = o serviço não gera retorno.
 */
const returnIntervalDays = z.number().int().min(1).max(365);

export const createClinicsServiceSchema = z
  .object({
    name: catalogName,
    durationMin,
    priceCents: priceCents.nullable().default(null),
    currency: z.literal('BRL').default('BRL'),
    returnIntervalDays: returnIntervalDays.nullable().default(null),
  })
  .strict();
export type CreateClinicsServiceInput = z.infer<typeof createClinicsServiceSchema>;

/** Sem defaults: um PATCH que não cita o preço não pode zerá-lo. */
export const updateClinicsServiceSchema = z
  .object({
    name: catalogName.optional(),
    durationMin: durationMin.optional(),
    priceCents: priceCents.nullable().optional(),
    returnIntervalDays: returnIntervalDays.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nada a alterar' });
export type UpdateClinicsServiceInput = z.infer<typeof updateClinicsServiceSchema>;

export const updateClinicsUnitSchema = z
  .object({
    name: catalogName.optional(),
    timezone: z
      .string()
      .max(64)
      .transform((value, ctx) => {
        const canonical = canonicalTimezone(value);
        if (!canonical) {
          ctx.addIssue({ code: 'custom', message: 'Fuso horário inválido (use o formato IANA)' });
          return z.NEVER;
        }
        return canonical;
      })
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nada a alterar' });
export type UpdateClinicsUnitInput = z.infer<typeof updateClinicsUnitSchema>;

/** Renomear (PATCH) só trata do nome; criar e salvar levam o perfil inteiro. */
export const clinicsProfessionalNameSchema = z.object({ name: catalogName }).strict();
export type ClinicsProfessionalNameInput = z.infer<typeof clinicsProfessionalNameSchema>;

/**
 * Vínculo com uma conta (opcional, no máximo um profissional por conta).
 * Rota PRÓPRIA porque exige também `members:read`: a autorização fica
 * declarativa, e cadastrar um nome não pede acesso à lista de membros.
 * `null` desfaz o vínculo. Vincular não muda papel nenhum.
 */
export const setClinicsProfessionalAccountSchema = z
  .object({ membershipId: z.uuid().nullable() })
  .strict();
export type SetClinicsProfessionalAccountInput = z.infer<
  typeof setClinicsProfessionalAccountSchema
>;

/** Intervalo semanal `[início, fim)`, em minutos do dia, na hora local da unidade. */
export const clinicsWorkingIntervalSchema = z
  .object({
    unitId: z.uuid(),
    /** ISO: 1 = segunda … 7 = domingo */
    weekday: z.number().int().min(1).max(7),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
  })
  .strict()
  .refine((value) => value.startMinute < value.endMinute, {
    message: 'O início precisa ser antes do fim',
  });
export type ClinicsWorkingInterval = z.infer<typeof clinicsWorkingIntervalSchema>;

const NOMES_DOS_DIAS = [
  '',
  'na segunda',
  'na terça',
  'na quarta',
  'na quinta',
  'na sexta',
  'no sábado',
  'no domingo',
];

/** Serviços que o profissional faz: o CONJUNTO inteiro, sem repetição. */
const serviceIdsField = z
  .array(z.uuid())
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Serviço repetido' });

/**
 * A SEMANA inteira. Sobreposição no mesmo dia é recusada aqui (400, com
 * mensagem clara) e, por último, pelo banco (409). Vale entre unidades:
 * ninguém atende em dois lugares ao mesmo tempo.
 */
const intervalsField = z
  .array(clinicsWorkingIntervalSchema)
  .max(100)
  .superRefine((intervals, ctx) => {
    const byDay = new Map<number, { startMinute: number; endMinute: number }[]>();
    for (const interval of intervals) {
      const day = byDay.get(interval.weekday) ?? [];
      day.push(interval);
      byDay.set(interval.weekday, day);
    }
    for (const [weekday, day] of byDay) {
      day.sort((a, b) => a.startMinute - b.startMinute);
      for (let i = 1; i < day.length; i += 1) {
        if (day[i].startMinute < day[i - 1].endMinute) {
          ctx.addIssue({
            code: 'custom',
            message: `Intervalos sobrepostos ${NOMES_DOS_DIAS[weekday]}`,
          });
          return;
        }
      }
    }
  });

export const setClinicsProfessionalServicesSchema = z
  .object({ serviceIds: serviceIdsField })
  .strict();
export type SetClinicsProfessionalServicesInput = z.infer<
  typeof setClinicsProfessionalServicesSchema
>;

export const setClinicsWorkingHoursSchema = z.object({ intervals: intervalsField }).strict();
export type SetClinicsWorkingHoursInput = z.infer<typeof setClinicsWorkingHoursSchema>;

/**
 * PERFIL do profissional: nome, serviços habilitados e semana, gravados JUNTOS
 * numa transação (ADR-048 adendo 1, item 23) — é o que o drawer SALVA. Todos
 * os campos são obrigatórios: o PUT SUBSTITUI os conjuntos, e um default faria
 * um corpo só com o nome apagar serviços e horários sem erro. O vínculo com
 * conta fica de fora: exige outra permissão e tem rota própria.
 */
export const clinicsProfessionalProfileSchema = z
  .object({ name: catalogName, serviceIds: serviceIdsField, intervals: intervalsField })
  .strict();
export type ClinicsProfessionalProfileInput = z.infer<typeof clinicsProfessionalProfileSchema>;

/** CRIAR: o mesmo perfil, com serviços e semana opcionais (vazios por padrão). */
export const createClinicsProfessionalSchema = z
  .object({
    name: catalogName,
    serviceIds: serviceIdsField.default([]),
    intervals: intervalsField.default([]),
  })
  .strict();
export type CreateClinicsProfessionalInput = z.infer<typeof createClinicsProfessionalSchema>;

export interface ClinicsUnitDto {
  id: string;
  name: string;
  timezone: string;
}

export interface ClinicsServiceDto {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number | null;
  currency: string;
  /** dias até o retorno automático; `null` = sem retorno (F3.2) */
  returnIntervalDays: number | null;
  archivedAt: string | null;
}

export interface ClinicsProfessionalDto {
  id: string;
  name: string;
  /**
   * Conta vinculada: só o id e se ela continua ativa. Nome e e-mail da pessoa
   * vêm da API de membros, para quem tem `members:read` — o catálogo não os
   * entrega a quem só lê o catálogo.
   */
  account: { membershipId: string; active: boolean } | null;
  serviceIds: string[];
  workingHours: ClinicsWorkingIntervalDto[];
  archivedAt: string | null;
}

/** Saída: interface própria, não o tipo inferido do schema de entrada (CLAUDE.md §3.9). */
export interface ClinicsWorkingIntervalDto {
  unitId: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}

// ── Paciente (F2.1, ADR-048 adendo 2) ──────────────────────────────────────

/**
 * Tornar um contato PACIENTE: ato explícito, com consequências — o contato
 * fica restrito para IA mesmo com liberação, e excluí-lo passa a ser recusado.
 */
export const createClinicsPatientSchema = z.object({ contactId: z.uuid() }).strict();
export type CreateClinicsPatientInput = z.infer<typeof createClinicsPatientSchema>;

/**
 * Lista de pacientes. `contactIds` (até 50, separados por vírgula) restringe a
 * resposta a esses contatos: a tela de liberação marca "não liberável" só nos
 * resultados da busca, sem baixar a lista inteira (minimização, classe S).
 */
export const listClinicsPatientsSchema = z.object({
  contactIds: z
    .string()
    .max(50 * 37)
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.uuid()).min(1).max(50).optional()),
  /**
   * Busca pelo nome (a partir de 2 letras): quem agenda escolhe UM paciente
   * sem baixar a lista inteira (minimização, classe S; ADR-048 adendo 5).
   */
  search: z.string().trim().min(2).max(80).optional(),
  /** Os mais recentes primeiro; a tela avisa quando o teto corta a lista. */
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListClinicsPatientsInput = z.infer<typeof listClinicsPatientsSchema>;

export interface ClinicsPatientDto {
  id: string;
  /** omitido no servidor para quem não tem `contacts:read` (autorização de campo) */
  contactId?: string;
  /** do contato; nada clínico existe no perfil (classe S, H7) */
  name: string;
  createdAt: string;
}

// ── Agenda e atendimento (F2.2, ADR-048 adendo 4) ──────────────────────────

export const clinicsAppointmentStatusSchema = z.enum([
  'scheduled',
  'confirmed',
  'arrived',
  'canceled',
  'no_show',
  'attended',
]);
export type ClinicsAppointmentStatus = z.infer<typeof clinicsAppointmentStatusSchema>;

/** Motivo de cancelamento, por LISTA FECHADA: sem "outro" e sem texto livre. */
export const clinicsCancelReasonSchema = z.enum([
  'patient_request',
  'clinic_request',
  'professional_unavailable',
  'scheduling_error',
]);
export type ClinicsCancelReason = z.infer<typeof clinicsCancelReasonSchema>;

/** Data LOCAL da unidade, `AAAA-MM-DD`, que precisa existir no calendário. */
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use AAAA-MM-DD')
  .refine((value) => {
    const [ano, mes, dia] = value.split('-').map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    return (
      data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia
    );
  }, 'Data inexistente')
  // antes dos fusos padronizados o deslocamento tem segundos, e a hora local
  // deixaria de ser exata; uma agenda não precisa de mais que isto
  .refine((value) => {
    const ano = Number(value.slice(0, 4));
    return ano >= 2000 && ano <= 2100;
  }, 'Use um ano entre 2000 e 2100');

/** Hora LOCAL da unidade, `HH:MM`, em passos de 5 minutos (como as durações). */
const localTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM')
  .refine((value) => Number(value.slice(3)) % 5 === 0, 'Use passos de 5 minutos');

/**
 * Desambiguador da hora que se REPETE na mudança de horário (ex.: `-03:00`).
 * Só necessário quando a hora local é ambígua (ADR-048 adendo 4, item 3).
 */
const utcOffset = z.string().regex(/^[+-](0\d|1[0-4]):[0-5]\d$/, 'Use ±HH:MM');

export const createClinicsAppointmentSchema = z
  .object({
    patientId: z.uuid(),
    professionalId: z.uuid(),
    serviceId: z.uuid(),
    /** sem ela, vale a única unidade ativa (no MVP há uma por workspace) */
    unitId: z.uuid().optional(),
    date: localDate,
    time: localTime,
    utcOffset: utcOffset.optional(),
  })
  .strict();
export type CreateClinicsAppointmentInput = z.infer<typeof createClinicsAppointmentSchema>;

/** Remarcar conserva a duração registrada; trocar o serviço a recalcula. */
export const rescheduleClinicsAppointmentSchema = z
  .object({
    date: localDate,
    time: localTime,
    utcOffset: utcOffset.optional(),
    serviceId: z.uuid().optional(),
  })
  .strict();
export type RescheduleClinicsAppointmentInput = z.infer<typeof rescheduleClinicsAppointmentSchema>;

/** `attended` NÃO está aqui: só o registro de atendimento chega lá. */
export const changeClinicsAppointmentStatusSchema = z
  .object({
    to: z.enum(['confirmed', 'arrived', 'canceled', 'no_show']),
    cancelReason: clinicsCancelReasonSchema.optional(),
  })
  .strict()
  .refine((value) => (value.to === 'canceled') === (value.cancelReason !== undefined), {
    message: 'Cancelamento exige motivo; as outras mudanças não aceitam motivo',
    path: ['cancelReason'],
  });
export type ChangeClinicsAppointmentStatusInput = z.infer<
  typeof changeClinicsAppointmentStatusSchema
>;

/** O dia LOCAL de uma unidade. Sem `unitId`, vale a única unidade ativa. */
export const listClinicsAppointmentsSchema = z.object({
  date: localDate,
  unitId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
});
export type ListClinicsAppointmentsInput = z.infer<typeof listClinicsAppointmentsSchema>;

export interface ClinicsAppointmentDto {
  id: string;
  patientId: string;
  /** do contato: o paciente aparece na agenda só pelo nome (§5.2) */
  patientName: string;
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
  unitId: string;
  /** instantes ISO (UTC) — a verdade */
  startsAt: string;
  endsAt: string;
  /** leitura na hora local da UNIDADE */
  localDate: string;
  localStart: string;
  localEnd: string;
  status: ClinicsAppointmentStatus;
  cancelReason: ClinicsCancelReason | null;
  /** omitido no servidor para quem não tem `clinics:care:read` (autorização de campo) */
  attendanceId?: string | null;
}

export interface ClinicsAttendanceDto {
  id: string;
  appointmentId: string;
  professionalId: string;
  completedAt: string;
  /** o pacote consumido por ESTE atendimento; `null` = avulso (ADR-048 adendo 7) */
  packageId: string | null;
}

/**
 * Registro de atendimento (ADR-048 adendo 7, F3.1 e ajuste A1). A escolha é
 * EXPLÍCITA e obrigatória: `packageId: null` é avulso, e o id é o pacote. O
 * corpo vazio e `{}` são recusados (400), e o corpo que não é JSON também
 * (415): nada decide pela pessoa. Repetir o mesmo pedido devolve o registro
 * existente; repetir com escolha diferente é 409.
 */
export const recordClinicsAttendanceSchema = z
  .object({
    /** obrigatória: `null` = avulso (ajuste A1) */
    packageId: z.uuid().nullable(),
  })
  .strict();
export type RecordClinicsAttendanceInput = z.infer<typeof recordClinicsAttendanceSchema>;

export const CLINICS_PACKAGE_STATUSES = ['active', 'completed', 'canceled'] as const;
export type ClinicsPackageStatus = (typeof CLINICS_PACKAGE_STATUSES)[number];

/**
 * Pacote de sessões (ADR-048 adendo 7, F3.1). Classe S. O PREÇO é o TOTAL do
 * pacote, digitado e confirmado por quem cria, e congelado; ausente significa
 * "não informado" — nunca zero nem gratuito. Nada disto é gestão financeira
 * (D1 em aberto): não há desconto, pagamento nem quitação.
 */
export const createClinicsPackageSchema = z
  .object({
    patientId: z.uuid(),
    serviceId: z.uuid(),
    totalSessions: z.number().int().min(1).max(100),
    totalPriceCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  })
  .strict();
export type CreateClinicsPackageInput = z.infer<typeof createClinicsPackageSchema>;

export const listClinicsPackagesSchema = z.object({ patientId: z.uuid() });
export type ListClinicsPackagesInput = z.infer<typeof listClinicsPackagesSchema>;

export interface ClinicsPackageDto {
  id: string;
  patientId: string;
  serviceId: string;
  totalSessions: number;
  consumedSessions: number;
  /** derivado: `totalSessions − consumedSessions` */
  remainingSessions: number;
  /** `null` = não informado (nunca zero implícito) */
  totalPriceCents: number | null;
  currency: string;
  status: ClinicsPackageStatus;
  createdAt: string;
  closedAt: string | null;
}

// ── Retornos (ADR-048 adendo 7, F3.2) ─────────────────────────────────────

export const CLINICS_RETURN_STATUSES = ['pending', 'done', 'canceled'] as const;
export type ClinicsReturnStatus = (typeof CLINICS_RETURN_STATUSES)[number];

/**
 * Encerramento SEM atendimento, por lista fechada (sem "outro" e sem texto):
 * - `patient_declined` e `patient_unreachable`: recepção ou profissional;
 * - `not_needed`: decisão clínica, só `clinics:care:write`;
 * - `created_in_error`: só `clinics:care:write`, e só no retorno criado à mão.
 */
export const CLINICS_RETURN_CANCEL_REASONS = [
  'patient_declined',
  'patient_unreachable',
  'not_needed',
  'created_in_error',
] as const;
export type ClinicsReturnCancelReason = (typeof CLINICS_RETURN_CANCEL_REASONS)[number];

/** Criação manual (`clinics:care:write`). O automático nasce do atendimento. */
export const createClinicsReturnSchema = z
  .object({
    patientId: z.uuid(),
    serviceId: z.uuid(),
    /** omitida: a única unidade ativa (MVP) */
    unitId: z.uuid().optional(),
    /** data local da unidade */
    dueDate: localDate,
    assigneeMembershipId: z.uuid().nullable().optional(),
  })
  .strict();
export type CreateClinicsReturnInput = z.infer<typeof createClinicsReturnSchema>;

/** Vincular (ou trocar) o agendamento que vai cumprir o retorno. */
export const linkClinicsReturnSchema = z.object({ appointmentId: z.uuid() }).strict();
export type LinkClinicsReturnInput = z.infer<typeof linkClinicsReturnSchema>;

export const cancelClinicsReturnSchema = z
  .object({ reason: z.enum(CLINICS_RETURN_CANCEL_REASONS) })
  .strict();
export type CancelClinicsReturnInput = z.infer<typeof cancelClinicsReturnSchema>;

/** `null` tira o responsável. */
export const assignClinicsReturnSchema = z.object({ membershipId: z.uuid().nullable() }).strict();
export type AssignClinicsReturnInput = z.infer<typeof assignClinicsReturnSchema>;

/**
 * Filtros PERMITIDOS da lista. Estrito: filtro ou ordenação por origem,
 * criador, atendimento de origem ou pacote não existem, para a lista não virar
 * consulta indireta de vínculos ocultos. A ordem é sempre vencimento, depois id.
 */
export const listClinicsReturnsSchema = z
  .object({
    status: z.enum(CLINICS_RETURN_STATUSES).optional(),
    overdue: z.enum(['true', 'false']).optional(),
    unitId: z.uuid().optional(),
    dueFrom: localDate.optional(),
    dueTo: localDate.optional(),
    /** um membro, ou `none` para os sem responsável */
    assignee: z.union([z.uuid(), z.literal('none')]).optional(),
    patientId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type ListClinicsReturnsInput = z.infer<typeof listClinicsReturnsSchema>;

export interface ClinicsReturnDto {
  id: string;
  patientId: string;
  patientName: string;
  serviceId: string;
  serviceName: string;
  unitId: string;
  /** data local da unidade, `AAAA-MM-DD` */
  dueDate: string;
  status: ClinicsReturnStatus;
  /** pendente com vencimento antes de hoje, na data local da unidade */
  overdue: boolean;
  /** `hasAccess: false`: o responsável perdeu o acesso e precisa ser trocado */
  assignee: { membershipId: string; name: string; hasAccess: boolean } | null;
  /** o agendamento vinculado (o que cumpriu, se `done`) */
  appointment: { id: string; startsAt: string; status: ClinicsAppointmentStatus } | null;
  closedAt: string | null;
  /**
   * Autorização de CAMPO: os itens abaixo só vêm para quem tem
   * `clinics:care:read`. Para quem tem só a agenda, o cancelado aparece sem o
   * motivo, e a origem e a criação não aparecem (aproximariam o atendimento de
   * origem).
   */
  origin?: 'automatic' | 'manual';
  originAttendanceId?: string | null;
  cancelReason?: ClinicsReturnCancelReason | null;
  createdAt?: string;
}

/** Candidato a responsável: só o necessário para escolher, sem a lista de membros. */
export interface ClinicsReturnAssigneeDto {
  membershipId: string;
  name: string;
}

/**
 * Candidatos ao vínculo de um retorno (F3.3a): agendamentos do mesmo paciente,
 * serviço e unidade, em estado que aceita vínculo e sem vínculo a retorno. Só
 * critérios VISÍVEIS na agenda: a lista não depende da prova nem da origem
 * (nem na contagem, nem na ordem, nem na paginação). Seleção, não garantia: o
 * vínculo reconfere tudo. Paginada, sem truncamento silencioso.
 */
export const listClinicsReturnCandidatesSchema = z
  .object({
    /** data LOCAL da unidade: a partir do início desse dia (inclusivo) */
    from: localDate.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /** opaco: o `nextCursor` da página anterior */
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ListClinicsReturnCandidatesInput = z.infer<typeof listClinicsReturnCandidatesSchema>;

export interface ClinicsReturnCandidateDto {
  id: string;
  /** instante ISO (UTC) */
  startsAt: string;
  status: ClinicsAppointmentStatus;
  professionalName: string;
}

export interface ClinicsReturnCandidatesPageDto {
  items: ClinicsReturnCandidateDto[];
  /** `null` = não há mais */
  nextCursor: string | null;
}

// ── Taxa de faltas (F3.3a; ADR-048 adendo 7, item 7 e aprovação da F3.3) ─────

/**
 * Período em datas LOCAIS da unidade: `from` inclusivo, `to` EXCLUSIVO, pelo
 * INÍCIO do agendamento. Os limites são o início de cada dia local (que nem
 * sempre tem 24 horas: `inicioDoDiaLocal`). No máximo 366 dias.
 */
export const clinicsNoShowQuerySchema = z
  .object({
    from: localDate,
    to: localDate,
    /** obrigatória quando há mais de uma unidade ativa */
    unitId: z.uuid().optional(),
    professionalId: z.uuid().optional(),
    serviceId: z.uuid().optional(),
  })
  .strict()
  .refine((q) => q.from < q.to, { message: 'O fim do período vem depois do início', path: ['to'] })
  .refine(
    (q) =>
      (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 <= 366,
    { message: 'O período tem no máximo 366 dias', path: ['to'] },
  );
export type ClinicsNoShowQuery = z.infer<typeof clinicsNoShowQuerySchema>;

/** Só AGREGADOS: nenhuma pessoa, nenhum agendamento. */
export interface ClinicsNoShowDto {
  from: string;
  to: string;
  unitId: string;
  attended: number;
  noShow: number;
  /**
   * `noShow / (attended + noShow)`, de 0 a 1. `null` = "sem dados": só quando
   * atendidos + faltas = 0. Com atendidos e nenhuma falta, é 0 (legítimo).
   */
  rate: number | null;
  /** marcados, confirmados e chegados com início antes de agora (relógio do banco); fora da conta */
  pendingPast: number;
  /** à parte, fora da conta */
  canceled: number;
}

// ── O envio iniciado pela clínica (F4.2, ADR-048 adendos 8 e 9) ──────────────

/**
 * O tipo do pedido de envio: a CONFIRMAÇÃO de um horário marcado ou a
 * REATIVAÇÃO de um retorno vencido. Cada um tem a sua finalidade do Core, e
 * uma não herda o consentimento da outra (V2).
 */
export const CLINICS_OUTREACH_KINDS = ['confirmation', 'reactivation'] as const;
export const clinicsOutreachKindSchema = z.enum(CLINICS_OUTREACH_KINDS);
export type ClinicsOutreachKind = z.infer<typeof clinicsOutreachKindSchema>;

/**
 * A finalidade do Core que cada tipo aceita, pela CHAVE, e os campos que ela
 * pode ter — o conteúdo mínimo aprovado (adendo 9, decisão 1): a confirmação,
 * o primeiro nome, a data e a hora; a reativação, só o primeiro nome. Uma
 * finalidade com outro campo (o nome inteiro, por exemplo) é recusada.
 */
export const CLINICS_OUTREACH_PURPOSES: Readonly<
  Record<ClinicsOutreachKind, { key: string; fields: readonly string[] }>
> = {
  confirmation: {
    key: 'clinics_confirmacao',
    fields: ['contato.primeiro_nome', 'clinics.data', 'clinics.hora'],
  },
  reactivation: { key: 'clinics_reativacao', fields: ['contato.primeiro_nome'] },
};

/**
 * O estado do pedido, DERIVADO da aprovação e do despacho do Core — não há
 * sincronização (adendo 8, item 3):
 * - `draft`: ainda sem aprovação;
 * - `pending`: aprovado, e o despacho ainda pode sair;
 * - `sent`: saiu;
 * - `not_sent`: comprovadamente não saiu (cancelado, recusado, vencido, ou o
 *   alvo deixou de valer antes da aprovação);
 * - `uncertain`: pode ter saído — nunca é reenviado (C5).
 */
export const CLINICS_OUTREACH_STATES = [
  'draft',
  'pending',
  'sent',
  'not_sent',
  'uncertain',
] as const;
export type ClinicsOutreachState = (typeof CLINICS_OUTREACH_STATES)[number];

/**
 * Os candidatos: na confirmação, os agendamentos marcados ou confirmados dos
 * próximos dias locais da unidade (`date` inclusivo, `days` dias); na
 * reativação, os retornos pendentes, sem agendamento, já vencidos.
 */
export const listClinicsOutreachCandidatesSchema = z
  .object({
    kind: clinicsOutreachKindSchema,
    date: localDate.optional(),
    days: z.coerce.number().int().min(1).max(7).optional(),
    /** obrigatória quando há mais de uma unidade ativa */
    unitId: z.uuid().optional(),
  })
  .strict();
export type ListClinicsOutreachCandidatesInput = z.infer<
  typeof listClinicsOutreachCandidatesSchema
>;

/** O alvo do pedido: o agendamento (confirmação) ou o retorno (reativação). */
const alvoDoPedidoSchema = z.union([
  z.object({ appointmentId: z.uuid() }).strict(),
  z.object({ returnId: z.uuid() }).strict(),
]);

/** Preparar os pedidos: um por alvo. O pedido nasce ANTES da prévia (adendo 9, decisão 6). */
export const prepareClinicsOutreachSchema = z
  .object({
    kind: clinicsOutreachKindSchema,
    targets: z.array(alvoDoPedidoSchema).min(1).max(50),
  })
  .strict();
export type PrepareClinicsOutreachInput = z.infer<typeof prepareClinicsOutreachSchema>;

/** O número exato do contato, como no Core: "+dígitos". */
const numeroDoPedidoSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Número no formato +dígitos');

/** O item da prévia: o pedido e as escolhas do envio (o canal, o número, a versão e a finalidade). */
const itemDoEnvioSchema = z
  .object({
    requestId: z.uuid(),
    channelId: z.uuid(),
    number: numeroDoPedidoSchema,
    templateVersionId: z.uuid(),
    purposeId: z.uuid(),
  })
  .strict();

export const previewClinicsOutreachSchema = z
  .object({ items: z.array(itemDoEnvioSchema).min(1).max(50) })
  .strict();
export type PreviewClinicsOutreachInput = z.infer<typeof previewClinicsOutreachSchema>;

/** O item aprovado: o da prévia, mais o prazo e o hash que a pessoa viu. */
export const approveClinicsOutreachSchema = z
  .object({
    items: z
      .array(
        itemDoEnvioSchema
          .extend({
            expiresAt: z.string().datetime({ offset: false }),
            approvalHash: z.string().regex(/^[0-9a-f]{64}$/, 'HMAC-SHA256 em hexadecimal'),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ApproveClinicsOutreachInput = z.infer<typeof approveClinicsOutreachSchema>;

/**
 * Os motivos do vertical, além dos do Core (`BusinessOutboundReason`), que
 * passam como vieram. Lista fechada; nenhum traz dado do paciente.
 */
export const CLINICS_OUTREACH_REASONS = [
  // o alvo não existe, ou não é do tipo pedido
  'target_not_found',
  // o agendamento não está marcado ou confirmado; o retorno não está pendente sem agendamento
  'target_invalid',
  // a confirmação deixa de ser elegível a duas horas do início (adendo 9, decisão 4)
  'starts_too_soon',
  // o alvo já tem um pedido que conta: em rascunho, aguardando, enviado ou incerto
  'request_exists',
  // o pedido não existe, ou não está em rascunho (já aprovado, ou encerrado)
  'request_not_found',
  'request_not_draft',
  // a finalidade não é a do tipo, ou permite campo além do conteúdo mínimo
  'purpose_not_allowed',
  // o texto contém o nome de um serviço ou de um profissional do catálogo (apoio à revisão)
  'catalog_name_in_text',
] as const;
export type ClinicsOutreachReason = (typeof CLINICS_OUTREACH_REASONS)[number];

/** Um candidato, com o que impede preparar o pedido agora. */
export interface ClinicsOutreachCandidateDto {
  kind: ClinicsOutreachKind;
  appointmentId: string | null;
  returnId: string | null;
  /** a confirmação: o início, e a data e a hora locais da unidade */
  startsAt: string | null;
  localDate: string | null;
  localStart: string | null;
  /** a reativação: o vencimento (data local) */
  dueDate: string | null;
  patientId: string;
  patientName: string;
  contactId: string;
  /** os números exatos do contato: quem prepara escolhe um */
  numbers: string[];
  /** `null` = pode preparar */
  blocked: Extract<ClinicsOutreachReason, 'starts_too_soon' | 'request_exists'> | null;
  /** o pedido que conta para este alvo, se houver */
  request: { id: string; state: ClinicsOutreachState } | null;
}

/**
 * O pedido, lido com `clinics:schedule:read`. O número completo só com
 * `contacts:read`, e o motivo do não envio só com `contacts:read` e
 * `consents:read`: ele pode revelar a situação do consentimento (adendo 9,
 * decisão 3).
 */
export interface ClinicsOutreachRequestDto {
  id: string;
  kind: ClinicsOutreachKind;
  appointmentId: string | null;
  startsAt: string | null;
  returnId: string | null;
  state: ClinicsOutreachState;
  /** o texto da prévia; `null` antes dela e depois do desfecho terminal (minimização) */
  text: string | null;
  /** o número aprovado; mascarado sem `contacts:read`; `null` antes da aprovação */
  number: string | null;
  /** o motivo do Core; `null` sem `contacts:read` e `consents:read` */
  reason: string | null;
  createdAt: string;
}

export type ClinicsOutreachPrepareItemDto =
  | { index: number; ok: true; request: ClinicsOutreachRequestDto }
  | {
      index: number;
      ok: false;
      reason:
        | Extract<
            ClinicsOutreachReason,
            'target_not_found' | 'target_invalid' | 'starts_too_soon' | 'request_exists'
          >
        // uma mudança do mesmo alvo segurava a trava: tente de novo
        | Extract<BusinessOutboundReason, 'busy'>;
    };

export interface ClinicsOutreachPrepareDto {
  items: ClinicsOutreachPrepareItemDto[];
}

export type ClinicsOutreachPreviewItemDto =
  | {
      index: number;
      ok: true;
      text: string;
      values: Record<string, string>;
      expiresAt: string;
      approvalHash: string;
    }
  | { index: number; ok: false; reason: ClinicsOutreachReason | BusinessOutboundReason };

export interface ClinicsOutreachPreviewDto {
  items: ClinicsOutreachPreviewItemDto[];
}

/** A resposta do lote: só ids, estados e motivos (é a guardada no replay). */
export interface ClinicsOutreachResultItemDto {
  index: number;
  requestId: string;
  state: 'approved' | 'refused';
  messageId: string | null;
  reason: ClinicsOutreachReason | BusinessOutboundReason | null;
}

export interface ClinicsOutreachResultDto {
  items: ClinicsOutreachResultItemDto[];
}

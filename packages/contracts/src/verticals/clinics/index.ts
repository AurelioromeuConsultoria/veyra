import { z } from 'zod';

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

export interface ClinicsAiReleaseDto {
  contactId: string;
  reason: ClinicsAiReleaseReason;
  releasedByMembershipId: string;
  createdAt: string;
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

export const createClinicsServiceSchema = z
  .object({
    name: catalogName,
    durationMin,
    priceCents: priceCents.nullable().default(null),
    currency: z.literal('BRL').default('BRL'),
  })
  .strict();
export type CreateClinicsServiceInput = z.infer<typeof createClinicsServiceSchema>;

/** Sem defaults: um PATCH que não cita o preço não pode zerá-lo. */
export const updateClinicsServiceSchema = z
  .object({
    name: catalogName.optional(),
    durationMin: durationMin.optional(),
    priceCents: priceCents.nullable().optional(),
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

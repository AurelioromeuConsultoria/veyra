import {
  BarChart3,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Percent,
  Send,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import type { NavGroup } from '../../lib/nav';

export const CLINICS_AGENDA_PATH = '/clinics/agenda';
export const CLINICS_PATIENTS_PATH = '/clinics/patients';
/**
 * A ficha de um paciente (F3.3b): fora da navegação, aberta pela lista, com o
 * id na query (`?id=`). As rotas de vertical são estáticas (composition.test).
 */
export const CLINICS_PATIENT_PATH = '/clinics/patient';

/** O caminho da ficha de um paciente. */
export const fichaDoPaciente = (id: string) =>
  `${CLINICS_PATIENT_PATH}?id=${encodeURIComponent(id)}`;
export const CLINICS_RETURNS_PATH = '/clinics/returns';
export const CLINICS_NO_SHOW_PATH = '/clinics/no-show';
export const CLINICS_CATALOG_PATH = '/clinics/catalog';
export const CLINICS_AI_RELEASES_PATH = '/clinics/ai-releases';
export const CLINICS_OUTREACH_PATH = '/clinics/outreach';
export const CLINICS_OUTREACH_METRICS_PATH = '/clinics/outreach-metrics';

/**
 * O grupo "Clínica" do menu da experiência `clinics` (ADR-055, adendo 2). Antes
 * ele era CONTRIBUÍDO ao menu do CRM quando o vertical estava ativo; agora só
 * existe na experiência da clínica, e é ela que decide o que aparece. Cada item
 * leva a permissão da sua rota; o shell e a busca escondem o que a pessoa não
 * pode abrir (e o grupo, se nada sobrar).
 */
export const CLINICS_NAV_GROUP: NavGroup = {
  label: 'Clínica',
  items: [
    {
      to: CLINICS_AGENDA_PATH,
      label: 'Agenda da clínica',
      icon: CalendarDays,
      permission: 'clinics:schedule:read',
      aliases: ['agendamento', 'horário', 'atendimento', 'consulta'],
    },
    {
      to: CLINICS_PATIENTS_PATH,
      label: 'Pacientes',
      icon: UsersRound,
      permission: 'clinics:schedule:read',
      aliases: ['paciente', 'cliente da clínica'],
    },
    {
      to: CLINICS_RETURNS_PATH,
      label: 'Retornos',
      icon: CalendarClock,
      permission: 'clinics:schedule:read',
      aliases: ['retorno', 'volta', 'follow-up'],
    },
    {
      to: CLINICS_NO_SHOW_PATH,
      label: 'Faltas',
      icon: Percent,
      permission: 'clinics:schedule:read',
      aliases: ['falta', 'taxa de faltas', 'no-show'],
    },
    {
      to: CLINICS_OUTREACH_PATH,
      label: 'Envios',
      icon: Send,
      permission: 'clinics:schedule:read',
      aliases: ['confirmação', 'reativação', 'whatsapp', 'mensagem', 'lembrete'],
    },
    {
      to: CLINICS_OUTREACH_METRICS_PATH,
      label: 'Métricas do envio',
      icon: BarChart3,
      permission: 'clinics:schedule:read',
      aliases: ['funil', 'conversão', 'entrega', 'resposta', 'reativação'],
    },
    {
      to: CLINICS_CATALOG_PATH,
      label: 'Catálogo',
      icon: ClipboardList,
      permission: 'clinics:catalog:read',
      aliases: ['clínica', 'serviços', 'profissionais', 'horários', 'unidade'],
    },
    {
      to: CLINICS_AI_RELEASES_PATH,
      label: 'Liberação para IA',
      icon: ShieldCheck,
      permission: 'clinics:restriction:manage',
      aliases: ['restrição', 'inteligência', 'fornecedor', 'parceiro'],
    },
  ],
};

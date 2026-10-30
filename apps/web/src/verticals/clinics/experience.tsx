import {
  BarChart3,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Percent,
  Plug,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  UserPlus,
  UsersRound,
} from 'lucide-react';
import { rotasDoCore } from '../../experiences/core-routes';
import { SECOES_DO_CORE } from '../../experiences/crm';
import type { ExperienceManifest, SettingsSection } from '../../lib/experience';
import { NAV_GROUPS, type NavGroup, type NavItem } from '../../lib/nav';
import { alcanca, hasPermission } from '../../lib/session';
import { buscaDeInteressados, buscaDePacientes } from './busca';
import { clinicsRoutes } from './index';
import {
  CLINICS_AGENDA_PATH,
  CLINICS_AI_RELEASES_PATH,
  CLINICS_CATALOG_PATH,
  CLINICS_LEADS_PATH,
  CLINICS_NO_SHOW_PATH,
  CLINICS_OUTREACH_METRICS_PATH,
  CLINICS_OUTREACH_PATH,
  CLINICS_PATIENTS_PATH,
  CLINICS_RETURNS_PATH,
  CLINICS_TODAY_PATH,
  pessoaDoContato,
} from './nav';

/** O ícone de uma seção do Core, pelo caminho — a mesma tela, com o nome da clínica. */
function iconeDoCore(to: string): NavItem['icon'] {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === to);
  if (!item) throw new Error(`Seção do Core inexistente: ${to}`);
  return item.icon;
}

/**
 * As seções das Configurações da clínica (ADR-055, adendo 3, item 6), cada uma
 * com TODAS as chaves da rota dela.
 */
const CONFIGURACOES: readonly SettingsSection[] = [
  {
    to: CLINICS_CATALOG_PATH,
    label: 'Clínica',
    description: 'Unidade, serviços, profissionais e horários.',
    icon: ClipboardList,
    permission: 'clinics:catalog:read',
  },
  SECOES_DO_CORE.equipe,
  {
    to: CLINICS_AI_RELEASES_PATH,
    label: 'Privacidade e IA',
    description: 'Quais contatos, sem relação com a clínica, a inteligência pode ler.',
    icon: ShieldCheck,
    // a tela e a rota exigem as duas (a pendência da E-2, adendo 4)
    permission: 'clinics:restriction:manage',
    permissions: ['contacts:read'],
  },
  {
    ...SECOES_DO_CORE.webhooks,
    label: 'Integrações',
    description: 'Webhooks para outros sistemas.',
    icon: Plug,
    destinos: [{ to: SECOES_DO_CORE.webhooks.to, label: 'Webhooks' }],
  },
  {
    to: SECOES_DO_CORE.tags.to,
    label: 'Etiquetas e campos',
    description: 'Tags e campos personalizados dos contatos.',
    icon: SECOES_DO_CORE.tags.icon,
    permission: 'contacts:read',
    destinos: [
      { to: SECOES_DO_CORE.tags.to, label: 'Tags' },
      { to: SECOES_DO_CORE.campos.to, label: 'Campos' },
    ],
  },
  SECOES_DO_CORE.uso,
  SECOES_DO_CORE.auditoria,
];

/**
 * O menu da clínica (ADR-055, adendos 1, 3 e 4): quatro entradas principais,
 * três grupos que AGRUPAM sem expor os subitens o tempo todo, e as
 * Configurações numa página só. Cada destino exige TODAS as chaves da tela.
 */
const MENU: readonly NavGroup[] = [
  {
    label: 'Clínica',
    semRotulo: true,
    items: [
      { to: CLINICS_TODAY_PATH, label: 'Hoje', icon: Sun, aliases: ['início', 'dia'] },
      {
        to: CLINICS_AGENDA_PATH,
        label: 'Agenda',
        icon: CalendarDays,
        permission: 'clinics:schedule:read',
        permissions: ['clinics:catalog:read'],
        aliases: ['agendamento', 'horário', 'atendimento', 'consulta'],
      },
      {
        to: CLINICS_PATIENTS_PATH,
        label: 'Pacientes',
        icon: UsersRound,
        permission: 'clinics:schedule:read',
        aliases: ['paciente', 'ficha'],
      },
      {
        to: '/inbox',
        label: 'Conversas',
        icon: iconeDoCore('/inbox'),
        permission: 'conversations:read',
        aliases: ['inbox', 'mensagens', 'whatsapp'],
      },
    ],
  },
  {
    label: 'Captação',
    recolhivel: true,
    items: [
      {
        to: CLINICS_LEADS_PATH,
        label: 'Interessados',
        icon: UserPlus,
        permission: 'contacts:read',
        permissions: ['clinics:schedule:read'],
        aliases: ['interessado', 'contato', 'lead', 'novo'],
      },
      {
        to: '/pipeline',
        label: 'Funil',
        icon: iconeDoCore('/pipeline'),
        permission: 'pipelines:read',
        aliases: ['funil de captação', 'pipeline', 'oportunidade'],
      },
    ],
  },
  {
    label: 'Acompanhamento',
    recolhivel: true,
    items: [
      {
        to: CLINICS_OUTREACH_PATH,
        label: 'Confirmações e reativações',
        icon: Send,
        permission: 'clinics:schedule:read',
        permissions: ['contacts:read', 'consents:read'],
        aliases: ['envios', 'confirmação', 'reativação', 'whatsapp', 'lembrete'],
      },
      {
        to: CLINICS_RETURNS_PATH,
        label: 'Retornos',
        icon: CalendarClock,
        permission: 'clinics:schedule:read',
        permissions: ['clinics:catalog:read'],
        aliases: ['retorno', 'volta'],
      },
    ],
  },
  {
    label: 'Indicadores',
    recolhivel: true,
    items: [
      {
        to: CLINICS_NO_SHOW_PATH,
        label: 'Faltas',
        icon: Percent,
        permission: 'clinics:schedule:read',
        permissions: ['clinics:catalog:read'],
        aliases: ['falta', 'taxa de faltas', 'no-show'],
      },
      {
        to: CLINICS_OUTREACH_METRICS_PATH,
        label: 'Envios',
        icon: BarChart3,
        permission: 'clinics:schedule:read',
        permissions: ['clinics:catalog:read'],
        aliases: ['métricas do envio', 'conversão', 'entrega', 'resposta'],
      },
    ],
  },
  {
    label: 'Ajustes',
    semRotulo: true,
    items: [
      {
        to: '/settings',
        label: 'Configurações',
        icon: Settings,
        // a entrada aparece se ALGUMA seção estiver ao alcance do papel
        disponivel: (user) => CONFIGURACOES.some((s) => alcanca(user, s)),
        aliases: ['equipe', 'catálogo', 'clínica', 'auditoria', 'privacidade', 'webhooks'],
      },
    ],
  },
];

/**
 * A experiência `clinics` (ADR-055, E-3): o dia da clínica como início, o menu
 * pelo trabalho da clínica, a busca de pacientes e interessados, a pessoa como
 * destino de um contato e a linguagem da clínica nas telas compartilhadas. A
 * base (conversas, funil, equipe, auditoria) é a do Core, sem cópia; o que o
 * CRM tem e a clínica não usa (o Hoje do CRM, Empresas, a Agenda genérica,
 * Tarefas, Sinais, Automações e a lista de Contatos) não é montado.
 */
export const clinicsExperience: ExperienceManifest = {
  key: 'clinics',
  produto: 'Veyra Clinics',
  marca: 'veyra clinics',
  inicio: CLINICS_TODAY_PATH,
  grupos: MENU,
  rotas: [
    ...clinicsRoutes,
    ...rotasDoCore(
      'inbox',
      'pipeline',
      'tags',
      'campos',
      'webhooks',
      'uso',
      'auditoria',
      'equipe',
      'configuracoes',
    ),
  ],
  configuracoes: CONFIGURACOES,
  links: {
    // a pessoa decide pela permissão de quem abre (adendo 4): nunca o CRM
    contato: (id, user) => (hasPermission(user, 'contacts:read') ? pessoaDoContato(id) : null),
  },
  busca: [buscaDePacientes, buscaDeInteressados],
  linguagem: { conversas: 'Conversas', funil: 'Funil de captação' },
};

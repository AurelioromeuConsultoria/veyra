import {
  Building2,
  CalendarDays,
  CheckSquare,
  Gauge,
  Inbox,
  KanbanSquare,
  ScrollText,
  Settings2,
  Sparkles,
  Sun,
  Tags,
  Users,
  Webhook,
  Workflow,
} from 'lucide-react';
import type { ComponentType } from 'react';

/**
 * MAPA ÚNICO das seções do produto. Três consumidores leem daqui — a barra
 * lateral, o rastro do cabeçalho e a busca global — e é justamente por isso que
 * ele existe: três listas paralelas divergiriam na primeira seção nova, e a
 * busca passaria a oferecer um destino que a lateral não mostra (ou pior, um
 * que a permissão do usuário nega).
 *
 * `permission` é a MESMA chave que o servidor exige na rota correspondente:
 * item sem permissão não aparece em lugar nenhum e sua tela não é oferecida.
 */
export type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  permission?: string;
  /** sinônimos que a busca global aceita — o rótulo não é a única palavra que a
   *  pessoa tem na cabeça ("deals" para pipeline, "clientes" para contatos) */
  aliases?: string[];
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trabalho',
    items: [
      { to: '/', label: 'Hoje', icon: Sun, aliases: ['início', 'resumo', 'visão do dia'] },
      {
        to: '/pipeline',
        label: 'Pipeline',
        icon: KanbanSquare,
        permission: 'pipelines:read',
        aliases: ['funil', 'oportunidades', 'deals', 'negócios'],
      },
      {
        to: '/contacts',
        label: 'Contatos',
        icon: Users,
        permission: 'contacts:read',
        aliases: ['clientes', 'pessoas', 'leads'],
      },
      {
        to: '/companies',
        label: 'Empresas',
        icon: Building2,
        permission: 'contacts:read',
        aliases: ['contas', 'organizações'],
      },
      {
        to: '/inbox',
        label: 'Inbox',
        icon: Inbox,
        permission: 'conversations:read',
        aliases: ['conversas', 'mensagens', 'atendimento'],
      },
      {
        to: '/calendar',
        label: 'Agenda',
        icon: CalendarDays,
        permission: 'calendar:read',
        aliases: ['calendário', 'eventos'],
      },
      { to: '/tasks', label: 'Tarefas', icon: CheckSquare, permission: 'tasks:read' },
    ],
  },
  {
    label: 'Inteligência',
    items: [
      {
        to: '/signals',
        label: 'Sinais',
        icon: Sparkles,
        permission: 'intelligence:use',
        aliases: ['ia', 'propostas', 'inteligência'],
      },
    ],
  },
  {
    label: 'Configuração',
    items: [
      {
        to: '/tags',
        label: 'Tags',
        icon: Tags,
        permission: 'contacts:read',
        aliases: ['etiquetas'],
      },
      {
        to: '/settings/fields',
        label: 'Campos',
        icon: Settings2,
        permission: 'contacts:read',
        aliases: ['campos customizados'],
      },
      {
        to: '/settings/automations',
        label: 'Automações',
        icon: Workflow,
        permission: 'automations:manage',
        aliases: ['regras', 'gatilhos'],
      },
      {
        to: '/settings/webhooks',
        label: 'Webhooks',
        icon: Webhook,
        permission: 'webhooks:manage',
        aliases: ['integrações'],
      },
      {
        to: '/settings/usage',
        label: 'Uso e plano',
        icon: Gauge,
        permission: 'workspace:read',
        aliases: ['limites', 'cotas', 'assinatura', 'billing'],
      },
      {
        to: '/audit',
        label: 'Auditoria',
        icon: ScrollText,
        permission: 'audit:read',
        aliases: ['trilha', 'logs'],
      },
    ],
  },
];

/**
 * Onde a pessoa está, para o rastro do cabeçalho. Casamento pelo prefixo mais
 * LONGO: `/settings/usage` não pode cair em `/` só porque veio antes na lista.
 */
export function currentSection(pathname: string): { group: string; item: NavItem } | null {
  let best: { group: string; item: NavItem } | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const matches = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
      if (matches && (!best || item.to.length > best.item.to.length)) {
        best = { group: group.label, item };
      }
    }
  }
  return best;
}

/** Acentuação e caixa não podem separar "automações" de "automacoes". */
export function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

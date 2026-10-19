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
import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from 'react';

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

/** Rota contribuída por um vertical, montada dentro do shell protegido. */
export type VerticalRoute = { path: string; element: ReactNode };

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
 * PORTA DE NAVEGAÇÃO (ADR-047 E5, adendo 4). Verticais CONTRIBUEM grupos ao
 * mapa, sem que o Core os conheça: a raiz de composição (`composition.tsx`)
 * entrega um HOOK que devolve os grupos contribuídos, e este contexto o leva
 * aos três consumidores. Sem raiz, nada é contribuído — o Core puro.
 *
 * O hook é chamado sempre, uma vez por render, na mesma posição: a lista de
 * verticais é fixa por build. Cada vertical decide a própria visibilidade (só
 * contribui com o próprio status confirmado como ativo e a permissão).
 */
export type UseNavContributions = () => readonly NavGroup[];
const NONE: readonly NavGroup[] = [];
const noContributions: UseNavContributions = () => NONE;
const NavContributionsContext = createContext<UseNavContributions>(noContributions);
export const NavContributionsProvider = NavContributionsContext.Provider;

/** O mapa COMPOSTO: o do Core seguido do que os verticais contribuírem agora. */
export function useNavGroups(): readonly NavGroup[] {
  const useContributions = useContext(NavContributionsContext);
  const contributed = useContributions();
  return useMemo(
    () => (contributed.length === 0 ? NAV_GROUPS : [...NAV_GROUPS, ...contributed]),
    [contributed],
  );
}

/**
 * Onde a pessoa está, para o rastro do cabeçalho. Casamento pelo prefixo mais
 * LONGO: `/settings/usage` não pode cair em `/` só porque veio antes na lista.
 */
export function currentSection(
  pathname: string,
  groups: readonly NavGroup[] = NAV_GROUPS,
): { group: string; item: NavItem } | null {
  let best: { group: string; item: NavItem } | null = null;
  for (const group of groups) {
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

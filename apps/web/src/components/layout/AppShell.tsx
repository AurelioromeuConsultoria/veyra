import { clsx } from 'clsx';
import {
  Building2,
  CalendarDays,
  CheckSquare,
  Inbox,
  KanbanSquare,
  LogOut,
  Gauge,
  Moon,
  ScrollText,
  Sparkles,
  Settings2,
  Sun,
  Tags,
  Users,
  Webhook,
  Workflow,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { hasPermission, useLogout, useSession } from '../../lib/session';
import { useTheme } from '../../lib/theme';
import { NotificationBell } from './NotificationBell';

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  permission?: string;
};

/**
 * Navegação em três blocos: o trabalho do dia, a camada de inteligência e a
 * configuração. Uma lista chapada de catorze itens não dizia o que é rotina e
 * o que é ajuste — o agrupamento é a hierarquia.
 */
const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Trabalho',
    items: [
      { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
      { to: '/contacts', label: 'Contatos', icon: Users },
      { to: '/companies', label: 'Empresas', icon: Building2 },
      { to: '/inbox', label: 'Inbox', icon: Inbox, permission: 'conversations:read' },
      { to: '/calendar', label: 'Agenda', icon: CalendarDays, permission: 'calendar:read' },
      { to: '/tasks', label: 'Tarefas', icon: CheckSquare },
    ],
  },
  {
    label: 'Inteligência',
    items: [{ to: '/signals', label: 'Sinais', icon: Sparkles, permission: 'intelligence:use' }],
  },
  {
    label: 'Configuração',
    items: [
      { to: '/tags', label: 'Tags', icon: Tags },
      { to: '/settings/fields', label: 'Campos', icon: Settings2 },
      {
        to: '/settings/automations',
        label: 'Automações',
        icon: Workflow,
        permission: 'automations:manage',
      },
      { to: '/settings/webhooks', label: 'Webhooks', icon: Webhook, permission: 'webhooks:manage' },
      { to: '/settings/usage', label: 'Uso e plano', icon: Gauge },
      { to: '/audit', label: 'Auditoria', icon: ScrollText, permission: 'audit:read' },
    ],
  },
];

function initials(name: string | undefined) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

export function AppShell() {
  const { data: user } = useSession();
  const logout = useLogout();
  const { theme, toggle } = useTheme();

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="px-4 pb-3 pt-4">
          {/* wordmark: o acento aparece aqui e em pouco mais (parcimônia) */}
          <span className="block text-display-sm leading-none text-accent">veyra</span>
          <p className="mt-1.5 truncate text-data text-muted-fg">
            {user?.activeMembership?.workspaceName ?? '—'}
          </p>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Principal">
          {groups.map((group) => {
            const items = group.items.filter(
              (item) => !item.permission || hasPermission(user, item.permission),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="mb-1 mt-3 first:mt-1">
                <p className="eyebrow px-2.5 pb-1.5 text-muted-fg/80">{group.label}</p>
                {items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    className={({ isActive }) =>
                      clsx(
                        'relative flex items-center gap-2.5 rounded-control py-1.5 pl-3 pr-2.5 text-body-sm transition-colors duration-150',
                        isActive
                          ? 'bg-surface-2 font-medium text-foreground'
                          : 'text-muted-fg hover:bg-surface-2/70 hover:text-foreground',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* marcador ativo: a segunda e última aparição do acento */}
                        <span
                          aria-hidden
                          className={clsx(
                            'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full',
                            isActive ? 'bg-accent' : 'bg-transparent',
                          )}
                        />
                        <Icon
                          size={15}
                          strokeWidth={1.75}
                          className={isActive ? 'text-accent' : undefined}
                        />
                        {label}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-border px-2 py-1.5">
          <NotificationBell />
        </div>

        <div className="flex items-center gap-2.5 border-t border-border px-3 py-3">
          <span
            aria-hidden
            className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-data-sm font-medium text-muted-fg"
          >
            {initials(user?.name)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-data font-medium">{user?.name}</p>
            <p className="truncate text-data-sm text-muted-fg">
              {user?.activeMembership?.roleName}
            </p>
          </div>
          <button
            type="button"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            className="rounded-control p-1.5 text-muted-fg transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="flex items-center gap-1.5 text-data text-muted-fg transition-colors hover:text-foreground"
          >
            <LogOut size={13} /> Sair
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

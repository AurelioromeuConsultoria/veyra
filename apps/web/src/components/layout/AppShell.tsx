import { clsx } from 'clsx';
import {
  Building2,
  CalendarDays,
  CheckSquare,
  Inbox,
  KanbanSquare,
  LogOut,
  Gauge,
  ScrollText,
  Sparkles,
  Settings2,
  Tags,
  Users,
  Webhook,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { hasPermission, useLogout, useSession } from '../../lib/session';
import { NotificationBell } from './NotificationBell';

const nav = [
  { to: '/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/contacts', label: 'Contatos', icon: Users },
  { to: '/companies', label: 'Empresas', icon: Building2 },
  { to: '/inbox', label: 'Inbox', icon: Inbox, permission: 'conversations:read' },
  { to: '/calendar', label: 'Agenda', icon: CalendarDays, permission: 'calendar:read' },
  { to: '/tasks', label: 'Tarefas', icon: CheckSquare },
  { to: '/tags', label: 'Tags', icon: Tags },
  { to: '/settings/fields', label: 'Campos', icon: Settings2 },
  { to: '/settings/webhooks', label: 'Webhooks', icon: Webhook, permission: 'webhooks:manage' },
  { to: '/signals', label: 'Sinais', icon: Sparkles, permission: 'intelligence:use' },
  { to: '/settings/usage', label: 'Uso e plano', icon: Gauge },
  { to: '/audit', label: 'Auditoria', icon: ScrollText, permission: 'audit:read' },
];

export function AppShell() {
  const { data: user } = useSession();
  const logout = useLogout();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-4 py-4">
          {/* wordmark: o acento aparece aqui e em pouco mais (parcimônia) */}
          <span className="text-base font-semibold tracking-tight text-accent">veyra</span>
          <p className="mt-0.5 truncate text-xs text-muted-fg">
            {user?.activeMembership?.workspaceName ?? '—'}
          </p>
        </div>
        <nav className="flex-1 space-y-0.5 p-2" aria-label="Principal">
          {nav
            .filter((item) => !item.permission || hasPermission(user, item.permission))
            .map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                    isActive
                      ? 'bg-surface-2 font-medium text-foreground'
                      : 'text-muted-fg hover:bg-surface-2 hover:text-foreground',
                  )
                }
              >
                <Icon size={15} strokeWidth={1.75} />
                {label}
              </NavLink>
            ))}
        </nav>
        <div className="border-t border-border px-2 py-2">
          <NotificationBell />
        </div>
        <div className="border-t border-border p-3">
          <p className="truncate text-xs font-medium">{user?.name}</p>
          <p className="truncate text-xs text-muted-fg">{user?.activeMembership?.roleName}</p>
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="mt-2 flex items-center gap-1.5 text-xs text-muted-fg hover:text-foreground"
          >
            <LogOut size={13} /> Sair
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

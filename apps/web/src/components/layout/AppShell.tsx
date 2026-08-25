import { clsx } from 'clsx';
import { NavLink, Outlet } from 'react-router-dom';
import { NAV_GROUPS } from '../../lib/nav';
import { hasPermission, useSession } from '../../lib/session';
import { AppHeader } from './AppHeader';

/**
 * Duas molduras, dois papéis: a LATERAL diz o que existe (navegação em três
 * blocos — o trabalho do dia, a inteligência e a configuração) e o CABEÇALHO
 * diz onde você está, o que você procura e quem você é.
 *
 * O rodapé da lateral sumiu: notificação, tema e sessão moravam ali, no canto
 * onde ninguém procura por eles, e subiram para a faixa. A identidade do
 * workspace também deixou de se repetir aqui — ela abre o rastro no cabeçalho.
 */
export function AppShell() {
  const { data: user } = useSession();

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-13 shrink-0 items-center border-b border-border px-4">
          {/* wordmark: o acento aparece aqui e em pouco mais (parcimônia) */}
          <span className="block text-display-sm leading-none text-accent">veyra</span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Principal">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter(
              (item) => !item.permission || hasPermission(user, item.permission),
            );
            if (items.length === 0) return null;
            return (
              <div key={group.label} className="mb-1 mt-3 first:mt-2.5">
                <p className="eyebrow px-2.5 pb-1.5 text-muted-fg/80">{group.label}</p>
                {items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === '/'}
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
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

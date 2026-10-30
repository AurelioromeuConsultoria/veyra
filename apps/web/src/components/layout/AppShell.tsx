import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { secaoDeConfiguracao, useExperience, type ExperienceManifest } from '../../lib/experience';
import { itemAlcancavel, useNavGroups, type NavGroup, type NavItem } from '../../lib/nav';
import { useSession } from '../../lib/session';
import { AppHeader } from './AppHeader';

/**
 * Duas molduras, dois papéis: a LATERAL diz o que existe (o menu do produto da
 * experiência ativa, ADR-055) e o CABEÇALHO diz onde você está, o que você
 * procura e quem você é.
 *
 * O rodapé da lateral sumiu: notificação, tema e sessão moravam ali, no canto
 * onde ninguém procura por eles, e subiram para a faixa. A identidade do
 * workspace também deixou de se repetir aqui — ela abre o rastro no cabeçalho.
 */
export function AppShell({ manifestos }: { manifestos: readonly ExperienceManifest[] }) {
  const { data: user } = useSession();
  const experiencia = useExperience();
  const groups = useNavGroups();
  const location = useLocation();
  // dentro de uma seção de configuração, a entrada "Configurações" fica marcada
  // (as subpáginas não estão no menu: o produto tem uma entrada só para elas)
  const naConfiguracao = secaoDeConfiguracao(experiencia, location.pathname) !== null;
  const foraDaExperiencia = (location.state as { foraDaExperiencia?: string } | null)
    ?.foraDaExperiencia;

  return (
    <div className="flex h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-13 shrink-0 items-center border-b border-border px-4">
          {/* wordmark: o acento aparece aqui e em pouco mais (parcimônia) */}
          <span className="block text-display-sm leading-none text-accent">
            {experiencia.marca}
          </span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" aria-label="Principal">
          {groups.map((group) => {
            const items = group.items.filter((item) => itemAlcancavel(user, item));
            if (items.length === 0) return null;
            const marcado = (item: NavItem) => item.to === '/settings' && naConfiguracao;
            // um grupo recolhível com um item só mostra o item direto: o clique
            // a mais não organizaria nada
            if (group.recolhivel && items.length > 1) {
              return (
                <GrupoRecolhivel key={group.label} group={group} items={items} marcado={marcado} />
              );
            }
            return (
              <div key={group.label} className="mb-1 mt-3 first:mt-2.5">
                {group.semRotulo || group.recolhivel ? null : (
                  <p className="eyebrow px-2.5 pb-1.5 text-muted-fg/80">{group.label}</p>
                )}
                {items.map((item) => (
                  <ItemDoMenu key={item.to} item={item} marcado={marcado(item)} />
                ))}
              </div>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AppHeader manifestos={manifestos} />
        {foraDaExperiencia ? (
          <p
            role="status"
            className="border-b border-warning/40 bg-warning/10 px-6 py-2 text-data"
            data-testid="fora-da-experiencia"
          >
            Esta seção não faz parte do {experiencia.produto}. Você está no início dele.
          </p>
        ) : null}
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function ItemDoMenu({
  item: { to, label, icon: Icon },
  marcado = false,
}: {
  item: NavItem;
  /** ativo por outra regra além do caminho (as subpáginas das Configurações) */
  marcado?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/' || to === '/settings'}
      className={({ isActive: noCaminho }) =>
        clsx(
          'relative flex items-center gap-2.5 rounded-control py-1.5 pl-3 pr-2.5 text-body-sm transition-colors duration-150',
          noCaminho || marcado
            ? 'bg-surface-2 font-medium text-foreground'
            : 'text-muted-fg hover:bg-surface-2/70 hover:text-foreground',
        )
      }
    >
      {({ isActive: noCaminho }) => (
        <>
          {/* marcador ativo: a segunda e última aparição do acento */}
          <span
            aria-hidden
            className={clsx(
              'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full',
              noCaminho || marcado ? 'bg-accent' : 'bg-transparent',
            )}
          />
          <Icon
            size={15}
            strokeWidth={1.75}
            className={noCaminho || marcado ? 'text-accent' : undefined}
          />
          {label}
        </>
      )}
    </NavLink>
  );
}

/**
 * Um grupo que AGRUPA os destinos sem deixá-los expostos o tempo todo (ADR-055,
 * adendo 1, item 2): recolhido por padrão, aberto pelo clique ou ao entrar numa
 * seção dele — e a pessoa pode recolher de novo, mesmo com a seção ativa (o
 * marcador passa para o título do grupo). Sem preferência guardada: vale a aba.
 */
function GrupoRecolhivel({
  group,
  items,
  marcado,
}: {
  group: NavGroup;
  items: NavItem[];
  marcado: (item: NavItem) => boolean;
}) {
  const { pathname } = useLocation();
  const ativo = items.some(
    (i) => marcado(i) || pathname === i.to || pathname.startsWith(`${i.to}/`),
  );
  const [aberto, setAberto] = useState(ativo);
  useEffect(() => {
    if (ativo) setAberto(true);
  }, [ativo, pathname]);
  return (
    <div className="mb-1 mt-2">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        className={clsx(
          'relative flex w-full items-center gap-2 rounded-control py-1.5 pl-3 pr-2.5 text-left text-body-sm transition-colors duration-150 hover:bg-surface-2/70 hover:text-foreground',
          ativo && !aberto ? 'font-medium text-foreground' : 'text-muted-fg',
        )}
      >
        {ativo && !aberto ? (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
          />
        ) : null}
        <ChevronRight
          size={13}
          aria-hidden
          className={clsx('shrink-0 transition-transform duration-150', aberto && 'rotate-90')}
        />
        {group.label}
      </button>
      {aberto ? (
        <div className="ml-3">
          {items.map((item) => (
            <ItemDoMenu key={item.to} item={item} marcado={marcado(item)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

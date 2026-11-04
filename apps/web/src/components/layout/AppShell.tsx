import { clsx } from 'clsx';
import { ChevronRight } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { secaoDeConfiguracao, useExperience, type ExperienceManifest } from '../../lib/experience';
import { itemAlcancavel, useNavGroups, type NavGroup, type NavItem } from '../../lib/nav';
import { useSession } from '../../lib/session';
import { AppHeader } from './AppHeader';
import { Marca } from './Marca';

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
      {/* a MOLDURA (ADR-062): verde-abissal profundo, com a marca real */}
      <aside className="flex w-60 shrink-0 flex-col bg-frame text-frame-fg">
        <div className="flex h-15 shrink-0 items-center px-5">
          <Marca nome={experiencia.marca} subtitulo={user?.activeMembership?.workspaceName} />
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-label="Principal">
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
              <div key={group.label} className="mb-1 mt-4 first:mt-2">
                {group.semRotulo || group.recolhivel ? null : (
                  <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-frame-label">
                    {group.label}
                  </p>
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
          {/* a página carrega DENTRO da moldura, nunca no lugar dela (ADR-062) */}
          <Suspense
            fallback={
              <div className="p-7" aria-busy="true">
                <p className="sr-only" role="status">
                  Carregando…
                </p>
                <div aria-hidden className="h-7 w-56 animate-pulse rounded-control bg-surface-2" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
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
          'relative flex items-center gap-3 rounded-[9px] px-3 py-2 text-[14px] transition-colors duration-150',
          noCaminho || marcado
            ? 'bg-frame-2 font-semibold text-white'
            : 'text-frame-fg hover:bg-frame-3 hover:text-white',
        )
      }
    >
      <Icon size={17} strokeWidth={1.8} aria-hidden />
      {label}
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
          'relative mt-2 flex w-full items-center gap-2 rounded-[9px] px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-[0.06em] transition-colors duration-150 hover:text-white',
          ativo && !aberto ? 'text-white' : 'text-frame-label',
        )}
      >
        {ativo && !aberto ? (
          <span aria-hidden className="absolute right-3 h-1.5 w-1.5 rounded-full bg-frame-fg" />
        ) : null}
        <ChevronRight
          size={13}
          aria-hidden
          className={clsx('shrink-0 transition-transform duration-150', aberto && 'rotate-90')}
        />
        {group.label}
      </button>
      {aberto ? (
        <div className="mt-0.5">
          {items.map((item) => (
            <ItemDoMenu key={item.to} item={item} marcado={marcado(item)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

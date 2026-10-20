import { LogOut, Moon, Search, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { currentSection, useNavGroups } from '../../lib/nav';
import { hasPermission, logoutFalhou, useLogout, useSession } from '../../lib/session';
import { useTheme } from '../../lib/theme';
import { GlobalSearch } from './GlobalSearch';
import { NotificationBell } from './NotificationBell';

/**
 * MOLDURA do produto: a faixa que não muda enquanto o conteúdo muda.
 *
 * Sem ela o Veyra lia como um conjunto de páginas soltas — a lateral e, colada
 * nela, a tela. Três papéis, nesta ordem de importância:
 *
 * 1. RASTRO (esquerda) — workspace e seção. Não é o título da página: é 12px em
 *    mono e sans, no papel de dado. O `PageHeader` continua dono do título, e
 *    o eyebrow que repetia a seção saiu de lá quando esta faixa nasceu.
 * 2. BUSCA (centro) — ⌘K, com o atalho à vista. Um lugar só para chegar a
 *    qualquer contato ou seção.
 * 3. CONTA (direita) — notificação, tema e sessão. Estavam no RODAPÉ da barra
 *    lateral, onde ninguém procura por eles.
 *
 * Sair é BOTÃO, não item de menu escondido: encerrar a sessão é a ação que
 * precisa ser encontrável sem descoberta, e um passo a menos aqui não custa
 * densidade nenhuma.
 */

function Slash() {
  return (
    <span aria-hidden className="shrink-0 text-muted-fg/50">
      /
    </span>
  );
}

function initials(name: string | undefined) {
  if (!name) return '—';
  const parts = name.trim().split(/\s+/);
  return (
    (parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')
  ).toUpperCase();
}

/** ⌘ no Mac, Ctrl no resto — o atalho impresso tem de ser o atalho real. */
function useIsMac() {
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent));
  }, []);
  return isMac;
}

export function AppHeader() {
  const { data: user } = useSession();
  const logout = useLogout();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const isMac = useIsMac();
  const [searchOpen, setSearchOpen] = useState(false);

  const groups = useNavGroups();
  const section = currentSection(location.pathname, groups);
  const workspace = user?.activeMembership?.workspaceName;

  /**
   * O título da aba diz onde a pessoa está E em qual workspace — quem opera
   * dois clientes em duas abas não pode depender de adivinhar pelo favicon.
   */
  useEffect(() => {
    const partes = [section?.item.label, workspace, 'Veyra'].filter(Boolean);
    document.title = partes.join(' · ');
  }, [section?.item.label, workspace]);

  /** ⌘K/Ctrl+K em qualquer tela, inclusive com foco dentro de um campo. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <header className="flex h-13 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      {/* 1 — rastro */}
      {/*
        Três degraus, e o do meio é o que justifica o rastro existir numa tela
        cujo título repete a seção: workspace / BLOCO / seção. "Contatos" no
        título diz o que a tela é; "TRABALHO / CONTATOS" diz onde ela mora — e
        o rastro é o único elemento que NÃO muda de assunto quando a página
        troca de nome (o board mostra o nome do pipeline, o inbox o assunto).
      */}
      <nav aria-label="Onde você está" className="flex min-w-0 items-center gap-2">
        <span className="truncate text-body-sm font-medium text-foreground">
          {workspace ?? '—'}
        </span>
        {section ? (
          <>
            <Slash />
            <span className="eyebrow truncate text-muted-fg/80">{section.group}</span>
            <Slash />
            <span className="eyebrow truncate text-muted-fg">{section.item.label}</span>
          </>
        ) : null}
      </nav>

      {/* 2 — busca */}
      <div className="mx-auto hidden w-full max-w-sm px-4 sm:block">
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="group flex h-8 w-full items-center gap-2 rounded-control border border-border bg-surface-2/50 px-2.5 text-muted-fg transition-colors duration-150 hover:border-border-strong hover:bg-surface-2"
        >
          <Search size={14} aria-hidden className="shrink-0" />
          <span className="truncate text-body-sm">
            {hasPermission(user, 'contacts:read') ? 'Buscar contato ou seção' : 'Buscar seção'}
          </span>
          <kbd className="num ml-auto shrink-0 rounded-sm border border-border bg-surface px-1 text-data-xs">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>

      {/* 3 — conta */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <NotificationBell />
        <button
          type="button"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
          className="rounded-control p-2 text-muted-fg transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <span aria-hidden className="mx-1.5 h-5 w-px bg-border" />

        <span
          aria-hidden
          className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-data-sm font-medium text-muted-fg"
        >
          {initials(user?.name)}
        </span>
        <span className="hidden min-w-0 leading-tight md:block">
          <span className="block truncate text-data font-medium">{user?.name}</span>
          <span className="block truncate text-data-sm text-muted-fg">
            {user?.activeMembership?.roleName}
          </span>
        </span>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="ml-1 flex items-center gap-1.5 rounded-control px-2 py-1.5 text-data text-muted-fg transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
        >
          <LogOut size={13} aria-hidden /> Sair
        </button>
        {logoutFalhou(logout.error) ? (
          <span role="alert" className="text-data-sm text-negative">
            Não foi possível sair — você continua conectado neste navegador. Tente de novo.
          </span>
        ) : null}
      </div>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  );
}

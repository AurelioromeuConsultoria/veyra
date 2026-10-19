import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { ContactDto, Paginated } from '@veyra/contracts';
import { clsx } from 'clsx';
import { CornerDownLeft, Search, User, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, toQuery } from '../../lib/api';
import { fold, useNavGroups, type NavItem } from '../../lib/nav';
import { hasPermission, useSession } from '../../lib/session';

/**
 * Busca global (⌘K / Ctrl+K).
 *
 * Duas fontes, e SÓ duas, porque só duas existem de verdade: as seções do
 * produto (mapa local) e os contatos (`GET /api/contacts?search=`). Nenhuma
 * categoria decorativa — uma linha "Oportunidades" que nunca traz resultado é
 * pior que ausência, porque ensina a pessoa a não confiar na busca.
 *
 * A consulta de contato só é DISPARADA para quem tem `contacts:read`: sem essa
 * guarda, um papel restrito acionaria um 403 a cada tecla (a lição do inbox).
 */

type Result =
  | { kind: 'section'; id: string; to: string; label: string; hint: string; icon: NavItem['icon'] }
  | { kind: 'contact'; id: string; to: string; label: string; hint: string };

const DEBOUNCE_MS = 200;
const MAX_CONTACTS = 6;

function matchesSection(item: NavItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = [item.label, ...(item.aliases ?? [])].map(fold);
  return haystack.some((value) => value.includes(needle));
}

export function GlobalSearch({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: user } = useSession();
  const canReadContacts = hasPermission(user, 'contacts:read');
  const navigate = useNavigate();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  /** Cada abertura começa limpa: busca anterior meio digitada é ruído. */
  useEffect(() => {
    if (!open) {
      setTerm('');
      setDebounced('');
      setActive(0);
    }
  }, [open]);

  const contactParams = { search: debounced, pageSize: MAX_CONTACTS, status: 'active' as const };
  const contacts = useQuery({
    queryKey: ['global-search', 'contacts', debounced],
    queryFn: () => api.get<Paginated<ContactDto>>(`/api/contacts${toQuery(contactParams)}`),
    enabled: open && canReadContacts && debounced.length >= 2,
    staleTime: 30_000,
  });

  const needle = fold(debounced);
  const groups = useNavGroups();
  const sections = useMemo<Result[]>(
    () =>
      groups
        .flatMap((group) => group.items.map((item) => ({ group, item })))
        .filter(({ item }) => !item.permission || hasPermission(user, item.permission))
        .filter(({ item }) => matchesSection(item, needle))
        .map(({ group, item }) => ({
          kind: 'section' as const,
          id: `section:${item.to}`,
          to: item.to,
          label: item.label,
          // o bloco, não a palavra "Seção": o cabeçalho do grupo já disse o
          // que são, e onde a seção mora é informação que não estava em lugar
          // nenhum ("Campos" fica em Configuração, "Sinais" em Inteligência)
          hint: group.label,
          icon: item.icon,
        })),
    [groups, needle, user],
  );

  const contactResults = useMemo<Result[]>(
    () =>
      (contacts.data?.items ?? []).map((contact) => ({
        kind: 'contact' as const,
        id: `contact:${contact.id}`,
        // abre a ficha direto, no lugar onde se age sobre ela
        to: `/contacts?c=${contact.id}`,
        label: contact.name,
        hint: contact.emails[0] ?? contact.companyName ?? 'Contato',
      })),
    [contacts.data],
  );

  const results = useMemo(() => [...contactResults, ...sections], [contactResults, sections]);
  /**
   * Cabeçalho de grupo só quando há DOIS grupos: com uma fonte só ele viraria
   * um rótulo redundante em cima de uma lista que já se explica.
   */
  const agrupado = contactResults.length > 0 && sections.length > 0;

  /** A lista muda a cada tecla: o realce volta ao topo em vez de flutuar. */
  useEffect(() => {
    setActive(0);
  }, [results.length, debounced]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  function go(result: Result | undefined) {
    if (!result) return;
    onOpenChange(false);
    navigate(result.to);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) =>
        results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(results[active]);
    }
    // Esc não aparece aqui de propósito: o Radix já fecha, devolve o foco ao
    // gatilho e destrava o scroll do documento.
  }

  const buscando = canReadContacts && debounced.length >= 2 && contacts.isFetching;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/25" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-card border border-border bg-surface shadow-float focus:outline-none"
          onOpenAutoFocus={(event) => {
            // o Radix focaria o container; o campo é o único destino que faz
            // sentido para um atalho de teclado
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Dialog.Title className="sr-only">Busca global</Dialog.Title>

          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search size={16} aria-hidden className="shrink-0 text-muted-fg" />
            <input
              ref={inputRef}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                canReadContacts ? 'Buscar contato ou seção…' : 'Buscar uma seção do produto…'
              }
              aria-label="Buscar no workspace"
              role="combobox"
              aria-expanded
              aria-controls="global-search-results"
              aria-activedescendant={results[active]?.id}
              autoComplete="off"
              spellCheck={false}
              className="h-12 w-full bg-transparent text-body text-foreground placeholder:text-muted-fg/80 focus:outline-none"
            />
            {buscando ? <span className="eyebrow shrink-0 text-muted-fg">buscando</span> : null}
          </div>

          <ul
            ref={listRef}
            id="global-search-results"
            role="listbox"
            aria-label="Resultados"
            className="max-h-[22rem] overflow-y-auto py-1.5"
          >
            {results.map((result, index) => (
              // `presentation` no <li>: o listbox precisa possuir os <option>
              // diretamente, e o item de lista aqui é só estrutura visual
              <li key={result.id} role="presentation">
                {agrupado && (index === 0 || index === contactResults.length) ? (
                  <p className="eyebrow px-4 pb-1 pt-2.5 text-muted-fg/80" aria-hidden>
                    {index === 0 ? 'Contatos' : 'Ir para'}
                  </p>
                ) : null}
                <button
                  type="button"
                  id={result.id}
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  tabIndex={-1}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(result)}
                  className={clsx(
                    'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-150',
                    index === active ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                  )}
                >
                  {result.kind === 'contact' ? (
                    <User size={14} aria-hidden className="shrink-0 text-muted-fg" />
                  ) : (
                    <result.icon size={14} aria-hidden className="shrink-0 text-muted-fg" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body-sm">{result.label}</span>
                  <span className="num shrink-0 truncate text-data-sm text-muted-fg">
                    {result.hint}
                  </span>
                  {index === active ? (
                    <CornerDownLeft size={13} aria-hidden className="shrink-0 text-accent" />
                  ) : (
                    <ArrowRight size={13} aria-hidden className="shrink-0 text-transparent" />
                  )}
                </button>
              </li>
            ))}

            {results.length === 0 ? (
              <li role="presentation" className="px-4 py-8 text-center">
                <p className="text-body-sm">Nada com esse nome.</p>
                <p className="mt-1 text-data text-muted-fg">
                  {canReadContacts
                    ? 'A busca cobre contatos e as seções do produto.'
                    : 'A busca cobre as seções do produto — contatos exigem permissão de leitura.'}
                </p>
              </li>
            ) : null}
          </ul>

          <footer className="flex items-center gap-4 border-t border-border bg-surface-2/40 px-4 py-2 text-data-sm text-muted-fg">
            <span className="flex items-center gap-1.5">
              <Key>↑</Key>
              <Key>↓</Key> navegar
            </span>
            <span className="flex items-center gap-1.5">
              <Key>↵</Key> abrir
            </span>
            <span className="flex items-center gap-1.5">
              <Key>esc</Key> fechar
            </span>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="num rounded-sm border border-border bg-surface px-1 text-data-xs text-muted-fg">
      {children}
    </kbd>
  );
}

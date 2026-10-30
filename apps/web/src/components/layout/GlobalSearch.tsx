import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { CornerDownLeft, Search, User, ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { secoesAlcancaveis, useExperience } from '../../lib/experience';
import { fold, itemAlcancavel, useNavGroups, type NavItem } from '../../lib/nav';
import { alcanca, useSession } from '../../lib/session';

/**
 * Busca global (⌘K / Ctrl+K), do PRODUTO ativo (ADR-055, adendo 2, item 4).
 *
 * As fontes são as que existem de verdade: as seções do produto (o mapa da
 * experiência — nunca a de outro produto) e os registros dos provedores que o
 * manifesto declara (no CRM, os contatos; no Clinics, pacientes e
 * interessados, cada um com o seu rótulo e o seu destino). Nenhuma categoria
 * decorativa — uma linha "Oportunidades" que nunca traz resultado é pior que
 * ausência, porque ensina a pessoa a não confiar na busca.
 *
 * A consulta de cada provedor só é DISPARADA com TODAS as chaves dele: sem essa
 * guarda, um papel restrito acionaria um 403 a cada tecla (a lição do inbox).
 */

type Result =
  | { kind: 'section'; id: string; to: string; label: string; hint: string; icon: NavItem['icon'] }
  | { kind: 'contact'; id: string; to: string; label: string; hint: string };

const DEBOUNCE_MS = 200;

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
  const experiencia = useExperience();
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

  // a lista de provedores é fixa durante a sessão (o manifesto): cada hook é
  // chamado sempre no mesmo ponto, e cada um só consulta com as chaves dele
  const porProvedor = experiencia.busca.map((provedor) =>
    provedor.useResultados(debounced, open && alcanca(user, provedor) && debounced.length >= 2),
  );
  const registros = {
    resultados: porProvedor.flatMap((r) => r.resultados),
    buscando: porProvedor.some((r) => r.buscando),
  };
  const alcancaveis = experiencia.busca.filter((provedor) => alcanca(user, provedor));
  const podeBuscarRegistros = alcancaveis.length > 0;
  const rotulo = (lista: readonly { label: string }[]) =>
    juntar(lista.map((p, i) => (i === 0 ? p.label : p.label.toLowerCase())));

  const needle = fold(debounced);
  const groups = useNavGroups();
  const sections = useMemo<Result[]>(() => {
    const doMenu = groups
      .flatMap((group) => group.items.map((item) => ({ group, item })))
      .filter(({ item }) => itemAlcancavel(user, item));
    const noMenu = new Set(doMenu.map(({ item }) => item.to));
    // as seções das Configurações que o menu não lista (o produto tem uma
    // entrada só para elas): achadas também pela descrição ("profissionais")
    const dasConfiguracoes = secoesAlcancaveis(experiencia, user)
      .filter((secao) => !noMenu.has(secao.to))
      .filter(
        (secao) =>
          !needle || fold(secao.label).includes(needle) || fold(secao.description).includes(needle),
      )
      .map((secao) => ({
        kind: 'section' as const,
        id: `section:${secao.to}`,
        to: secao.to,
        label: secao.label,
        hint: 'Configurações',
        icon: secao.icon,
      }));
    return [
      ...doMenu
        .filter(({ item }) => matchesSection(item, needle))
        .map(({ group, item }) => ({
          kind: 'section' as const,
          id: `section:${item.to}`,
          to: item.to,
          label: item.label,
          // o bloco, não a palavra "Seção": o cabeçalho do grupo já disse o
          // que são, e onde a seção mora é informação que não estava em lugar
          // nenhum ("Campos" fica em Configuração, "Sinais" em Inteligência);
          // as entradas principais de um produto não têm bloco
          hint: group.semRotulo ? '' : group.label,
          icon: item.icon,
        })),
      ...dasConfiguracoes,
    ];
  }, [groups, needle, user, experiencia]);

  const contactResults = useMemo<Result[]>(
    () => registros.resultados.map((hit) => ({ kind: 'contact' as const, ...hit })),
    [registros.resultados],
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

  const buscando = registros.buscando;

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
                podeBuscarRegistros
                  ? `Buscar ${alcancaveis.map((p) => p.singular).join(', ')} ou seção…`
                  : 'Buscar uma seção do produto…'
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
                    {index === 0 ? rotulo(alcancaveis) : 'Ir para'}
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
                  {podeBuscarRegistros
                    ? `A busca cobre ${rotulo(alcancaveis).toLowerCase()} e as seções do produto.`
                    : experiencia.busca.length > 0
                      ? `A busca cobre as seções do produto — ${rotulo(experiencia.busca).toLowerCase()} exigem permissão de leitura.`
                      : 'A busca cobre as seções do produto.'}
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

/** "a", "a e b", "a, b e c". */
function juntar(partes: readonly string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

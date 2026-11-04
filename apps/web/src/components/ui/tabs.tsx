import { clsx } from 'clsx';
import { useRef, type KeyboardEvent } from 'react';

export interface Aba<K extends string> {
  chave: K;
  rotulo: string;
}

/** O id do painel de um conjunto de abas (para o `aria-labelledby`). */
export const idDaAba = (base: string, chave: string) => `${base}-aba-${chave}`;
export const idDoPainel = (base: string) => `${base}-painel`;

/**
 * Abas (ADR-062): o padrão do WAI-ARIA com ativação automática — só a aba
 * ativa entra no Tab; setas, Home e End movem entre as abas. Quem usa renderiza
 * o painel com `role="tabpanel"`, `id={idDoPainel(base)}` e
 * `aria-labelledby={idDaAba(base, ativa)}`.
 */
export function Abas<K extends string>({
  base,
  rotulo,
  abas,
  ativa,
  onChange,
  className,
}: {
  base: string;
  rotulo: string;
  abas: readonly Aba<K>[];
  ativa: K;
  onChange: (chave: K) => void;
  className?: string;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const mover = (e: KeyboardEvent, indice: number) => {
    const ultimo = abas.length - 1;
    const destino =
      e.key === 'ArrowRight'
        ? indice === ultimo
          ? 0
          : indice + 1
        : e.key === 'ArrowLeft'
          ? indice === 0
            ? ultimo
            : indice - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? ultimo
              : null;
    if (destino === null) return;
    e.preventDefault();
    const chave = abas[destino].chave;
    onChange(chave);
    refs.current.get(chave)?.focus();
  };
  return (
    <div role="tablist" aria-label={rotulo} className={clsx('flex gap-6', className)}>
      {abas.map((a, i) => (
        <button
          key={a.chave}
          ref={(el) => {
            if (el) refs.current.set(a.chave, el);
            else refs.current.delete(a.chave);
          }}
          type="button"
          role="tab"
          id={idDaAba(base, a.chave)}
          aria-controls={idDoPainel(base)}
          aria-selected={ativa === a.chave}
          tabIndex={ativa === a.chave ? 0 : -1}
          onClick={() => onChange(a.chave)}
          onKeyDown={(e) => mover(e, i)}
          className={clsx(
            '-mb-px whitespace-nowrap border-b-2 pb-3 pt-2.5 text-[14px] transition-colors',
            ativa === a.chave
              ? 'border-accent font-semibold text-foreground'
              : 'border-transparent text-muted-fg hover:text-foreground',
          )}
        >
          {a.rotulo}
        </button>
      ))}
    </div>
  );
}

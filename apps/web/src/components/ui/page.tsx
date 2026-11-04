import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * Duas densidades deliberadas (§1): o cabeçalho tem respiro de visão executiva
 * — título em display, contexto em mono — e o conteúdo abaixo pode ser tão
 * denso quanto o trabalho exigir.
 */
export function PageHeader({
  eyebrow,
  title,
  meta,
  children,
}: {
  eyebrow?: string;
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-border bg-surface px-7 py-5">
      <div className="mr-auto min-w-0">
        {eyebrow ? <p className="mb-1 text-[13px] text-muted-fg">{eyebrow}</p> : null}
        <h1 className="truncate font-display text-[26px] font-semibold leading-tight tracking-[-0.02em]">
          {title}
        </h1>
        {meta ? <div className="mt-1 text-[14px] text-muted-fg">{meta}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Área de trabalho: fundo mineral com respiro; painéis flutuam sobre ele. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('min-h-0 flex-1 overflow-auto p-7', className)}>{children}</div>;
}

/**
 * Painel: cartão que ABRAÇA o conteúdo. Tabela de 5 linhas não estica por 600px
 * de nada — ela termina onde os dados terminam, e o resto é fundo deliberado.
 */
export function Panel({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <section
      className={clsx('overflow-hidden rounded-card border border-border bg-surface', className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5">
      <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      {meta ? <span className="text-[13px] text-muted-fg">{meta}</span> : null}
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </header>
  );
}

/** Vazio orienta a próxima ação (§7) — nunca só "sem dados". */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span aria-hidden className="mb-1 h-10 w-10 rounded-full bg-surface-2" />
      <p className="text-[15px] font-semibold">{title}</p>
      {hint ? <p className="max-w-sm text-[13.5px] text-muted-fg">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

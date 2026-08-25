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
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-6 py-3.5">
      <div className="mr-auto min-w-0">
        {eyebrow ? <p className="eyebrow mb-1 text-muted-fg">{eyebrow}</p> : null}
        <h1 className="truncate text-display-md">{title}</h1>
        {meta ? <div className="mt-0.5 text-data text-muted-fg">{meta}</div> : null}
      </div>
      {children}
    </header>
  );
}

/** Área de trabalho: fundo mineral com respiro; painéis flutuam sobre ele. */
export function PageBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('min-h-0 flex-1 overflow-auto p-6', className)}>{children}</div>;
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
    <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
      <h2 className="eyebrow text-muted-fg">{title}</h2>
      {meta ? <span className="num text-data-sm text-muted-fg">{meta}</span> : null}
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
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <span aria-hidden className="h-px w-10 bg-border-strong" />
      <p className="text-body-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-data text-muted-fg">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * ASSINATURA VISUAL 2 — a marca de proveniência da IA (§6 do DESIGN_DIRECTION).
 *
 * Tudo que o modelo escreveu recebe o MESMO par: filete de 2px em cobre à
 * esquerda (`ai-mark`) e um rótulo "IA" em mono caixa-alta. É o que permite
 * reconhecer origem num relance — sem chat flutuante, sem violeta de clichê e
 * sem estridência. O cobre nunca é usado para outra coisa.
 */

/** Selo de autoria: aparece junto do que a IA escreveu. */
export function AiSeal({ label = 'IA', className }: { label?: string; className?: string }) {
  return (
    <span
      className={clsx(
        'eyebrow inline-flex shrink-0 items-center rounded-sm border border-ai/45 px-1 py-px text-ai',
        className,
      )}
    >
      {label}
    </span>
  );
}

/** Superfície de conteúdo gerado: filete de cobre + rótulo de proveniência. */
export function AiPanel({
  title,
  meta,
  children,
  className,
  ...rest
}: {
  title: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={clsx('ai-mark px-6 py-3', className)} {...rest}>
      <div className="flex items-center gap-2">
        <AiSeal />
        <span className="eyebrow text-ai">{title}</span>
        {meta ? <span className="num ml-auto text-data-sm text-muted-fg">{meta}</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

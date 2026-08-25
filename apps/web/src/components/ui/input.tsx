import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

/** Controle base: mesma altura, mesmo raio e mesma hairline dos botões. */
const control =
  'rounded-control border border-border bg-surface text-body-sm text-foreground transition-colors duration-150 placeholder:text-muted-fg/80 hover:border-border-strong focus:border-accent focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-55';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(control, 'h-9 w-full px-3', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(control, 'w-full resize-y px-3 py-2', className)} {...props} />;
}

/**
 * Select nativo (o e2e usa `selectOption`, e o nativo é o mais acessível em
 * teclado), mas com aparência própria: largura pelo CONTEÚDO — não estica para
 * o container — seta desenhada por nós e altura igual à dos botões.
 */
export function Select({
  className,
  full = false,
  size = 'md',
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  full?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <span className={clsx('relative inline-flex shrink-0 items-center', full && 'w-full')}>
      <select
        className={clsx(
          control,
          'w-auto appearance-none pr-8',
          size === 'sm' ? 'h-8 pl-2.5 text-data' : 'h-9 pl-3',
          full && 'w-full',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        size={14}
        strokeWidth={1.75}
        className="pointer-events-none absolute right-2.5 text-muted-fg"
      />
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-1.5 block text-muted-fg">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-data text-muted-fg">{hint}</span> : null}
      {error ? <span className="mt-1 block text-data text-negative">{error}</span> : null}
    </label>
  );
}

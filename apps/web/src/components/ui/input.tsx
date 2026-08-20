import { clsx } from 'clsx';
import type { InputHTMLAttributes, SelectHTMLAttributes } from 'react';

const base =
  'h-9 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted-fg focus:outline-none focus-visible:outline-2 focus-visible:outline-accent';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(base, className)} {...props} />;
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={clsx(base, 'pr-8', className)} {...props} />;
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-fg">
        {label}
      </span>
      {children}
      {error ? <span className="mt-1 block text-xs text-negative">{error}</span> : null}
    </label>
  );
}

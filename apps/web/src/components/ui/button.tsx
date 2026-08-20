import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  // acento é a ÚNICA cor de marca — gasta aqui e em pouco mais
  primary: 'bg-accent text-accent-fg hover:opacity-90 border border-transparent',
  secondary: 'bg-surface text-foreground border border-border hover:bg-surface-2',
  ghost:
    'bg-transparent text-muted-fg hover:bg-surface-2 hover:text-foreground border border-transparent',
  danger: 'bg-transparent text-negative border border-border hover:bg-surface-2',
};
const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

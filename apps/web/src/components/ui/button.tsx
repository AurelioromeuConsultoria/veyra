import { clsx } from 'clsx';
import type { ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
type Size = 'sm' | 'md' | 'icon';

const variants: Record<Variant, string> = {
  // acento é a ÚNICA cor de marca — gasta aqui e em pouco mais
  primary:
    'border border-accent bg-accent text-accent-fg shadow-raised hover:bg-accent-hover hover:border-accent-hover active:bg-accent-active',
  secondary:
    'border border-border bg-surface text-foreground hover:bg-surface-2 hover:border-border-strong',
  ghost:
    'border border-transparent bg-transparent text-muted-fg hover:bg-surface-2 hover:text-foreground',
  danger:
    'border border-border bg-transparent text-negative hover:border-negative/40 hover:bg-negative/10',
  // proveniência de IA: cobre, nunca o acento da marca (§6)
  ai: 'border border-ai/35 bg-ai/8 text-ai hover:bg-ai/15 hover:border-ai/55',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 gap-1.5 px-3 text-body-sm',
  md: 'h-9 gap-2 px-4 text-body-sm',
  icon: 'h-8 w-8 justify-center',
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
        // shrink-0 + nowrap: cabeçalho apertado empurra o botão, não o quebra
        'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control font-medium transition-[background-color,border-color,color] duration-150 ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

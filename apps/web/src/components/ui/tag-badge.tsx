import { clsx } from 'clsx';

/** Cores de tag = paleta fechada de tokens (nada de cor solta). */
const tagColors: Record<string, string> = {
  slate: 'bg-surface-2 text-foreground border-border',
  stone: 'bg-surface-2 text-muted-fg border-border',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  positive: 'border-positive/40 bg-positive/10 text-positive',
  negative: 'border-negative/40 bg-negative/10 text-negative',
  warning: 'border-warning/40 bg-warning/10 text-warning',
  info: 'border-info/40 bg-info/10 text-info',
};

export function TagBadge({ name, color }: { name: string; color: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        tagColors[color] ?? tagColors.slate,
      )}
    >
      {name}
    </span>
  );
}

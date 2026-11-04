import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * Estados com cor semântica FIXA (ADR-062): a mesma cor diz o mesmo estado em
 * todo o app — chip, bloco de agenda, marcador. Nunca para "dar cor".
 */
export type Tom = 'pending' | 'confirmed' | 'arrived' | 'done' | 'missed' | 'neutral' | 'accent';

const TONS: Record<Tom, string> = {
  pending: 'bg-state-pending text-state-pending-fg',
  confirmed: 'bg-state-confirmed text-state-confirmed-fg',
  arrived: 'bg-state-arrived text-state-arrived-fg',
  done: 'bg-state-done text-state-done-fg',
  missed: 'bg-state-missed text-state-missed-fg',
  neutral: 'bg-surface-2 text-muted-fg',
  accent: 'bg-accent/10 text-accent',
};

export function StatusChip({
  tom,
  children,
  className,
}: {
  tom: Tom;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-[12.5px] font-semibold',
        TONS[tom],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** O ponto do estado (listas compactas, legendas). */
export function StatusDot({ tom, className }: { tom: Tom; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        {
          pending: 'bg-state-pending-fg',
          confirmed: 'bg-state-confirmed-fg',
          arrived: 'bg-state-arrived-fg',
          done: 'bg-state-done-fg',
          missed: 'bg-state-missed-fg',
          neutral: 'bg-muted-fg',
          accent: 'bg-accent',
        }[tom],
        className,
      )}
    />
  );
}

import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { windowState, type WindowUrgency } from '../../lib/format';

/**
 * ASSINATURA VISUAL 1 — o medidor de janela.
 *
 * A janela de 24h do canal é a coisa mais característica deste produto: define
 * se dá para responder com texto livre ou se só resta template. Aqui ela é um
 * elemento próprio (hairline que se esvazia + carimbo em mono), não um texto de
 * debug. O INSTANTE de expiração vem do servidor; o cliente só lê o relógio —
 * política de envio continua sendo decisão da API (ADR-038).
 */

const tone: Record<WindowUrgency, { bar: string; text: string }> = {
  none: { bar: 'bg-border-strong', text: 'text-muted-fg' },
  // >6h é neutro: presente, sem pedir atenção que não merece
  calm: { bar: 'bg-muted-fg/55', text: 'text-muted-fg' },
  attention: { bar: 'bg-warning', text: 'text-warning' },
  urgent: { bar: 'bg-negative', text: 'text-negative' },
  closed: { bar: 'bg-border-strong', text: 'text-muted-fg' },
};

/** Relógio compartilhado: o medidor envelhece sozinho, sem consultar o servidor. */
function useMinuteTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [active]);
}

/** Carimbo compacto para a linha da lista — triagem por urgência. */
export function WindowChip({ expiresAt }: { expiresAt: string | null }) {
  useMinuteTick(expiresAt !== null);
  const state = windowState(expiresAt);
  if (state.urgency === 'none') return null;
  return (
    <span
      className={clsx(
        'num inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-data-xs',
        state.urgency === 'closed'
          ? 'bg-surface-2 text-muted-fg'
          : state.urgency === 'urgent'
            ? 'bg-negative/10 text-negative'
            : state.urgency === 'attention'
              ? 'bg-warning/12 text-warning'
              : 'bg-surface-2 text-muted-fg',
      )}
      title={
        state.urgency === 'closed'
          ? 'Janela de 24h fechada — só template'
          : `Janela de 24h: ${state.label} restantes`
      }
    >
      {state.urgency === 'closed' ? 'fechada' : state.label}
    </span>
  );
}

/**
 * Medidor sob o cabeçalho da conversa: a hairline se esvazia conforme a janela
 * queima. Fechada é estado EXPLÍCITO — trilho cheio, apagado e rotulado.
 */
export function WindowMeter({
  expiresAt,
  variant = 'panel',
}: {
  expiresAt: string | null;
  /**
   * `panel` — sob o cabeçalho da conversa: rótulo, trilho e tempo exato.
   * `inline` — só o trilho, para quando o tempo JÁ é o número-herói ao lado
   * (visão executiva). Repetir "2h18" duas vezes na mesma linha não informa
   * duas vezes; o que a assinatura acrescenta ali é a barra que se esvazia.
   */
  variant?: 'panel' | 'inline';
}) {
  useMinuteTick(expiresAt !== null);
  const state = windowState(expiresAt);
  if (state.urgency === 'none') return null;
  const closed = state.urgency === 'closed';
  return (
    <div
      className={clsx(
        'flex items-center gap-2.5',
        variant === 'panel' && 'border-b border-border bg-surface px-6 py-1.5',
      )}
    >
      {variant === 'panel' ? (
        <span className="eyebrow shrink-0 text-muted-fg">Janela 24h</span>
      ) : null}
      <span
        className="relative h-0.5 flex-1 overflow-hidden rounded-full bg-border"
        role="meter"
        aria-label="Janela de 24h do canal"
        aria-valuemin={0}
        aria-valuemax={24}
        aria-valuenow={Math.round((state.remainingMs / 3_600_000) * 10) / 10}
        aria-valuetext={closed ? 'janela fechada' : `${state.label} restantes`}
      >
        <span
          className={clsx(
            'absolute inset-y-0 left-0 block rounded-full transition-[width] duration-500 ease-[var(--ease-out)]',
            tone[state.urgency].bar,
            closed && 'w-full opacity-45',
          )}
          style={closed ? undefined : { width: `${Math.max(state.fraction * 100, 1.5)}%` }}
        />
      </span>
      {variant === 'panel' ? (
        <span className={clsx('num shrink-0 text-data-sm', tone[state.urgency].text)}>
          {closed ? 'fechada · só template' : `${state.label} restantes`}
        </span>
      ) : null}
    </div>
  );
}

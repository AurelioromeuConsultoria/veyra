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

/** Cor do chip por urgência — a mesma régua do medidor (§6.1): >6h neutro. */
const chipTone: Record<WindowUrgency, string> = {
  none: 'bg-surface-2 text-muted-fg',
  calm: 'bg-surface-2 text-muted-fg',
  attention: 'bg-warning/12 text-warning',
  urgent: 'bg-negative/10 text-negative',
  closed: 'bg-surface-2 text-muted-fg',
};

/**
 * Carimbo da janela.
 *
 * `compact` — na linha da lista, para a triagem por urgência.
 * `header` — no cabeçalho da conversa (ADR-062): o mesmo dado, em pílula
 * rotulada, porque ali ele é o primeiro aviso de que o texto livre pode não
 * sair. O medidor com o trilho fica no painel de contexto.
 */
export function WindowChip({
  expiresAt,
  variant = 'compact',
}: {
  expiresAt: string | null;
  variant?: 'compact' | 'header';
}) {
  useMinuteTick(expiresAt !== null);
  const state = windowState(expiresAt);
  if (state.urgency === 'none') return null;
  const closed = state.urgency === 'closed';
  const title = closed
    ? 'Janela de 24h fechada — só template'
    : `Janela de 24h: ${state.label} restantes`;
  if (variant === 'header') {
    return (
      <span
        className={clsx(
          'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[12.5px] font-semibold',
          chipTone[state.urgency],
        )}
        title={title}
      >
        {closed ? (
          'Janela fechada · só template'
        ) : (
          <>
            Janela · <span className="num font-medium">{state.label}</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span
      className={clsx(
        'num inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-data-xs',
        chipTone[state.urgency],
      )}
      title={title}
    >
      {closed ? 'fechada' : state.label}
    </span>
  );
}

/**
 * Medidor da janela: a hairline se esvazia conforme a janela queima. Fechada é
 * estado EXPLÍCITO — trilho cheio, apagado e rotulado.
 */
export function WindowMeter({
  expiresAt,
  variant = 'card',
}: {
  expiresAt: string | null;
  /**
   * `card` — no painel de contexto da conversa (ADR-062): rótulo e tempo exato
   * numa linha, o trilho embaixo.
   * `inline` — só o trilho, para quando o tempo JÁ é o número-herói ao lado
   * (visão executiva). Repetir "2h18" duas vezes na mesma linha não informa
   * duas vezes; o que a assinatura acrescenta ali é a barra que se esvazia.
   */
  variant?: 'card' | 'inline';
}) {
  useMinuteTick(expiresAt !== null);
  const state = windowState(expiresAt);
  if (state.urgency === 'none') return null;
  const closed = state.urgency === 'closed';
  const trilho = (
    <span
      className="relative block h-0.5 flex-1 overflow-hidden rounded-full bg-border"
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
  );
  if (variant === 'inline') return <div className="flex items-center gap-2.5">{trilho}</div>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] text-muted-fg">Janela de 24h</span>
        <span className={clsx('num text-data', tone[state.urgency].text)}>
          {closed ? 'fechada · só template' : `${state.label} restantes`}
        </span>
      </div>
      {trilho}
    </div>
  );
}

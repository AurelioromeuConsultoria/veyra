import { render, screen } from '@testing-library/react';
import { DispatchBadge } from './Inbox';

/**
 * A triagem dos envios incertos (ADR-047 adendo 7 §9, G3.2, decisão de
 * 2026-10-21): o despacho que a guarda PROVOU não ter saído continua
 * `unknown_after_dispatch` — sem reenvio automático —, mas não pode aparecer
 * como uma entrega desconhecida.
 */
describe('selo do despacho na triagem', () => {
  it('o incerto que a guarda provou não ter saído aparece como "Não saiu"', () => {
    render(<DispatchBadge state="unknown_after_dispatch" error="not_sent_guard_aborted" />);
    expect(
      screen.getByText('Não saiu · a guarda interrompeu antes do envio, sem cobrança'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Entrega não confirmada/)).not.toBeInTheDocument();
  });

  it('a entrega realmente desconhecida continua "Entrega não confirmada"', () => {
    render(<DispatchBadge state="unknown_after_dispatch" error="abandoned_in_flight" />);
    expect(
      screen.getByText('Entrega não confirmada · envio interrompido em andamento'),
    ).toBeInTheDocument();
  });

  it('o código "não saiu" só muda o selo do incerto', () => {
    render(<DispatchBadge state="failed_permanent" error="not_sent_guard_aborted" />);
    expect(screen.getByText(/^Não enviada/)).toBeInTheDocument();
  });
});

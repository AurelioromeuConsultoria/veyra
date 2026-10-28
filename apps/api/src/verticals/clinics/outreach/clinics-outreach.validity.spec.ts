import type { SituacaoDaOrigem } from '../../../business-outbound/business-outbound.service';
import {
  comprovadamenteNaoEnviado,
  estadoDoPedido,
  limiteDoPedido,
  type PedidoParaEstado,
} from './clinics-outreach.validity';

/**
 * O estado DERIVADO do pedido e a regra da marca (ADR-048 adendo 9, F4.2): são
 * eles que decidem o que a varredura apaga e quando um alvo fica livre. Ids e
 * instantes FICTÍCIOS.
 */
describe('o estado do pedido de envio', () => {
  const AGORA = new Date('2030-11-04T10:00:00.000Z');
  const HORA = 60 * 60_000;
  const confirmacao = (mudanca: Partial<PedidoParaEstado> = {}): PedidoParaEstado => ({
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'confirmation',
    appointmentId: '00000000-0000-4000-8000-000000000002',
    startsAt: new Date(AGORA.getTime() + 5 * HORA),
    returnId: null,
    activeMark: true,
    createdAt: new Date(AGORA.getTime() - HORA),
    ...mudanca,
  });
  const reativacao = (mudanca: Partial<PedidoParaEstado> = {}): PedidoParaEstado =>
    confirmacao({
      kind: 'reactivation',
      appointmentId: null,
      startsAt: null,
      returnId: '00000000-0000-4000-8000-000000000003',
      ...mudanca,
    });
  const situacao = (mudanca: Partial<SituacaoDaOrigem> = {}): SituacaoDaOrigem => ({
    messageId: '00000000-0000-4000-8000-000000000004',
    number: '+5511988887777',
    expiresAt: new Date(AGORA.getTime() + HORA),
    estado: 'reserved',
    errorCode: null,
    emVoo: false,
    ...mudanca,
  });

  it('o limite: o início menos duas horas, ou a criação mais 24 horas', () => {
    expect(limiteDoPedido(confirmacao())).toEqual(new Date(AGORA.getTime() + 3 * HORA));
    expect(limiteDoPedido(reativacao())).toEqual(new Date(AGORA.getTime() + 23 * HORA));
  });

  it('sem aprovação: rascunho enquanto conta e o limite não passou; depois, não enviado', () => {
    expect(estadoDoPedido(confirmacao(), undefined, AGORA)).toBe('draft');
    // o limite exato já passou (a duas horas do início, não é elegível)
    const noLimite = confirmacao({ startsAt: new Date(AGORA.getTime() + 2 * HORA) });
    expect(estadoDoPedido(noLimite, undefined, AGORA)).toBe('not_sent');
    expect(estadoDoPedido(confirmacao({ activeMark: null }), undefined, AGORA)).toBe('not_sent');
    const velha = reativacao({ createdAt: new Date(AGORA.getTime() - 25 * HORA) });
    expect(estadoDoPedido(velha, undefined, AGORA)).toBe('not_sent');
  });

  it('com aprovação, pelo despacho: o terminal é terminal, e a falha transitória espera o prazo', () => {
    const p = confirmacao();
    expect(estadoDoPedido(p, situacao({ estado: 'sent' }), AGORA)).toBe('sent');
    expect(estadoDoPedido(p, situacao({ estado: 'unknown_after_dispatch' }), AGORA)).toBe(
      'uncertain',
    );
    expect(estadoDoPedido(p, situacao({ estado: 'canceled' }), AGORA)).toBe('not_sent');
    expect(estadoDoPedido(p, situacao({ estado: 'failed_permanent' }), AGORA)).toBe('not_sent');
    // em curso, mesmo depois do prazo: a chamada pode ter começado
    const vencida = new Date(AGORA.getTime() - 1);
    expect(estadoDoPedido(p, situacao({ estado: 'sending', expiresAt: vencida }), AGORA)).toBe(
      'pending',
    );
    // reservado ou com falha transitória: pendente até o prazo, não enviado depois
    for (const estado of ['reserved', 'failed_before_send'] as const) {
      expect(estadoDoPedido(p, situacao({ estado }), AGORA)).toBe('pending');
      expect(estadoDoPedido(p, situacao({ estado, expiresAt: vencida }), AGORA)).toBe('not_sent');
      expect(estadoDoPedido(p, situacao({ estado, expiresAt: AGORA }), AGORA)).toBe('not_sent');
    }
    // a marca não decide depois da aprovação: o despacho decide
    expect(estadoDoPedido(confirmacao({ activeMark: null }), situacao(), AGORA)).toBe('pending');
  });

  it('a marca só sai do comprovadamente não enviado: sem aprovação, cancelado ou recusado antes de sair', () => {
    expect(comprovadamenteNaoEnviado(undefined)).toBe(true);
    expect(comprovadamenteNaoEnviado(situacao({ estado: 'canceled' }))).toBe(true);
    expect(comprovadamenteNaoEnviado(situacao({ estado: 'failed_permanent' }))).toBe(true);
    for (const estado of [
      'reserved',
      'sending',
      'failed_before_send',
      'sent',
      'unknown_after_dispatch',
    ] as const) {
      expect(comprovadamenteNaoEnviado(situacao({ estado }))).toBe(false);
    }
    // sem despacho conhecido, não se prova nada
    expect(comprovadamenteNaoEnviado(situacao({ estado: null }))).toBe(false);
  });
});

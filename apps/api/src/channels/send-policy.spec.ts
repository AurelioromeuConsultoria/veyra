import { decideSend, SERVICE_WINDOW_MS, windowRemainingMs } from './send-policy';

const agora = new Date('2026-08-21T12:00:00.000Z');
const base = {
  remetente: 'confere' as const,
  bloqueado: false,
  templatePedido: false,
  externalAddress: '+5511999998888',
  now: agora,
};

describe('política de envio (ADR-038)', () => {
  it('dentro da janela, resposta livre é permitida SEM consentimento', () => {
    const decisao = decideSend({
      ...base,
      lastInboundAt: new Date(agora.getTime() - 60_000),
    });
    expect(decisao).toEqual({ allowed: true, kind: 'free_form' });
  });

  it('na borda da janela: 23h59 permite, 24h01 não', () => {
    const quase = decideSend({
      ...base,
      lastInboundAt: new Date(agora.getTime() - (SERVICE_WINDOW_MS - 60_000)),
    });
    expect(quase.allowed).toBe(true);

    const passou = decideSend({
      ...base,
      lastInboundAt: new Date(agora.getTime() - (SERVICE_WINDOW_MS + 60_000)),
    });
    expect(passou).toEqual({ allowed: false, reason: 'window_closed_needs_template' });
  });

  it('fora da janela, o texto livre não sai', () => {
    expect(decideSend({ ...base, lastInboundAt: null })).toEqual({
      allowed: false,
      reason: 'window_closed_needs_template',
    });
  });

  it('template, dentro ou fora da janela, é indisponível na transição (F4.1b)', () => {
    for (const lastInboundAt of [new Date(agora.getTime() - 60_000), null]) {
      expect(decideSend({ ...base, lastInboundAt, templatePedido: true })).toEqual({
        allowed: false,
        reason: 'template_flow_unavailable',
      });
    }
  });

  it('o pedido de parar recusa tudo, antes do remetente e do template (C16, F4.1b)', () => {
    for (const extra of [
      { lastInboundAt: new Date(agora.getTime() - 60_000) },
      { lastInboundAt: null, templatePedido: true },
      { lastInboundAt: new Date(agora.getTime() - 60_000), remetente: 'a_identificar' as const },
      { lastInboundAt: null, remetente: 'numero_nao_confere' as const },
    ]) {
      expect(decideSend({ ...base, ...extra, bloqueado: true })).toEqual({
        allowed: false,
        reason: 'stop_requested',
      });
    }
  });

  it('sem endereço externo não há envio — não se escolhe telefone do contato', () => {
    const decisao = decideSend({
      ...base,
      externalAddress: null,
      lastInboundAt: new Date(agora.getTime() - 60_000),
    });
    expect(decisao).toEqual({ allowed: false, reason: 'no_external_address' });
  });

  it('a RAI e o número que não confere de forma exata não recebem nada, nem template (ADR-052 item 2)', () => {
    for (const extra of [
      { lastInboundAt: new Date(agora.getTime() - 60_000) },
      { lastInboundAt: null, templatePedido: true },
    ]) {
      expect(decideSend({ ...base, ...extra, remetente: 'a_identificar' })).toEqual({
        allowed: false,
        reason: 'sender_unidentified',
      });
      expect(decideSend({ ...base, ...extra, remetente: 'numero_nao_confere' })).toEqual({
        allowed: false,
        reason: 'number_not_exact',
      });
    }
  });

  it('tempo restante da janela: zero sem entrada, decrescente com o tempo', () => {
    expect(windowRemainingMs(null, agora)).toBe(0);
    const doisDias = new Date(agora.getTime() - 2 * SERVICE_WINDOW_MS);
    expect(windowRemainingMs(doisDias, agora)).toBe(0);
    const umaHora = new Date(agora.getTime() - 60 * 60 * 1000);
    expect(windowRemainingMs(umaHora, agora)).toBe(SERVICE_WINDOW_MS - 60 * 60 * 1000);
  });
});

import { decideSend, SERVICE_WINDOW_MS, windowRemainingMs } from './send-policy';

const agora = new Date('2026-08-21T12:00:00.000Z');
const base = {
  hasActiveConsent: false,
  template: null,
  templateParams: [],
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

  it('fora da janela exige template', () => {
    expect(decideSend({ ...base, lastInboundAt: null })).toEqual({
      allowed: false,
      reason: 'window_closed_needs_template',
    });
  });

  it('template exige consentimento vigente, mesmo dentro da janela', () => {
    const semConsentimento = decideSend({
      ...base,
      lastInboundAt: new Date(agora.getTime() - 60_000),
      template: { name: 'lembrete', language: 'pt_BR', paramCount: 1 },
      templateParams: ['Ana'],
    });
    expect(semConsentimento).toEqual({ allowed: false, reason: 'template_requires_consent' });

    const comConsentimento = decideSend({
      ...base,
      hasActiveConsent: true,
      lastInboundAt: null,
      template: { name: 'lembrete', language: 'pt_BR', paramCount: 1 },
      templateParams: ['Ana'],
    });
    expect(comConsentimento).toEqual({ allowed: true, kind: 'template' });
  });

  it('parâmetros do template têm de casar exatamente', () => {
    const decisao = decideSend({
      ...base,
      hasActiveConsent: true,
      lastInboundAt: null,
      template: { name: 'lembrete', language: 'pt_BR', paramCount: 2 },
      templateParams: ['Ana'],
    });
    expect(decisao).toEqual({ allowed: false, reason: 'template_params_mismatch' });
  });

  it('sem endereço externo não há envio — não se escolhe telefone do contato', () => {
    const decisao = decideSend({
      ...base,
      externalAddress: null,
      lastInboundAt: new Date(agora.getTime() - 60_000),
    });
    expect(decisao).toEqual({ allowed: false, reason: 'no_external_address' });
  });

  it('tempo restante da janela: zero sem entrada, decrescente com o tempo', () => {
    expect(windowRemainingMs(null, agora)).toBe(0);
    const doisDias = new Date(agora.getTime() - 2 * SERVICE_WINDOW_MS);
    expect(windowRemainingMs(doisDias, agora)).toBe(0);
    const umaHora = new Date(agora.getTime() - 60 * 60 * 1000);
    expect(windowRemainingMs(umaHora, agora)).toBe(SERVICE_WINDOW_MS - 60 * 60 * 1000);
  });
});

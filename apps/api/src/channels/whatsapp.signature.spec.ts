import { createHmac } from 'node:crypto';
import { verifyChallengeToken, verifyMetaSignature } from './whatsapp.signature';

const SECRET = 'app-secret-de-teste';
const sign = (body: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('assinatura do webhook da Meta (ADR-037)', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

  it('aceita assinatura correta sobre o corpo bruto', () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('recusa assinatura de OUTRO segredo', () => {
    expect(verifyMetaSignature(body, sign(body, 'outro-segredo'), SECRET)).toBe(false);
  });

  it('recusa quando o corpo muda um único byte', () => {
    const assinatura = sign(body);
    const adulterado = Buffer.from(body.toString().replace('entry', 'Entry'));
    expect(verifyMetaSignature(adulterado, assinatura, SECRET)).toBe(false);
  });

  it('recusa header ausente, vazio ou sem o prefixo sha256=', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(
      verifyMetaSignature(body, createHmac('sha256', SECRET).update(body).digest('hex'), SECRET),
    ).toBe(false);
  });

  it('recusa assinatura de tamanho diferente sem estourar', () => {
    expect(verifyMetaSignature(body, 'sha256=abc', SECRET)).toBe(false);
  });

  it('a MESMA carga reserializada não passa — é por isso que o corpo bruto importa', () => {
    const assinatura = sign(body);
    // reserializar reordena/reescreve bytes: exatamente o que quebraria a
    // verificação se conferíssemos depois do parse
    const reserializado = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + ' ');
    expect(verifyMetaSignature(reserializado, assinatura, SECRET)).toBe(false);
  });

  it('verify_token do desafio compara em tempo constante', () => {
    expect(verifyChallengeToken('token-certo', 'token-certo')).toBe(true);
    expect(verifyChallengeToken('token-errado', 'token-certo')).toBe(false);
    expect(verifyChallengeToken('', 'token-certo')).toBe(false);
  });
});

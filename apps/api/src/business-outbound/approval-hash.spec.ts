import { createHmac } from 'node:crypto';
import { approvalHash, formaDaAprovacao, mesmoHash, type FormaDaAprovacao } from './approval-hash';

/**
 * O `approvalHash` (F4.1c-3, ADR-052 item 8): a forma canônica escrita à mão e
 * o HMAC dela. Ids e valores FICTÍCIOS.
 */
describe('o approvalHash', () => {
  const chave = Buffer.from('chave-da-aprovacao-do-envio-de-teste-32', 'utf8');
  const forma: FormaDaAprovacao = {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    channelId: '00000000-0000-4000-8000-000000000002',
    phoneNumberId: '100000000000001',
    contactId: '00000000-0000-4000-8000-000000000003',
    number: '+5511988887777',
    templateVersionId: '00000000-0000-4000-8000-000000000004',
    contentHash: 'a'.repeat(64),
    templateReviewId: '00000000-0000-4000-8000-000000000005',
    purposeId: '00000000-0000-4000-8000-000000000006',
    consentId: '00000000-0000-4000-8000-000000000007',
    values: { 'body.2': 'dois', 'body.1': 'Ana Ficticia' },
    originRef: 'conversation:00000000-0000-4000-8000-000000000008',
    validityKeys: ['teste.b', 'teste.a'],
    expiresAt: new Date('2026-10-27T15:00:00.000Z'),
  };

  it('a forma canônica v1: chaves ordenadas em todo nível, chaves de validade em ordem, prazo ISO', () => {
    expect(formaDaAprovacao(forma)).toBe(
      '{"channelId":"00000000-0000-4000-8000-000000000002",' +
        '"consentId":"00000000-0000-4000-8000-000000000007",' +
        '"contactId":"00000000-0000-4000-8000-000000000003",' +
        `"contentHash":"${'a'.repeat(64)}",` +
        '"expiresAt":"2026-10-27T15:00:00.000Z",' +
        '"number":"+5511988887777",' +
        '"originRef":"conversation:00000000-0000-4000-8000-000000000008",' +
        '"phoneNumberId":"100000000000001",' +
        '"purposeId":"00000000-0000-4000-8000-000000000006",' +
        '"templateReviewId":"00000000-0000-4000-8000-000000000005",' +
        '"templateVersionId":"00000000-0000-4000-8000-000000000004",' +
        '"v":1,' +
        '"validityKeys":["teste.a","teste.b"],' +
        '"values":{"body.1":"Ana Ficticia","body.2":"dois"},' +
        '"workspaceId":"00000000-0000-4000-8000-000000000001"}',
    );
  });

  it('é o HMAC-SHA256 da forma, com a chave do servidor, em hex', () => {
    const esperado = createHmac('sha256', chave).update(formaDaAprovacao(forma)).digest('hex');
    expect(approvalHash(chave, forma)).toBe(esperado);
    expect(approvalHash(chave, forma)).toMatch(/^[0-9a-f]{64}$/);
    // outra chave, outro hash: sem a do servidor, ninguém o calcula
    expect(approvalHash(Buffer.from('outra-chave-qualquer-com-32-caracteres'), forma)).not.toBe(
      esperado,
    );
  });

  it('cada campo da forma muda o hash: nenhum fica de fora', () => {
    const base = approvalHash(chave, forma);
    const mudancas: Partial<FormaDaAprovacao>[] = [
      { workspaceId: '00000000-0000-4000-8000-0000000000ff' },
      { channelId: '00000000-0000-4000-8000-0000000000ff' },
      { phoneNumberId: '100000000000002' },
      { contactId: '00000000-0000-4000-8000-0000000000ff' },
      { number: '+5511988887778' },
      { templateVersionId: '00000000-0000-4000-8000-0000000000ff' },
      { contentHash: 'b'.repeat(64) },
      { templateReviewId: '00000000-0000-4000-8000-0000000000ff' },
      { purposeId: '00000000-0000-4000-8000-0000000000ff' },
      { consentId: '00000000-0000-4000-8000-0000000000ff' },
      { values: { 'body.1': 'Ana Ficticia', 'body.2': 'Dois' } },
      { originRef: 'conversation:00000000-0000-4000-8000-0000000000ff' },
      { validityKeys: ['teste.a'] },
      { expiresAt: new Date('2026-10-27T15:00:00.001Z') },
    ];
    for (const mudanca of mudancas) {
      expect(approvalHash(chave, { ...forma, ...mudanca })).not.toBe(base);
    }
  });

  it('a ordem dos valores e das chaves de validade não muda o hash', () => {
    expect(
      approvalHash(chave, {
        ...forma,
        values: { 'body.1': 'Ana Ficticia', 'body.2': 'dois' },
        validityKeys: ['teste.a', 'teste.b'],
      }),
    ).toBe(approvalHash(chave, forma));
  });

  it('a comparação aceita só o mesmo hash', () => {
    const h = approvalHash(chave, forma);
    expect(mesmoHash(h, h)).toBe(true);
    expect(mesmoHash(h, h.replace(/.$/, h.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(mesmoHash(h, h.slice(1))).toBe(false);
  });
});

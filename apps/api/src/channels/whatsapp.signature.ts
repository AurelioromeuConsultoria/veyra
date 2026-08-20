import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verificação de `X-Hub-Signature-256` sobre o CORPO BRUTO (ADR-037).
 *
 * Reserializar o JSON para conferir mudaria bytes (ordem de chaves, escapes,
 * espaços) e invalidaria a comparação — por isso o corpo bruto é preservado na
 * requisição e a assinatura é conferida ANTES de qualquer parse de domínio.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const received = header.slice('sha256='.length);
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual exige mesmo tamanho: comparar o tamanho antes não vaza
  // nada além do que o próprio formato já revela
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Comparação em tempo constante do verify_token do desafio GET. */
export function verifyChallengeToken(received: string, expected: string): boolean {
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

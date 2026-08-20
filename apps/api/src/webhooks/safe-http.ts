import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'node:https';
import ipaddr from 'ipaddr.js';

/**
 * Defesa SSRF com PINNING DE IP (ajuste #6 da revisão do plano).
 *
 * Validar o IP antes do fetch não basta: entre a validação e a conexão, o DNS
 * pode responder outro endereço (DNS rebinding). Aqui o IP validado é o IP
 * EFETIVAMENTE usado — um Agent com `lookup` fixo devolve sempre o endereço já
 * aprovado para aquela conexão. Sem redirects (cada hop seria um novo alvo).
 *
 * Classificação por `ipaddr.js` (biblioteca madura), nunca regex: cobre IPv4,
 * IPv6, IPv4-mapeado-em-IPv6 e todas as faixas reservadas.
 */

/** Ranges do ipaddr.js que NÃO são internet pública. */
const BLOCKED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'private',
  'reserved',
  'uniqueLocal',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
  'carrierGradeNat',
]);

export class UnsafeUrlError extends Error {}

export function assertPublicIp(address: string): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    throw new UnsafeUrlError(`Endereço inválido: ${address}`);
  }
  // IPv4 mapeado em IPv6 (::ffff:127.0.0.1) precisa ser avaliado como IPv4
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      assertPublicIp(v6.toIPv4Address().toString());
      return;
    }
  }
  const range = parsed.range();
  if (BLOCKED_RANGES.has(range)) {
    throw new UnsafeUrlError(`Endereço não público (${range}): ${address}`);
  }
}

export function assertSafeWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('URL inválida');
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeUrlError('Webhook exige https');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URL não pode conter credenciais');
  }
  // host literal já classificável (sem DNS): rejeita cedo
  if (ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))) {
    assertPublicIp(url.hostname.replace(/^\[|\]$/g, ''));
  }
  return url;
}

export interface SafeFetchResult {
  status: number;
  durationMs: number;
}

/**
 * POST com IP pinado. Resolve o host, valida TODOS os endereços retornados
 * (um só reprovado já derruba a entrega) e conecta no endereço aprovado.
 */
export async function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 5_000,
): Promise<SafeFetchResult> {
  const url = assertSafeWebhookUrl(rawUrl);
  const resolved = await dnsLookup(url.hostname, { all: true, verbatim: true });
  if (resolved.length === 0) throw new UnsafeUrlError('Host não resolve');
  for (const entry of resolved) assertPublicIp(entry.address);
  const pinned = resolved[0];

  const agent = new Agent({
    // PINNING: a conexão usa exatamente o endereço validado — DNS rebinding
    // entre a checagem e o connect não tem efeito
    lookup: (_hostname, _options, callback) => {
      (callback as (err: Error | null, address: string, family: number) => void)(
        null,
        pinned.address,
        pinned.family,
      );
    },
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
      redirect: 'error', // cada redirect seria um alvo novo, não validado
      signal: controller.signal,
      // @ts-expect-error dispatcher/agent do runtime Node
      agent,
    });
    return { status: response.status, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}

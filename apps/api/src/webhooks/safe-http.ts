import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, request as httpsRequest } from 'node:https';
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

const MAX_RESPONSE_BYTES = 64 * 1024; // resposta é descartada; só o status importa

/**
 * POST com IP PINADO. Resolve o host, valida TODOS os endereços retornados (um
 * só reprovado derruba a entrega) e conecta EXATAMENTE no endereço aprovado.
 *
 * Usa `https.request` (não `fetch`): o `fetch` do Node roda sobre undici, que
 * IGNORA a opção `agent` — o pinning seria silenciosamente descartado e o
 * rebinding continuaria possível. Com `https.request`, o `lookup` do Agent é
 * de fato usado na conexão.
 *
 * Redirects não são seguidos (cada hop seria um alvo novo, não validado).
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
    keepAlive: false,
    // PINNING: a conexão usa o endereço JÁ validado — uma segunda resposta de
    // DNS (rebinding) entre a checagem e o connect não tem efeito nenhum.
    // Respeita o contrato do dns.lookup: com `all: true` o callback recebe uma
    // LISTA; devolver string nesse caso corromperia a conexão.
    lookup: (_hostname, options, callback) => {
      const wantsAll = typeof options === 'object' && options !== null && options.all === true;
      if (wantsAll) {
        (callback as unknown as (err: Error | null, addresses: unknown) => void)(null, [
          { address: pinned.address, family: pinned.family },
        ]);
        return;
      }
      (callback as (err: Error | null, address: string, family: number) => void)(
        null,
        pinned.address,
        pinned.family,
      );
    },
  });

  const started = Date.now();
  return new Promise<SafeFetchResult>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname, // mantém SNI/Host corretos; o IP vem do lookup
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent,
        timeout: timeoutMs,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          agent.destroy();
          reject(new UnsafeUrlError('Redirect não é seguido em webhook'));
          return;
        }
        // descarta o corpo com teto: endpoint malicioso não segura o socket
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) response.destroy();
        });
        response.on('end', () => {
          agent.destroy();
          resolve({ status, durationMs: Date.now() - started });
        });
        response.on('close', () => {
          agent.destroy();
          resolve({ status, durationMs: Date.now() - started });
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`Timeout de ${timeoutMs}ms na entrega`));
    });
    request.on('error', (error) => {
      agent.destroy();
      reject(error);
    });
    request.end(body);
  });
}

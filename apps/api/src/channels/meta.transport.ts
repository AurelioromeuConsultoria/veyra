import { request as httpsRequest } from 'node:https';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TransportFailure } from './meta-errors';

/**
 * Porta do transporte da Meta. Produção fala com a Graph API; os testes injetam
 * um falso — a suíte nunca toca a rede, e é assim que conseguimos exercitar
 * timeout e erro ambíguo de forma determinística.
 */
export const META_TRANSPORT = Symbol('META_TRANSPORT');

export interface SendCredential {
  phoneNumberId: string;
  token: string;
}

export type SendOutcome =
  { ok: true; externalId: string } | { ok: false; failure: TransportFailure };

export type FetchOutcome =
  { ok: true; bytes: Buffer; mimeType: string } | { ok: false; failure: TransportFailure };

export interface MetaTransport {
  sendText(credential: SendCredential, to: string, body: string): Promise<SendOutcome>;
  sendTemplate(
    credential: SendCredential,
    to: string,
    template: { name: string; language: string },
    params: string[],
  ): Promise<SendOutcome>;
  fetchMedia(credential: SendCredential, mediaId: string): Promise<FetchOutcome>;
}

/** Hosts da Meta permitidos. Nada fora daqui é buscado, e não seguimos redirect. */
const ALLOWED_HOSTS = new Set(['graph.facebook.com']);
const ALLOWED_HOST_SUFFIX = '.fbsbx.com';
const TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function hostAllowed(host: string): boolean {
  return ALLOWED_HOSTS.has(host) || host.endsWith(ALLOWED_HOST_SUFFIX);
}

interface RawResponse {
  status: number;
  body: Buffer;
  contentType?: string;
}

/**
 * Destinatário no formato do PROVEDOR: só dígitos, que é exatamente o `wa_id`
 * que a Meta nos entregou na ingestão.
 *
 * Guardamos `+E.164` na conversa porque é o formato correto para exibir e
 * comparar; o `+` era repassado no envio. A API costuma tolerar, mas devolver ao
 * provedor o identificador que ele mesmo emitiu elimina a dúvida — e era o item
 * nº 1 da lista de conferência contra uma WABA real (ADR-039).
 */
const providerAddress = (to: string): string => to.replace(/\D/g, '');

/** HTTPS com host allowlistado, sem redirect e com teto de corpo. */
function call(
  url: string,
  options: { method: string; token: string; json?: unknown; maxBytes?: number },
): Promise<RawResponse> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !hostAllowed(target.hostname)) {
    return Promise.reject(new Error('Host não permitido'));
  }
  const payload = options.json === undefined ? undefined : JSON.stringify(options.json);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: options.method,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        // sem seguir redirect: um 3xx levaria a busca para fora da allowlist
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > (options.maxBytes ?? 256 * 1024)) {
            req.destroy(new Error('Resposta acima do teto'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            contentType: res.headers['content-type'],
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

@Injectable()
export class GraphApiTransport implements MetaTransport {
  private readonly logger = new Logger(GraphApiTransport.name);
  private readonly version: string;

  constructor(config: ConfigService) {
    this.version = config.get<string>('META_GRAPH_VERSION') ?? 'v21.0';
  }

  async sendText(credential: SendCredential, to: string, body: string): Promise<SendOutcome> {
    return this.send(credential, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: providerAddress(to),
      type: 'text',
      text: { body, preview_url: false },
    });
  }

  async sendTemplate(
    credential: SendCredential,
    to: string,
    template: { name: string; language: string },
    params: string[],
  ): Promise<SendOutcome> {
    return this.send(credential, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: providerAddress(to),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.language },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    });
  }

  private async send(credential: SendCredential, payload: unknown): Promise<SendOutcome> {
    const url = `https://graph.facebook.com/${this.version}/${credential.phoneNumberId}/messages`;
    let response: RawResponse;
    try {
      response = await call(url, { method: 'POST', token: credential.token, json: payload });
    } catch {
      // sem resposta: pode ter chegado. A classificação decide, não este ponto.
      return { ok: false, failure: { networkFailure: true } };
    }
    if (response.status >= 200 && response.status < 300) {
      const parsed = this.parse(response.body);
      const externalId = parsed?.messages?.[0]?.id;
      if (!externalId) return { ok: false, failure: { status: response.status } };
      return { ok: true, externalId };
    }
    return {
      ok: false,
      failure: { status: response.status, metaCode: this.parse(response.body)?.error?.code },
    };
  }

  async fetchMedia(credential: SendCredential, mediaId: string): Promise<FetchOutcome> {
    try {
      // 1) metadados: a URL de download vem da própria Meta
      const meta = await call(`https://graph.facebook.com/${this.version}/${mediaId}`, {
        method: 'GET',
        token: credential.token,
      });
      if (meta.status < 200 || meta.status >= 300) {
        return { ok: false, failure: { status: meta.status } };
      }
      const parsed = this.parse(meta.body);
      const url = parsed?.url;
      if (typeof url !== 'string') return { ok: false, failure: { status: meta.status } };

      // 2) bytes, com o mesmo Bearer, host allowlistado e teto
      const bytes = await call(url, {
        method: 'GET',
        token: credential.token,
        maxBytes: MAX_MEDIA_BYTES,
      });
      if (bytes.status < 200 || bytes.status >= 300) {
        return { ok: false, failure: { status: bytes.status } };
      }
      return {
        ok: true,
        bytes: bytes.body,
        mimeType: (bytes.contentType ?? 'application/octet-stream').split(';')[0].trim(),
      };
    } catch (error) {
      this.logger.error(`Falha ao coletar mídia (${(error as Error).name})`);
      return { ok: false, failure: { networkFailure: true } };
    }
  }

  /** Nunca logamos o corpo: só extraímos o que interessa. */
  private parse(body: Buffer): {
    messages?: { id?: string }[];
    url?: string;
    error?: { code?: number };
  } | null {
    try {
      return JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  }
}

export { providerAddress, hostAllowed };

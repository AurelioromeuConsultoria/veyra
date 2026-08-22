/**
 * Redação de erro do provedor para poder CIRCULAR (issue, chat, commit).
 *
 * Regra da revisão da validação da 9.1: para corrigir a integração bastam o
 * código, a classificação, a mensagem e o contexto — token, `Authorization`,
 * assinatura HMAC, ids de conta e números reais não precisam viajar, e uma vez
 * colados em algum lugar não voltam.
 *
 * Falha FECHADO: string em chave não allowlistada é redigida, de qualquer
 * tamanho, e segredo EMBUTIDO em texto preservado também. Preferimos
 * perder detalhe a vazar credencial. Vive em `src` (e não no script) para ter
 * teste e poder ser reusada em sanitização de log.
 */
/** Chaves cujo VALOR nunca sai, em qualquer profundidade. */
const SEGREDOS = new Set([
  'authorization',
  'access_token',
  'token',
  'tokencipher',
  'x-hub-signature',
  'x-hub-signature-256',
  'appsecret_proof',
  'app_secret',
  'verify_token',
  'client_secret',
  'phone_number_id',
  'business_account_id',
  'waba_id',
  'display_phone_number',
  'wa_id',
  'from',
  'to',
  'recipient_id',
  'id',
  'fbtrace_id',
]);

/** Chaves que interessam para corrigir a integração e saem em claro. */
const PRESERVAR = new Set([
  'code',
  'subcode',
  'error_subcode',
  'type',
  'message',
  'error_user_title',
  'error_user_msg',
  'status',
  'statuscode',
  'messaging_product',
  'name',
  'language',
  'category',
  'reason',
  'errorcode',
]);

const E164 = /\+?\d{10,15}/g;
const BEARER = /Bearer\s+[A-Za-z0-9._-]+/gi;
const TOKEN_META = /\bEAA[A-Za-z0-9._-]{10,}/g;
/**
 * Segredo EMBUTIDO em texto que a gente PRESERVA: a Meta ecoa pedaços da
 * requisição dentro de `message`, e `access_token=…` ali dentro sobreviveria a
 * qualquer allowlist de chave. O NOME do parâmetro fica (ajuda a entender o
 * erro), o valor não.
 */
const PAR_SENSIVEL =
  /\b(access[_-]?token|token|secret|client[_-]?secret|app[_-]?secret|signature|sig|authorization|auth|password|passwd|senha|api[_-]?key|key|appsecret_proof)\b\s*[:=]\s*["']?[^\s"',;)]+/gi;
/** Hex longo: segredo que NÃO começa com EAA (assinatura, chave, hash). */
const HEX_LONGO = /\b[0-9a-f]{32,}\b/gi;
/**
 * JWT: três segmentos base64url separados por ponto. Precisa de padrão próprio
 * porque cada segmento tem menos de 40 caracteres e o limite de sequência longa
 * não atravessa os pontos — baixar aquele limite comeria nome de template, que é
 * exatamente o dado que precisamos preservar.
 */
const JWT = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+)?\b/g;
/** Sequência longa com cara de credencial codificada (base64, base64url). */
const OPACO_LONGO = /\b[A-Za-z0-9+/=_-]{40,}\b/g;

export function redigirTexto(valor: string): string {
  return valor
    .replace(BEARER, 'Bearer [REDIGIDO]')
    .replace(TOKEN_META, '[TOKEN REDIGIDO]')
    .replace(PAR_SENSIVEL, (_todo, nome: string) => `${nome}=[REDIGIDO]`)
    .replace(JWT, '[REDIGIDO]')
    .replace(HEX_LONGO, '[REDIGIDO]')
    .replace(OPACO_LONGO, '[REDIGIDO]')
    .replace(E164, '[NUMERO]');
}

export function redigir(valor: unknown, chave?: string): unknown {
  const nome = chave?.toLowerCase();
  if (nome && SEGREDOS.has(nome)) return '[REDIGIDO]';
  if (Array.isArray(valor)) return valor.map((item) => redigir(item));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, redigir(v, k)]),
    );
  }
  if (typeof valor === 'string') {
    /**
     * Chave não allowlistada: redige SEMPRE, qualquer tamanho. A versão anterior
     * só redigia acima de 80 caracteres — um segredo curto (assinatura truncada,
     * id interno, senha) passava inteiro, e a promessa de "falha fechado" era
     * falsa justamente no caso pequeno.
     */
    if (!nome || !PRESERVAR.has(nome)) return '[REDIGIDO]';
    // chave preservada: o texto ainda passa pelos padrões de segredo embutido
    return redigirTexto(valor);
  }
  return valor;
}

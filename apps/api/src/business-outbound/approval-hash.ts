import { createHmac, timingSafeEqual } from 'node:crypto';
import { jsonCanonico } from '../templates/template-canonical';

/**
 * O `approvalHash` (ADR-052 item 8, F4.1c-3): o HMAC-SHA256, com a chave do
 * servidor (`OUTBOUND_APPROVAL_KEY`), da forma canônica do que a pessoa
 * aprovou. É HMAC, e não hash simples, porque os valores têm pouca entropia (um
 * nome, um número) e não ficam guardados: sem a chave, ninguém confere um
 * palpite contra o hash, nem forja o prazo ou os valores.
 *
 * A prévia o calcula; a aprovação e o despacho o RECALCULAM com os dados de
 * agora. O que divergir não sai — nada é atualizado em silêncio.
 */

/** O que a aprovação cobre. Mudou qualquer campo, o hash é outro. */
export interface FormaDaAprovacao {
  workspaceId: string;
  channelId: string;
  /** o número da empresa na Meta, pela credencial de agora */
  phoneNumberId: string;
  contactId: string;
  number: string;
  templateVersionId: string;
  contentHash: string;
  templateReviewId: string;
  purposeId: string;
  consentId: string;
  /** parâmetro → valor exato, como na prévia */
  values: Readonly<Record<string, string>>;
  originRef: string;
  /** as chaves de validade do E7, fixadas na criação */
  validityKeys: readonly string[];
  expiresAt: Date;
}

/** A versão da forma: mudar a forma exige outra versão, nunca reinterpretar a velha. */
const VERSAO_DA_FORMA = 1;

/**
 * A forma canônica `v1`: JSON com as chaves ordenadas em todo nível, as chaves
 * de validade em ordem e o prazo em ISO com milissegundos.
 */
export function formaDaAprovacao(f: FormaDaAprovacao): string {
  return jsonCanonico({
    v: VERSAO_DA_FORMA,
    workspaceId: f.workspaceId,
    channelId: f.channelId,
    phoneNumberId: f.phoneNumberId,
    contactId: f.contactId,
    number: f.number,
    templateVersionId: f.templateVersionId,
    contentHash: f.contentHash,
    templateReviewId: f.templateReviewId,
    purposeId: f.purposeId,
    consentId: f.consentId,
    values: { ...f.values },
    originRef: f.originRef,
    validityKeys: [...f.validityKeys].sort(),
    expiresAt: f.expiresAt.toISOString(),
  });
}

export function approvalHash(chave: Buffer, f: FormaDaAprovacao): string {
  return createHmac('sha256', chave).update(formaDaAprovacao(f)).digest('hex');
}

/** A comparação em tempo constante: o hash recebido nunca vaza por tempo de resposta. */
export function mesmoHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

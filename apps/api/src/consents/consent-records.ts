import type { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/decorators';
import type { Db } from '../prisma/prisma.service';

/**
 * As peças do consentimento e do pedido de parar que outros módulos usam na
 * PRÓPRIA transação (ADR-052 item 5, F4.1b): o envio confere o bloqueio, e
 * quem tira um número do contato revoga o que dependia dele. Funções sobre o
 * client recebido, sem módulo: o `ConsentsModule` depende do canal (cancela os
 * despachos), e o canal e os contatos não podem depender dele de volta.
 */

/** A recusa sob o pedido de parar, a mesma no compositor, no envio e no worker. */
export const MENSAGEM_PEDIDO_DE_PARAR =
  'A pessoa pediu para não receber mensagens deste número. Nada é enviado enquanto o pedido estiver ativo.';

/**
 * O pedido de parar ATIVO para o número, no workspace do client (C16: todos os
 * canais, qualquer contato). Só a forma exata "+dígitos": sem aproximação.
 */
export async function bloqueioAtivo(db: Db, numero: string | null): Promise<{ id: string } | null> {
  if (!numero) return null;
  return db.stopBlock.findFirst({
    where: { number: numero, activeMark: true },
    select: { id: true },
  });
}

export type PrefixoDoRecibo = 'CON' | 'PAR' | 'DES';

/**
 * O recibo, emitido na transação do registro: um contador por workspace, o
 * mesmo para os três prefixos. Único por (workspace, recibo), sem reutilizar e
 * sem truncar depois de seis dígitos; SEM garantia de sequência contínua. A
 * linha do contador fica presa até o fim da transação — os registros do
 * workspace se enfileiram nela, sempre DEPOIS das travas consultivas.
 */
export async function emitirRecibo(tx: Db, prefixo: PrefixoDoRecibo): Promise<string> {
  await tx.consentReceiptCounter.createMany({ data: [{}], skipDuplicates: true } as never);
  const [linha] = await tx.consentReceiptCounter.updateManyAndReturn({
    data: { next: { increment: 1 } },
    select: { next: true },
  });
  return `${prefixo}-${(linha.next - 1n).toString().padStart(6, '0')}`;
}

/**
 * Revoga os consentimentos ATIVOS do contato cujos números deixaram de ser
 * exatos dele (`number_removed`). Roda na transação de quem tirou o número, já
 * com o contato e o `address:` do número que saiu exclusivos — os mesmos que
 * conceder pega: um consentimento não fica ativo para um número que o contato
 * não tem mais. Devolve quantos revogou.
 */
export async function revogarNumerosQueSairam(
  tx: Db,
  audit: AuditService,
  auth: AuthContext,
  contactId: string,
  ficam: readonly string[],
): Promise<number> {
  const revogados = await tx.consent.updateManyAndReturn({
    where: { contactId, activeMark: true, number: { notIn: [...ficam] } },
    data: {
      revokedByMembershipId: auth.membershipId,
      revocationReason: 'number_removed',
      activeMark: null,
    },
    select: { id: true, receipt: true },
  });
  for (const consentimento of revogados) {
    await audit.record(tx, auth.workspaceId as string, 'consent.revoked', {
      entityType: 'consent',
      entityId: consentimento.id,
      actor: audit.actorFrom(auth),
      after: { receipt: consentimento.receipt, revocationReason: 'number_removed' },
    });
  }
  return revogados.length;
}

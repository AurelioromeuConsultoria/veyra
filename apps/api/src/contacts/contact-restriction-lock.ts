import type { Db } from '../prisma/prisma.service';

/**
 * TRAVA as linhas dos contatos, dentro da transação do chamador, para
 * serializar MUDANÇAS DE RESTRIÇÃO de conteúdo com APROVAÇÕES de propostas da
 * IA sobre o mesmo contato (ADR-047 adendo 5). Quem muda a restrição trava
 * antes de escrever; quem aprova trava antes do claim e só então reconfere a
 * porta. Se a mudança comitar primeiro, a aprovação — que esperava a trava —
 * vê o novo estado e recusa.
 *
 * Mesmo mecanismo de `ContactsService.lockAndRead` (toca `updatedAt`). Em ORDEM
 * de id, para duas transações com os mesmos contatos não se bloquearem em
 * cruz. `null` e contato que não existe mais são ignorados: a porta trata id
 * desconhecido como restrito. Função pura do domínio de contatos, sem injeção:
 * o Core e as extensões a usam sem ciclo de módulos. Devolve os ids travados.
 *
 * O `workspaceId` vai EXPLÍCITO no filtro: o tipo `Db` é o mesmo para o client
 * protegido e o `raw`, e a trava nunca pode tocar contato de outro workspace,
 * qualquer que seja a transação recebida.
 */
export async function lockContactsForRestriction(
  tx: Db,
  workspaceId: string,
  contactIds: readonly (string | null | undefined)[],
): Promise<string[]> {
  const ids = [...new Set(contactIds.filter((id): id is string => typeof id === 'string'))].sort();
  const travados: string[] = [];
  for (const id of ids) {
    const { count } = await tx.contact.updateMany({
      where: { id, workspaceId },
      data: { updatedAt: new Date() },
    });
    if (count > 0) travados.push(id);
  }
  return travados;
}

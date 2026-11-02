import type { Prisma } from '../generated/prisma/client';

/**
 * A trava dos membros de um workspace (advisory lock transacional). Pegam-na a
 * troca de papel, a remoção, a criação, a revogação e o aceite de convite — e a
 * ativação e a desativação de uma extensão, que tiram e devolvem as chaves dos
 * papéis dela (ADR-056 adendo 1): nenhuma atribuição corre no meio delas. O que
 * se lê depois da trava já vê o que essas operações confirmaram.
 *
 * Na ordem global das travas, a ativação a pega depois do nível 1 e da marcação
 * dos usos órfãos do workspace, e antes das linhas de papel, permissão,
 * membership e configuração. Não há ciclo porque os caminhos dos membros nunca
 * tocam uso de conteúdo, reserva, run nem trava de restrição (teste estático).
 */
export async function lockWorkspaceMembers(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    'veyra_members',
    workspaceId,
  );
}

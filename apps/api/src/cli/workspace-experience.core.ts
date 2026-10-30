import type { AuditService } from '../audit/audit.service';
import type { ExperienceService } from '../extensions/experience';
import type { PrismaService } from '../prisma/prisma.service';

/** Recusa da troca: a mensagem é a do procedimento, sem dado de ninguém. */
export class RecusaDaTroca extends Error {}

export interface DependenciasDaTroca {
  prisma: PrismaService;
  audit: AuditService;
  experiencias: ExperienceService;
}

/**
 * A troca da experiência de um workspace pela OPERAÇÃO (ADR-055 adendo 1,
 * item 6). Recusa a chave desconhecida, a experiência que a composição declara
 * NÃO selecionável (a de uma extensão cujo frontend ainda não existe) e a
 * indisponível no workspace. A disponibilidade vale para o momento da
 * conferência: desativar a extensão depois deixa a experiência indisponível,
 * estado que a tela trata. A troca é condicional — ninguém mudou no meio — e
 * fica na trilha, só com a chave antes e depois. Pedir a que já está é
 * recusado: nada muda.
 *
 * raw justificado: rotina administrativa da CLI de operação; `Workspace` é a
 * raiz do tenant e fica fora do client filtrado (SECURITY §2).
 */
export async function trocarExperiencia(
  deps: DependenciasDaTroca,
  input: { slug: string; experiencia: string },
): Promise<{ workspaceId: string; antes: string; depois: string }> {
  const chave = input.experiencia;
  const declarada = deps.experiencias.declared(chave);
  if (!declarada) throw new RecusaDaTroca(`a experiência "${chave}" não existe na composição`);
  if (!declarada.selectable) {
    throw new RecusaDaTroca(`a experiência "${chave}" ainda não é selecionável pela operação`);
  }
  const workspace = await deps.prisma.raw.workspace.findFirst({
    where: { slug: input.slug },
    select: { id: true, experience: true },
  });
  if (!workspace) throw new RecusaDaTroca(`o workspace "${input.slug}" não existe`);
  if (workspace.experience === chave) {
    throw new RecusaDaTroca(
      `o workspace "${input.slug}" já está na experiência "${chave}"; nada mudou`,
    );
  }
  if ((await deps.experiencias.status(workspace.id, chave)) !== 'ready') {
    throw new RecusaDaTroca(
      `a experiência "${chave}" não está disponível no workspace "${input.slug}"`,
    );
  }
  return deps.prisma.raw.$transaction(async (tx) => {
    // condicional: outra troca no meio do caminho → recusa, sem trilha
    const { count } = await tx.workspace.updateMany({
      where: { id: workspace.id, experience: workspace.experience },
      data: { experience: chave },
    });
    if (count !== 1) throw new RecusaDaTroca('o workspace mudou durante a troca; repita');
    await deps.audit.record(tx, workspace.id, 'workspace.experience_changed', {
      entityType: 'workspace',
      entityId: workspace.id,
      actor: { type: 'system', id: 'cli:workspace-experience' },
      before: { experience: workspace.experience },
      after: { experience: chave },
    });
    return { workspaceId: workspace.id, antes: workspace.experience, depois: chave };
  });
}

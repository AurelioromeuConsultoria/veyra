import type { Db } from '../prisma/prisma.service';
import { COORDENACAO } from './coordination-sql';

/**
 * A PRIMITIVA ÚNICA de travas de restrição (ADR-047 adendo 6 §3.1–3.2; adendo
 * 7 §3.2). Travas consultivas de chave única de 64 bits, num espaço que não
 * colide com as travas de duas chaves de 32 bits do resto do sistema. Toda
 * aquisição passa por aqui, na ordem global, sem exceção:
 *
 * 1. workspace — compartilhada para usos, aprovações e mudanças por contato;
 *    exclusiva para mudanças do workspace inteiro;
 * 2. contatos, em ordem crescente de id, sem repetição — compartilhadas para
 *    usos e aprovações, exclusivas para mudanças;
 * 3. entidades que determinam a quem um conteúdo pertence ('deal:<id>',
 *    'task:<id>'), em ordem crescente — compartilhadas para usos, exclusivas
 *    para mudanças de titularidade.
 *
 * A trava PRÓPRIA DO USO fica fora da ordem: ninguém espera por ela, só a tenta
 * (inclusive a guarda que a cria).
 * Uma colisão de hash só causa espera a mais, nunca liberação indevida.
 */
export const CHAVE = {
  workspace: (workspaceId: string) => `veyra.restriction.ws:${workspaceId}`,
  // o workspace entra na chave: um id de outro tenant, por engano de um
  // consumidor, não disputa a trava de ninguém de fora
  contato: (workspaceId: string, contactId: string) =>
    `veyra.restriction.contact:${workspaceId}:${contactId}`,
  entidade: (workspaceId: string, entityKey: string) =>
    `veyra.restriction.entity:${workspaceId}:${entityKey}`,
  uso: (useId: string) => `veyra.content_use:${useId}`,
} as const;

export interface EscopoDeTravas {
  workspaceId: string;
  contactIds?: readonly (string | null | undefined)[];
  /** 'deal:<id>' ou 'task:<id>' */
  entityKeys?: readonly string[];
}

type Coordenavel = Pick<Db, '$executeRaw' | '$queryRaw'>;

function ordenados(valores: readonly (string | null | undefined)[] | undefined): string[] {
  return [...new Set((valores ?? []).filter((v): v is string => typeof v === 'string'))].sort();
}

/** Prazo de espera pelas travas desta transação (`lock_timeout`, local). */
export async function prazoDeTrava(tx: Coordenavel, ms: number): Promise<void> {
  await tx.$executeRaw(COORDENACAO.prazoDeTrava(`${Math.max(0, Math.round(ms))}ms`));
}

/** Uso e aprovação: tudo compartilhado, na ordem. */
export async function travarParaUso(tx: Coordenavel, escopo: EscopoDeTravas): Promise<void> {
  await tx.$executeRaw(COORDENACAO.travaCompartilhada(CHAVE.workspace(escopo.workspaceId)));
  for (const id of ordenados(escopo.contactIds)) {
    await tx.$executeRaw(COORDENACAO.travaCompartilhada(CHAVE.contato(escopo.workspaceId, id)));
  }
  for (const chave of ordenados(escopo.entityKeys)) {
    await tx.$executeRaw(COORDENACAO.travaCompartilhada(CHAVE.entidade(escopo.workspaceId, chave)));
  }
}

/** Mudança por contato ou de titularidade: workspace compartilhada, o resto exclusivo. */
export async function travarParaMudanca(tx: Coordenavel, escopo: EscopoDeTravas): Promise<void> {
  await tx.$executeRaw(COORDENACAO.travaCompartilhada(CHAVE.workspace(escopo.workspaceId)));
  for (const id of ordenados(escopo.contactIds)) {
    await tx.$executeRaw(COORDENACAO.travaExclusiva(CHAVE.contato(escopo.workspaceId, id)));
  }
  for (const chave of ordenados(escopo.entityKeys)) {
    await tx.$executeRaw(COORDENACAO.travaExclusiva(CHAVE.entidade(escopo.workspaceId, chave)));
  }
}

/** Mudança do workspace inteiro (ativar e desativar um vertical): exclusiva. */
export async function travarWorkspaceInteiro(tx: Coordenavel, workspaceId: string): Promise<void> {
  await tx.$executeRaw(COORDENACAO.travaExclusiva(CHAVE.workspace(workspaceId)));
}

/** A trava própria do uso, só TENTADA. `true` = obtida. */
export async function tentarTravaDoUso(tx: Coordenavel, useId: string): Promise<boolean> {
  const [linha] = await tx.$queryRaw<{ obtida: boolean }[]>(
    COORDENACAO.tentarTravaExclusiva(CHAVE.uso(useId)),
  );
  return linha?.obtida === true;
}

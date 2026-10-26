/**
 * O núcleo do `phones:normalize` (ADR-052 item 1), separado do CLI para o
 * teste chamar sem subir a aplicação. O comentário do CLI explica o porquê de
 * cada regra; aqui fica o como.
 *
 * `raw` justificado: rotina administrativa CROSS-WORKSPACE (CLAUDE.md §3.3),
 * com o `workspaceId` explícito em cada leitura e escrita.
 */
import { derivadosDosTelefones, formaNormalizada } from '../contacts/phone-identity';
import type { PrismaService } from '../prisma/prisma.service';

const LOTE = 500;

type ContatoLido = {
  id: string;
  phones: string[];
  phonesNormalized: string[];
  phoneMatchKeys: string[];
};

/**
 * Grava as colunas derivadas SÓ SE os telefones ainda são os lidos — a
 * comparação vai na própria escrita. Um escritor de telefone concorrente já
 * gravou as colunas dos telefones novos; pôr de volta as do número antigo
 * deixaria a ingestão dele dar exata com quem já não o tem. `false` = pulado.
 */
export async function gravarSeOsTelefonesSaoOsLidos(
  prisma: PrismaService,
  workspaceId: string,
  lido: { id: string; phones: string[] },
  derivados: { phonesNormalized: string[]; phoneMatchKeys: string[] },
): Promise<boolean> {
  const { count } = await prisma.raw.contact.updateMany({
    where: { workspaceId, id: lido.id, phones: { equals: lido.phones } },
    data: derivados,
  });
  return count === 1;
}

export async function normalizarWorkspace(
  prisma: PrismaService,
  workspace: { id: string; phoneRegion: string },
): Promise<{ lidos: number; alterados: number; pulados: number; semForma: number }> {
  let lidos = 0;
  let alterados = 0;
  let pulados = 0;
  let semForma = 0;
  let cursor: string | undefined;
  for (;;) {
    const contatos: ContatoLido[] = await prisma.raw.contact.findMany({
      where: { workspaceId: workspace.id, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, phones: true, phonesNormalized: true, phoneMatchKeys: true },
      orderBy: { id: 'asc' },
      take: LOTE,
    });
    if (contatos.length === 0) break;
    for (const contato of contatos) {
      lidos += 1;
      const derivados = derivadosDosTelefones(contato.phones, workspace.phoneRegion);
      if (contato.phones.some((t) => formaNormalizada(t, workspace.phoneRegion) === null)) {
        semForma += 1;
      }
      const igual =
        JSON.stringify(derivados.phonesNormalized) === JSON.stringify(contato.phonesNormalized) &&
        JSON.stringify(derivados.phoneMatchKeys) === JSON.stringify(contato.phoneMatchKeys);
      if (igual) continue;
      if (await gravarSeOsTelefonesSaoOsLidos(prisma, workspace.id, contato, derivados)) {
        alterados += 1;
      } else {
        pulados += 1;
      }
    }
    cursor = contatos[contatos.length - 1].id;
  }
  return { lidos, alterados, pulados, semForma };
}

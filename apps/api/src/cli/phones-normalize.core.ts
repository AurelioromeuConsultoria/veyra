/**
 * O núcleo do `phones:normalize` (ADR-052 item 1; F4.1c-1), separado do CLI
 * para o teste chamar sem subir a aplicação. O comentário do CLI explica o
 * porquê de cada regra; aqui fica o como.
 *
 * `raw` justificado: rotina administrativa CROSS-WORKSPACE (CLAUDE.md §3.3),
 * com o `workspaceId` explícito em cada leitura e escrita.
 */
import type { AuditService } from '../audit/audit.service';
import { derivadosDosTelefones, formaNormalizada, numerosExatos } from '../contacts/phone-identity';
import type { TravasDeIdentidade } from '../content-use/identity-locks';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

const LOTE = 500;

type Cliente = Prisma.TransactionClient;

type ContatoLido = {
  id: string;
  phones: string[];
  phonesNormalized: string[];
  phoneMatchKeys: string[];
};

/**
 * Os prazos de um workspace: a espera pela trava dos escritores em massa (e
 * pelas linhas, com o mesmo `lock_timeout`), a transação inteira e a
 * ociosidade entre dois comandos — a CLI que cai ou perde a rede não segura a
 * trava exclusiva até o keepalive do TCP.
 */
export interface PrazosDaNormalizacao {
  travaMs: number;
  transacaoMs: number;
  ociosoMs?: number;
}
export const PRAZOS_DA_NORMALIZACAO: Required<PrazosDaNormalizacao> = {
  travaMs: 10_000,
  transacaoMs: 600_000,
  ociosoMs: 60_000,
};

export interface ResultadoDaNormalizacao {
  lidos: number;
  alterados: number;
  pulados: number;
  semForma: number;
  revogados: number;
}

/**
 * Grava as colunas derivadas SÓ SE os telefones ainda são os lidos — a
 * comparação vai na própria escrita. Com a trava dos escritores em massa
 * exclusiva, nenhum escritor de telefone corre junto; a comparação fica como
 * segunda camada. `false` = pulado.
 */
export async function gravarSeOsTelefonesSaoOsLidos(
  db: Cliente,
  workspaceId: string,
  lido: { id: string; phones: string[] },
  derivados: { phonesNormalized: string[]; phoneMatchKeys: string[] },
): Promise<boolean> {
  const { count } = await db.contact.updateMany({
    where: { workspaceId, id: lido.id, phones: { equals: lido.phones } },
    data: derivados,
  });
  return count === 1;
}

/**
 * Um workspace inteiro numa transação e numa conexão (F4.1c-1): a trava dos
 * escritores em massa EXCLUSIVA do começo ao fim, para nenhum leitor de
 * candidatos ver o conjunto parcialmente atualizado. Ela é a ÚNICA trava
 * consultiva: a CLI não espera outra segurando esta (as linhas, ela espera com
 * o mesmo `lock_timeout`). A atualização de cada contato e a revogação do
 * consentimento do número que não é exato (`number_removed`) vão juntas; a
 * falha — ou a trava que não vem no prazo — desfaz o workspace inteiro, e
 * rodar de novo retoma do começo.
 *
 * A revogação olha TODO contato do lote, não só os que mudam: o consentimento
 * ativo de um número que deixou de ser exato antes desta versão (a CLI antiga,
 * que não revogava) também sai. Rodar de novo, sem nada mudar, não revoga nada.
 */
export async function normalizarWorkspace(
  prisma: PrismaService,
  audit: AuditService,
  travas: TravasDeIdentidade,
  workspace: { id: string; phoneRegion: string },
  prazos: PrazosDaNormalizacao = PRAZOS_DA_NORMALIZACAO,
): Promise<ResultadoDaNormalizacao> {
  return prisma.raw.$transaction(
    async (tx) => {
      await travas.paraNormalizacao(
        tx,
        workspace.id,
        prazos.travaMs,
        prazos.ociosoMs ?? PRAZOS_DA_NORMALIZACAO.ociosoMs,
      );
      let lidos = 0;
      let alterados = 0;
      let pulados = 0;
      let semForma = 0;
      let revogados = 0;
      let cursor: string | undefined;
      for (;;) {
        const contatos: ContatoLido[] = await tx.contact.findMany({
          where: { workspaceId: workspace.id, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, phones: true, phonesNormalized: true, phoneMatchKeys: true },
          orderBy: { id: 'asc' },
          take: LOTE,
        });
        if (contatos.length === 0) break;
        // os números exatos de cada contato DEPOIS desta passada
        const exatosDepois = new Map<string, string[]>();
        for (const contato of contatos) {
          lidos += 1;
          const derivados = derivadosDosTelefones(contato.phones, workspace.phoneRegion);
          if (contato.phones.some((t) => formaNormalizada(t, workspace.phoneRegion) === null)) {
            semForma += 1;
          }
          const igual =
            JSON.stringify(derivados.phonesNormalized) ===
              JSON.stringify(contato.phonesNormalized) &&
            JSON.stringify(derivados.phoneMatchKeys) === JSON.stringify(contato.phoneMatchKeys);
          let formas = contato.phonesNormalized;
          if (!igual) {
            if (!(await gravarSeOsTelefonesSaoOsLidos(tx, workspace.id, contato, derivados))) {
              // os telefones lidos ficaram velhos: o contato pulado não decide
              // revogação nenhuma por eles, e a próxima passada o confere
              pulados += 1;
              continue;
            }
            alterados += 1;
            formas = derivados.phonesNormalized;
          }
          exatosDepois.set(
            contato.id,
            numerosExatos({ phones: contato.phones, phonesNormalized: formas }),
          );
        }
        // os consentimentos ativos do lote, numa consulta: só a apresentação
        // mudando, o número continua exato e nada é revogado; o que não é
        // exato leva o consentimento
        const ativos = await tx.consent.findMany({
          where: {
            workspaceId: workspace.id,
            contactId: { in: [...exatosDepois.keys()] },
            activeMark: true,
          },
          select: { id: true, contactId: true, number: true },
        });
        const foraDoConjunto = ativos
          .filter((c) => !(exatosDepois.get(c.contactId) ?? []).includes(c.number))
          .map((c) => c.id);
        if (foraDoConjunto.length > 0) {
          const revogadosAqui = await tx.consent.updateManyAndReturn({
            where: { workspaceId: workspace.id, id: { in: foraDoConjunto }, activeMark: true },
            data: { revocationReason: 'number_removed', activeMark: null },
            select: { id: true, receipt: true },
          });
          for (const consentimento of revogadosAqui) {
            await audit.record(tx, workspace.id, 'consent.revoked', {
              entityType: 'consent',
              entityId: consentimento.id,
              actor: { type: 'system', id: 'cli:phones-normalize' },
              after: { receipt: consentimento.receipt, revocationReason: 'number_removed' },
            });
          }
          revogados += revogadosAqui.length;
        }
        cursor = contatos[contatos.length - 1].id;
      }
      return { lidos, alterados, pulados, semForma, revogados };
    },
    { timeout: prazos.transacaoMs },
  );
}

/** Para onde a CLI escreve: as contagens, e o workspace que falhou. */
export interface SaidaDaNormalizacao {
  log(linha: string): void;
  erro(linha: string): void;
}

/**
 * Todos os workspaces, um de cada vez, cada um na sua transação. O que falha
 * é relatado só com o tipo e o código do erro — a mensagem de um erro do
 * Prisma traria valores, e entre eles números — e os outros seguem. Devolve
 * quantos falharam: a CLI sai com erro se algum falhou.
 */
export async function normalizarTodos(
  prisma: PrismaService,
  audit: AuditService,
  travas: TravasDeIdentidade,
  saida: SaidaDaNormalizacao,
  prazos: PrazosDaNormalizacao = PRAZOS_DA_NORMALIZACAO,
): Promise<number> {
  let falhas = 0;
  const workspaces = await prisma.raw.workspace.findMany({
    select: { id: true, slug: true, phoneRegion: true },
    orderBy: { slug: 'asc' },
  });
  for (const workspace of workspaces) {
    try {
      const { lidos, alterados, pulados, semForma, revogados } = await normalizarWorkspace(
        prisma,
        audit,
        travas,
        workspace,
        prazos,
      );
      saida.log(
        `${workspace.slug}: ${lidos} contatos lidos, ${alterados} atualizados, ${pulados} pulados (telefone mudou durante a leitura), ${semForma} com telefone que não se normaliza, ${revogados} consentimentos revogados (número que não é exato)`,
      );
    } catch (error) {
      falhas += 1;
      const { name, code } = (error ?? {}) as { name?: string; code?: string };
      saida.erro(
        `${workspace.slug}: NÃO normalizado (${name ?? 'Error'} ${code ?? 'sem código'}); nada mudou neste workspace, rodar de novo retoma`,
      );
    }
  }
  return falhas;
}

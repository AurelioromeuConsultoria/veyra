/**
 * CLI: diagnóstico SÓ DE LEITURA da identidade de quem escreve (ADR-052 item 1,
 * F4.1a). Roda ANTES da migration `20261023120000` — e depois também.
 *
 * USO: pnpm --filter @veyra/api identity:diagnose
 *
 * Conta, por workspace:
 * - os números compartilhados por mais de um contato, na forma normalizada;
 * - os contatos com telefone que não se normaliza;
 * - as conversas do WhatsApp sem `externalAddress`;
 * - as conversas e as mensagens com atribuição gravada (o legado da F4.1a);
 * - as linhas que VIOLARIAM o único novo "uma conversa aberta por (canal,
 *   contato, número)". Se houver, a migration falha inteira, e o tratamento é
 *   humano e explícito: nada é fundido, encerrado nem escolhido sozinho.
 *
 * Usa só colunas que já existiam antes da migration (SQL explícito; o client
 * gerado leria as novas) e normaliza em memória, com a mesma biblioteca da
 * aplicação. `raw` justificado: rotina administrativa cross-workspace
 * (CLAUDE.md §3.3), sem escrita. Imprime só CONTAGENS — nunca número nem nome.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { formaNormalizada, REGIAO_PADRAO } from '../contacts/phone-identity';
import { PrismaService } from '../prisma/prisma.service';

type Contagem = { n: bigint | number };
const numero = (linhas: Contagem[]): number => Number(linhas[0]?.n ?? 0);

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const workspaces = await prisma.raw.$queryRawUnsafe<{ id: string; slug: string }[]>(
      'SELECT "id", "slug" FROM "Workspace" ORDER BY "slug"',
    );
    for (const workspace of workspaces) {
      // a região: a coluna pode ainda não existir (antes da migration)
      const regiao =
        (
          await prisma.raw.$queryRawUnsafe<{ regiao: string | null }[]>(
            `SELECT to_jsonb(w) ->> 'phoneRegion' AS regiao FROM "Workspace" w WHERE w."id" = $1::uuid`,
            workspace.id,
          )
        )[0]?.regiao ?? REGIAO_PADRAO;
      const contatos = await prisma.raw.$queryRawUnsafe<{ id: string; phones: string[] }[]>(
        `SELECT "id", "phones" FROM "Contact" WHERE "workspaceId" = $1::uuid AND cardinality("phones") > 0`,
        workspace.id,
      );
      const donos = new Map<string, Set<string>>();
      let semForma = 0;
      for (const contato of contatos) {
        let algumSemForma = false;
        for (const telefone of contato.phones) {
          const forma = formaNormalizada(telefone, regiao);
          if (!forma) {
            algumSemForma = true;
            continue;
          }
          donos.set(forma, (donos.get(forma) ?? new Set()).add(contato.id));
        }
        if (algumSemForma) semForma += 1;
      }
      const compartilhados = [...donos.values()].filter((d) => d.size > 1).length;

      const semEndereco = numero(
        await prisma.raw.$queryRawUnsafe<Contagem[]>(
          `SELECT count(*) AS n FROM "Conversation" c JOIN "Channel" ch
             ON ch."workspaceId" = c."workspaceId" AND ch."id" = c."channelId"
           WHERE c."workspaceId" = $1::uuid AND ch."type" = 'whatsapp' AND c."externalAddress" IS NULL`,
          workspace.id,
        ),
      );
      const mensagensLegado = numero(
        await prisma.raw.$queryRawUnsafe<Contagem[]>(
          `SELECT count(*) AS n FROM "Message" WHERE "workspaceId" = $1::uuid AND "authorContactId" IS NOT NULL`,
          workspace.id,
        ),
      );
      const conversasLegado = numero(
        await prisma.raw.$queryRawUnsafe<Contagem[]>(
          `SELECT count(DISTINCT "conversationId") AS n FROM (
             SELECT "conversationId" FROM "Message"
              WHERE "workspaceId" = $1::uuid AND "authorContactId" IS NOT NULL
             UNION ALL
             SELECT "conversationId" FROM "Activity"
              WHERE "workspaceId" = $1::uuid AND "conversationId" IS NOT NULL AND "contactId" IS NOT NULL
           ) AS legado`,
          workspace.id,
        ),
      );
      const violacoes = numero(
        await prisma.raw.$queryRawUnsafe<Contagem[]>(
          `SELECT count(*) AS n FROM (
             SELECT 1 FROM "Conversation"
              WHERE "workspaceId" = $1::uuid AND "status" <> 'closed'
                AND "contactId" IS NOT NULL AND "externalAddress" IS NOT NULL
              GROUP BY "channelId", "contactId", "externalAddress"
             HAVING count(*) > 1
           ) AS duplicadas`,
          workspace.id,
        ),
      );
      console.log(
        [
          `${workspace.slug}:`,
          `${compartilhados} números compartilhados,`,
          `${semForma} contatos com telefone que não se normaliza,`,
          `${semEndereco} conversas do WhatsApp sem endereço,`,
          `${conversasLegado} conversas e ${mensagensLegado} mensagens com atribuição gravada,`,
          `${violacoes} grupos que violariam o único de conversa aberta`,
        ].join(' '),
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Diagnóstico falhou:', error?.message ?? error);
  process.exit(1);
});

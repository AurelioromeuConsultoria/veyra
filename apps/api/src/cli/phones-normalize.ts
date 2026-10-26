/**
 * CLI: preenche as colunas derivadas dos telefones (ADR-052 item 1, F4.1a).
 *
 * USO: pnpm --filter @veyra/api phones:normalize
 *
 * A migration `20261023120000` calculou as chaves de coincidência em SQL; as
 * FORMAS E.164 precisam da biblioteca, e saem daqui. Idempotente: recalcula
 * as duas colunas a partir de `phones` e só grava o contato cujo valor mudou.
 * Roda logo depois da migration, no procedimento de release. Até lá, o contato
 * sem forma normalizada conta como coincidência "possível" na ingestão — o
 * lado seguro, que leva a "remetente a identificar".
 *
 * `raw` justificado: é rotina administrativa CROSS-WORKSPACE (CLAUDE.md §3.3),
 * com o `workspaceId` explícito em cada escrita. Não pega trava: grava SÓ SE
 * os telefones ainda são os que leu (comparação na própria escrita). Um
 * escritor de telefone concorrente já gravou as colunas dos telefones novos,
 * e a CLI pula esse contato em vez de pôr de volta as do número antigo — o que
 * deixaria a ingestão do número antigo dar exata com quem já não o tem. A
 * corrida com a ingestão só pode dar RAI. Imprime só contagens — nunca número
 * nem nome.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { normalizarWorkspace } from './phones-normalize.core';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const workspaces = await prisma.raw.workspace.findMany({
      select: { id: true, slug: true, phoneRegion: true },
      orderBy: { slug: 'asc' },
    });
    for (const workspace of workspaces) {
      const { lidos, alterados, pulados, semForma } = await normalizarWorkspace(prisma, workspace);
      console.log(
        `${workspace.slug}: ${lidos} contatos lidos, ${alterados} atualizados, ${pulados} pulados (telefone mudou durante a leitura), ${semForma} com telefone que não se normaliza`,
      );
      if (pulados > 0) {
        console.log(
          `${workspace.slug}: o escritor concorrente já gravou as colunas; rodar de novo confere`,
        );
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Normalização falhou:', error?.message ?? error);
  process.exit(1);
});

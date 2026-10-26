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
 * com o `workspaceId` explícito em cada escrita.
 *
 * Desde a F4.1c-1 (ADR-052), ela é um ESCRITOR DE TELEFONE como os outros:
 * - cada workspace numa transação e numa conexão, com a trava dos escritores em
 *   massa EXCLUSIVA do começo ao fim — nenhum leitor de candidatos vê o
 *   conjunto parcialmente atualizado, e a CLI não espera outra trava segurando
 *   esta;
 * - o número que deixa de ser exato do contato revoga o consentimento dele
 *   (`number_removed`), na mesma transação da atualização; só mudar a
 *   apresentação do mesmo número não revoga. A revogação olha todo contato, não
 *   só os que mudam: o consentimento de um número que já não era exato (a CLI
 *   antiga não revogava) também sai;
 * - a transação tem prazo de ociosidade: a CLI que cai ou perde a rede não
 *   segura a trava exclusiva até o keepalive do TCP;
 * - sem a trava no prazo, ou com qualquer falha, o workspace inteiro é desfeito,
 *   relatado e pulado, e a CLI sai com erro; rodar de novo retoma.
 *
 * Imprime só contagens — nunca número nem nome.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuditService } from '../audit/audit.service';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { PrismaService } from '../prisma/prisma.service';
import { normalizarTodos } from './phones-normalize.core';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const falhas = await normalizarTodos(
      app.get(PrismaService),
      app.get(AuditService),
      app.get(TravasDeIdentidade),
      { log: (linha) => console.log(linha), erro: (linha) => console.error(linha) },
    );
    if (falhas > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Normalização falhou:', error?.message ?? error);
  process.exit(1);
});

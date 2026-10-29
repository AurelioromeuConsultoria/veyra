/**
 * CLI: cadastra e revisa os templates FICTÍCIOS da demonstração (ADR-048
 * adendo 12, item 2), só com o transporte e o catálogo falsos, num canal da
 * WABA fictícia.
 *
 * USO: pnpm --filter @veyra/api templates:demo --slug demo --channel <id> \
 *        --reviewer dono@empresa.com
 *
 * As finalidades vêm antes, pela CLI `consents:purpose`. A revisão fica em
 * nome do revisor, que precisa ter `templates:review`. Imprime só nomes,
 * versões e resultados — nunca o token nem o conteúdo do catálogo.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { cadastrarTemplatesDaDemonstracao, RecusaDoProcedimento } from './templates-demo.core';

const USO = 'Uso: templates:demo --slug slug --channel <id> --reviewer email';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const channelId = arg('channel');
  const revisor = arg('reviewer');
  if (!slug || !channelId || !revisor) {
    console.error(USO);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const linhas = await cadastrarTemplatesDaDemonstracao(app, { slug, channelId, revisor });
    for (const l of linhas) {
      if (l.ok) {
        console.log(
          `${l.template} em ${slug}: ${l.cadastro === 'registrada' ? 'versão nova' : 'sem mudança'} ${l.version}; ` +
            `${l.revisao === 'revisada' ? 'revisada' : 'já revisada'} para ${l.finalidade} v${l.finalidadeVersao}.`,
        );
      } else {
        console.error(`${l.template} em ${slug}: ${l.motivo}; nada foi gravado para ele.`);
        process.exitCode = 1;
      }
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // as recusas do procedimento e dos serviços não têm segredo; a de um erro do
  // Prisma traria valores, e dele só sai o tipo e o código
  if (error instanceof RecusaDoProcedimento || error instanceof HttpException) {
    console.error(`Procedimento recusado: ${error.message}`);
  } else {
    const { name, code } = (error ?? {}) as { name?: string; code?: string };
    console.error(`Procedimento falhou (${name ?? 'Error'} ${code ?? 'sem código'}).`);
  }
  process.exit(1);
});

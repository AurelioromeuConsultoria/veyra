/**
 * CLI: troca a experiência de produto de um workspace (ADR-055 adendo 1). É a
 * única porta para isso, e fica na trilha de auditoria.
 *
 * USO: pnpm --filter @veyra/api workspace:experience --slug demo --experience crm
 *
 * A experiência que a composição declara não selecionável é recusada. Ativar
 * uma extensão NÃO muda a experiência do workspace.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AuditService } from '../audit/audit.service';
import { ExperienceService } from '../extensions/experience';
import { PrismaService } from '../prisma/prisma.service';
import { RecusaDaTroca, trocarExperiencia } from './workspace-experience.core';

const USO = 'Uso: workspace:experience --slug slug --experience chave';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const experiencia = arg('experience');
  if (!slug || !experiencia) {
    console.error(USO);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const r = await trocarExperiencia(
      {
        prisma: app.get(PrismaService),
        audit: app.get(AuditService),
        experiencias: app.get(ExperienceService),
      },
      { slug, experiencia },
    );
    console.log(`${slug}: experiência ${r.antes} → ${r.depois} (registrado na auditoria).`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // a recusa do procedimento não tem segredo; de um erro do Prisma sai só o tipo
  if (error instanceof RecusaDaTroca) {
    console.error(`Procedimento recusado: ${error.message}`);
  } else {
    console.error(`Falha: ${(error as Error)?.name ?? 'erro'}`);
  }
  process.exit(1);
});

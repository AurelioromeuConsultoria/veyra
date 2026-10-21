/**
 * CLI de ATIVAÇÃO do Veyra Clinics (ADR-047 §4). Roda COMPILADA, como a de
 * provisionamento (dependências do Nest por tipo de construtor).
 *
 * USO:
 *   pnpm --filter @veyra/api clinics:enable --slug acme
 *   pnpm --filter @veyra/api clinics:disable --slug acme
 *
 * Reexecutar é seguro: o efeito depende do estado, não do número de execuções.
 * O corpo está em `clinics-command.ts`, exercitado pelo teste de integração;
 * aqui só se sobe o contexto e se imprime.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import '../../../cli/sem-jobs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { ClinicsActivationService } from '../clinics-activation.service';
import { CLINICS_USAGE, parseClinicsArgs, runClinicsCommand } from './clinics-command';

async function main(): Promise<void> {
  const command = parseClinicsArgs(process.argv.slice(2));
  if (!command) {
    console.error(CLINICS_USAGE);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    for (const line of await runClinicsCommand(app.get(ClinicsActivationService), command)) {
      console.log(line);
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // mensagem nossa (HttpException, Error de regra) é para o operador; erro do
  // Prisma carrega a invocação inteira, com ids — dele só o nome
  const message =
    error instanceof Error
      ? error.name.startsWith('Prisma')
        ? error.name
        : error.message
      : 'erro desconhecido';
  console.error('Ativação do Clinics falhou:', message);
  process.exit(1);
});

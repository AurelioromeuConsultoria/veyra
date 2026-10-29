/**
 * CLI: a carga da DEMONSTRAÇÃO (ADR-048 adendo 13). Dados fictícios num
 * workspace explícito, com o Clinics já ativo e o transporte simulado, pelos
 * serviços do domínio, em nome do ator.
 *
 * USO: pnpm --filter @veyra/api demo:carregar --slug demo --actor dono@empresa.com
 *      (na imagem: node dist/verticals/clinics/cli/demo-carregar.js …)
 *
 * Não ativa o Clinics, não cria consentimento e não revisa template. Rodar de
 * novo depois de uma carga completa não faz nada; depois de uma interrupção,
 * completa só o que falta, sem alterar o que existe. Imprime só contagens.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import '../../../cli/sem-jobs';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../../app.module';
import { carregarDemonstracao, RecusaDaCarga } from './demo-carregar.core';

const USO = 'Uso: demo:carregar --slug slug --actor email';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const ator = arg('actor');
  if (!slug || !ator) {
    console.error(USO);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const r = await carregarDemonstracao(app, { slug, ator });
    if (r.jaConcluida) {
      console.log(
        `A carga da demonstração em ${slug} já terminou em ${r.jaConcluida.toISOString()}: nada foi feito.`,
      );
      return;
    }
    const c = r.criados;
    console.log(
      `Carga da demonstração em ${slug}: ${c.servicos} serviço(s), ${c.profissionais} profissional(is), ` +
        `${c.contatos} contato(s), ${c.pacientes} paciente(s), ${c.agendamentos} agendamento(s) e ` +
        `${c.retornos} retorno(s) criados.`,
    );
    for (const p of r.pulados) console.log(`Pulado: ${p}.`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // a recusa e a mensagem de regra dos serviços não têm segredo; de um erro do
  // Prisma só o tipo e o código (ele traria valores)
  if (error instanceof RecusaDaCarga || error instanceof HttpException) {
    console.error(`Carga recusada: ${error.message}`);
  } else {
    const { name, code } = (error ?? {}) as { name?: string; code?: string };
    console.error(`Carga falhou (${name ?? 'Error'} ${code ?? 'sem código'}).`);
  }
  process.exit(1);
});

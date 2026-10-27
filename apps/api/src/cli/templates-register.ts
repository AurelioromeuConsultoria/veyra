/**
 * CLI: cadastra a VERSÃO de um template do WhatsApp, lida da Meta (ADR-052
 * item 4, F4.1c-2). A versão é imutável: mudou o conteúdo, a categoria ou um
 * vínculo, nasce outra, e as ativas anteriores do mesmo canal, nome e idioma
 * passam a divergentes. A mesma versão ativa, com o mesmo conteúdo, não muda
 * nada.
 *
 * USO: pnpm --filter @veyra/api templates:register --slug acme --channel <id> \
 *        --name lembrete_horario --language pt_BR --param body.1=contato.nome
 *
 * Cada `--param` liga um parâmetro (`header.1`, `body.1`, `body.nome`) a um
 * campo do catálogo do Core (hoje, só `contato.nome`). Imprime só o resultado
 * e o motivo — nunca o conteúdo, o token ou a resposta da Meta. Não abre envio.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TemplateVersionsService } from '../templates/template-versions.service';

const USO =
  'Uso: templates:register --slug slug --channel <id> --name nome --language pt_BR [--param body.1=contato.nome ...]';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function vinculos(): Record<string, string> | null {
  const pares: Record<string, string> = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== '--param') continue;
    const [chave, campo, ...resto] = (process.argv[i + 1] ?? '').split('=');
    if (!chave || !campo || resto.length > 0 || chave in pares) return null;
    pares[chave] = campo;
  }
  return pares;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const channelId = arg('channel');
  const name = arg('name');
  const language = arg('language');
  const params = vinculos();
  if (!slug || !channelId || !name || !language || !params) {
    console.error(USO);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const r = await app
      .get(TemplateVersionsService)
      .registrar(slug, { channelId, name, language, vinculos: params });
    switch (r.resultado) {
      case 'registrada':
      case 'sem_mudanca':
        console.log(
          `${name} (${language}) em ${slug}: ${r.resultado === 'registrada' ? 'versão nova' : 'sem mudança'} ${r.version} (${r.contentHash}).`,
        );
        break;
      case 'recusada':
        console.error(`${name} (${language}) em ${slug}: recusado (${r.motivo}).`);
        process.exitCode = 1;
        break;
      case 'falha':
        console.error(
          `${name} (${language}) em ${slug}: a Meta não respondeu (status ${r.status ?? '-'}, código ${r.metaCode ?? '-'}${r.rede ? ', rede' : ''}${r.motivo ? `, ${r.motivo}` : ''}); nada mudou.`,
        );
        process.exitCode = 1;
        break;
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // a mensagem das recusas do serviço (workspace inexistente, canal sem
  // credencial) não tem segredo; a de um erro do Prisma traria valores, e dele
  // só sai o tipo e o código
  if (error instanceof HttpException) {
    console.error(`Cadastro do template recusado: ${error.message}.`);
  } else {
    const { name, code } = (error ?? {}) as { name?: string; code?: string };
    console.error(`Cadastro do template falhou (${name ?? 'Error'} ${code ?? 'sem código'}).`);
  }
  process.exit(1);
});

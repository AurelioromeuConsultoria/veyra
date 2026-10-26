/**
 * CLI: cria a versão NOVA de uma finalidade de consentimento (ADR-052 item 5,
 * F4.1b). Finalidade é imutável: mudar a descrição ou os campos é criar outra
 * versão, e o consentimento continua ligado à versão que a pessoa aceitou.
 *
 * USO: pnpm --filter @veyra/api consents:purpose --slug acme --key lembrete \
 *        --category utility --description "Texto mostrado à pessoa" --fields nome,data
 *
 * O Core não cria finalidade nenhuma; o vertical traz as suas na F4.2.
 */
import 'dotenv/config';
// antes do AppModule: a CLI não abre workers nem reconciliação
import './sem-jobs';
import { NestFactory } from '@nestjs/core';
import { createConsentPurposeSchema } from '@veyra/contracts';
import { AppModule } from '../app.module';
import { ConsentPurposesService } from '../consents/consent-purposes.service';

const USO =
  'Uso: consents:purpose --slug slug --key chave --category utility|marketing --description "texto" [--fields a,b]';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const parsed = createConsentPurposeSchema.safeParse({
    key: arg('key'),
    category: arg('category'),
    description: arg('description'),
    fields: (arg('fields') ?? '').split(',').filter(Boolean),
  });
  if (!slug || !parsed.success) {
    console.error(USO);
    if (!parsed.success) console.error(parsed.error.issues.map((i) => i.message).join('; '));
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const purposes = app.get(ConsentPurposesService);
    const criada = await purposes.criarVersao(slug, parsed.data);
    console.log(
      `Finalidade ${parsed.data.key} versão ${criada.version} criada em ${slug} (${criada.purposeId}).`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Criação da finalidade falhou:', error?.message ?? error);
  process.exit(1);
});
